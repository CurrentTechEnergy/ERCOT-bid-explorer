"""Wind and solar curtailment priced at each unit's own node.  Needs no downloads.

For every wind and solar unit and hour of a 60-day day, curtailment is the hourly mean HSL
(what the unit could produce) minus the base point SCED gave it, from the per-unit day files
(UNIT_DATA_DIR/60d/).  Each curtailed unit-hour is priced at the unit's settlement point
(UNIT_DATA_DIR/nodes/, hourly resource-node prices) and sorted into:

  directed     an ERCOT operator manually lowered the unit's HDL in that hour (the
               disclosure's HDL/LDL Manual Override Summary, kept in the per-unit day file as
               "overrides"): curtailment up to the HDL reduction, averaged over the hour's
               runs, counts here before the price split below
  congestion   the node price is at least CONG_GAP $/MWh below system lambda: the unit is
               behind a binding constraint, so its energy was worth less (often far less,
               or negative) where it sits than at the system level
  oversupply   the node price is about system lambda: the system as a whole did not want
               the energy at the unit's offer price

The split is by price, so it says what the energy was worth where it sat, not which
constraint SCED was managing.  Units are matched to settlement points through the DAM
disclosure (the SCED file has no settlement point column); a unit with no match or no node
price that hour is priced at system lambda and counted as unmapped.

Writes data/curtail_nodes.json.gz:
  dates, has_nodes (per date: node prices present), gap
  daily[tech]   curt [MWh], directed, cong, over, unmapped (MWh), value ($ at the node:
                curtailed MWh x node price, negative when the price was negative), value_lam
                ($ at lambda).  directed is null on days whose per-unit file predates the
                override parsing (has_overrides says which days carry it)
  bins          edges, labels, [tech]: {mwh, uh} curtailed MWh and unit-hours by node price
  hours         columns / rows, one row per technology and hour with node prices:
                [date, hour, tech, lambda, curt, cong, over, node, directed]  node =
                MWh-weighted mean node price of the curtailed energy
  units         the most curtailed units over the days with node prices: [name, tech, sp,
                curt MWh, cong MWh, value $, mean node price when curtailed, available MWh,
                days with node prices, directed MWh]
  n_units[tech] {mapped, unmapped}
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .intraday import _online
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

CONG_GAP = 5.0          # $/MWh below lambda before a node price counts as congested
MIN_MW = 0.5            # ignore curtailment smaller than this in an hour (telemetry noise)
TECHS = ("wind", "solar")
BIN_EDGES = [-np.inf, -40, -20, -5, 0, 5, 10, 15, 20, 30, 50, 100, np.inf]
BIN_LABELS = ["< −$40", "−$40 to −20", "−$20 to −5", "−$5 to 0", "$0–5", "$5–10", "$10–15", "$15–20",
              "$20–30", "$30–50", "$50–100", "≥ $100"]
TOP_UNITS = 40


def _r(x, nd=0):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def hourly_hsl(u: dict, runs: list) -> np.ndarray:
    """Hourly mean HSL over the runs a unit was online, NaN in hours it was mostly off (the
    same hours intraday.unit_hours treats as running, without expanding the offer curves)."""
    n = len(runs)
    hr = np.minimum(np.array(runs) // 60, 23)
    si = _ffill_index(u["status"], n)
    on = np.array([i >= 0 and _online(u["status"][i][1]) for i in si])
    li = _ffill_index(u["lim"], n)
    hsl = np.array([u["lim"][i][1] if i >= 0 and u["lim"][i][1] is not None else np.nan for i in li], float)
    out = np.full(24, np.nan)
    for h in range(24):
        idx = hr == h
        if idx.any() and on[idx].mean() >= 0.5:
            out[h] = np.nanmean(hsl[idx & on]) if np.isfinite(hsl[idx & on]).any() else np.nan
    return out


def settlement_points(index: dict) -> dict:
    """{unit: settlement point} from the DAM day files, latest file winning."""
    sp = {}
    for d in sorted(index["days"].get("dam", [])):
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz")
        for name, u in ((dd or {}).get("units") or {}).items():
            if u.get("sp"):
                sp[name] = u["sp"]
    return sp


def build_node_curtail(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    node_days = set(index["days"].get("nodes", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    sp_of = settlement_points(index)
    daily = {t: {k: [] for k in ("curt", "directed", "cong", "over", "unmapped", "value", "value_lam")} for t in TECHS}
    has_overrides = []
    bins = {t: {"mwh": [0.0] * len(BIN_LABELS), "uh": [0] * len(BIN_LABELS)} for t in TECHS}
    rows, has_nodes = [], []
    units = {}         # name -> [tech, sp, curt, cong, value, priced MWh, avail, days]
    mapped = {t: set() for t in TECHS}
    unmapped = {t: set() for t in TECHS}

    for d in dates:
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        nodes = (read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("points") if d in node_days else None
        has_nodes.append(bool(nodes))
        has_overrides.append(bool(ud) and "overrides" in ud)
        overrides = (ud or {}).get("overrides") or {}
        lam = (prices.get(d) or {}).get("lambda") or [None] * 24
        lam = np.array([np.nan if v is None else v for v in lam[:24]] + [np.nan] * (24 - len(lam[:24])), float)
        day = {t: np.zeros((7, 24)) for t in TECHS}      # curt, cong, over, unmapped, value, value_lam, directed
        node_wsum = {t: np.zeros(24) for t in TECHS}       # sum of node price x curtailed MWh
        if not ud:
            for t in TECHS:
                for k in daily[t]:
                    daily[t][k].append(None)
            continue
        runs = ud["runs"]
        runs_h = np.bincount(np.minimum(np.array(runs) // 60, 23), minlength=24) if runs else np.zeros(24, int)
        for name, u in ud["units"].items():
            t = u.get("tech")
            if t not in TECHS or not u.get("bp"):
                continue
            hsl = hourly_hsl(u, runs)
            # operator-directed limit: HDL reduction per override run, averaged over the hour's runs
            directed_cap = np.zeros(24)
            for row in overrides.get(name, []):
                m, orig, fin = row[0], row[1], row[3]
                if m < 1440 and orig is not None and fin is not None and fin < orig and runs_h[m // 60]:
                    directed_cap[m // 60] += (orig - fin) / runs_h[m // 60]
            bp = np.array([np.nan if v is None else v for v in u["bp"]], float)
            curt = hsl - bp
            curt[~np.isfinite(curt) | (curt < MIN_MW)] = 0.0
            avail = np.where(np.isfinite(hsl), hsl, 0.0)
            sp = sp_of.get(name)
            np_ = nodes.get(sp) if nodes and sp else None
            node = np.array([np.nan if v is None else v for v in np_], float) if np_ else np.full(24, np.nan)
            # the unit table covers only days with node prices, so its shares are comparable
            rec = units.setdefault(name, [t, sp, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0]) if nodes else None
            if nodes:
                rec[6] += float(np.nansum(avail))
                rec[7] += 1
                (mapped if np_ else unmapped)[t].add(name)
            for h in range(24):
                c = curt[h]
                if c <= 0:
                    continue
                day[t][0, h] += c
                dirc = min(c, directed_cap[h])
                day[t][6, h] += dirc
                if not nodes:
                    continue
                rec[2] += c
                rec[8] += dirc
                c -= dirc                 # the rest is split by price
                p, l = node[h], lam[h]
                if not np.isfinite(p):
                    day[t][3, h] += c
                    p = l
                if not np.isfinite(p):
                    continue
                is_cong = np.isfinite(l) and p <= l - CONG_GAP
                day[t][1 if is_cong else 2, h] += c
                day[t][4, h] += (c + dirc) * p
                if np.isfinite(l):
                    day[t][5, h] += (c + dirc) * l
                node_wsum[t][h] += (c + dirc) * p
                rec[3] += c if is_cong else 0.0
                rec[4] += (c + dirc) * p
                rec[5] += c + dirc
                if c > 0:
                    b = int(np.searchsorted(BIN_EDGES, p, side="right")) - 1
                    bins[t]["mwh"][b] += c
                    bins[t]["uh"][b] += 1
        for t in TECHS:
            a = day[t]
            daily[t]["curt"].append(_r(a[0].sum()))
            daily[t]["directed"].append(_r(a[6].sum()) if has_overrides[-1] else None)
            for i, k in enumerate(("cong", "over", "unmapped", "value", "value_lam"), 1):
                daily[t][k].append(_r(a[i].sum()) if nodes else None)
            if nodes:
                for h in range(24):
                    if a[0, h] > 0 and np.isfinite(lam[h]):
                        priced = a[1, h] + a[2, h] + a[6, h]
                        rows.append([d, h, t, _r(lam[h], 2), _r(a[0, h]), _r(a[1, h]), _r(a[2, h]),
                                     _r(node_wsum[t][h] / priced, 2) if priced > 0 else None, _r(a[6, h])])

    top = sorted(units.items(), key=lambda kv: -kv[1][2])[:TOP_UNITS]
    out_units = [[name, r[0], r[1], _r(r[2]), _r(r[3]), _r(r[4]), _r(r[4] / r[5], 2) if r[5] > 0 else None,
                  _r(r[6]), r[7], _r(r[8])] for name, r in top]
    write_json_gz(DATA_DIR / "curtail_nodes.json.gz", {
        "dates": dates, "has_nodes": has_nodes, "has_overrides": has_overrides, "gap": CONG_GAP, "min_mw": MIN_MW,
        "daily": daily,
        "bins": {"edges": [None if not np.isfinite(e) else e for e in BIN_EDGES], "labels": BIN_LABELS,
                 **{t: {"mwh": [round(v) for v in bins[t]["mwh"]], "uh": bins[t]["uh"]} for t in TECHS}},
        "hours": {"columns": ["date", "hour", "tech", "lambda", "curt", "cong", "over", "node", "directed"], "rows": rows},
        "units": out_units,
        "n_units": {t: {"mapped": len(mapped[t]), "unmapped": len(unmapped[t] - mapped[t])} for t in TECHS},
    })
    n_nodes = sum(has_nodes)
    tot = {t: sum(v for v in daily[t]["curt"] if v) / 1000 for t in TECHS}
    print(f"curtail_nodes: {len(dates)} days, {n_nodes} with node prices, {sum(has_overrides)} with override data, "
          + ", ".join(f"{t} {tot[t]:,.0f} GWh" for t in TECHS)
          + f", {sum(len(mapped[t]) for t in TECHS)} units matched to nodes, "
          f"{sum(len(unmapped[t] - mapped[t]) for t in TECHS)} unmatched")
