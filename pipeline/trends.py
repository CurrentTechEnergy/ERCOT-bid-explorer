"""Long-term trends from the 60-day data already in data/: hourly floor-priced MW and capacity
running by technology, starts per day, per-unit daily offer behaviour for thermal units, and
detected changes in each unit's bidding approach.  Needs no downloads.  Read by trends.html.

data/trends_hourly_60d.json.gz   {"dates", "floor", "run"}, every series [day][24] (MW, null where
                                 missing; a day with no thermal unit online is null throughout)
  floor[stat][tech]  stat:
                       le20_sced        MW at or below -$20 in the curve SCED dispatched against
                                        (the 60-day day file's hourly technology curves).  In the
                                        SCED2 curve, units that offer have the MW below their
                                        first offered point (usually minimum output) at -$20
                                        (-$50 for some); units with no offer curve sit at
                                        -$250/-$249.99 (nuclear, hydro) or at -$20/-$50 (other
                                        thermal), so this catches everything ERCOT prices at its
                                        floor values
                       floor_sced, floor_submitted   the 60-day summary's hourly stats
                       le0_sub_lsl      MW offered at or below $0 above LSL in the submitted
                                        curves, summed over the technology's units, averaged over
                                        the hour's runs (thermal only, from the per-unit files).
                                        Curves are read from LSL up because SCED cannot dispatch
                                        below it; a curve from 0 MW at -$250 up to HSL puts MW at
                                        or below $0 only by interpolation, below LSL
  run[tech]          thermal: "on" HSL of units online, "off" HSL of units offline but available

data/trends_60d.json.gz
  starts[tech]           thermal units' starts per day (status not starting "ON" -> starting "ON")
  has_units              per day, 1 when that day's per-unit file was read
  first_seen             {unit: [date, tech, date with an HSL, largest HSL]}: the first day each
                         unit (every technology) is in the per-unit files, i.e. in SCED (a new
                         unit is often listed with no HSL first), the first day it had an HSL
                         above 0 and its largest HSL; for the new-unit events (events.py)
  units[i]["first"]      first offer price above $0 at or above LSL, averaged over the day's online
                         runs (units.first_positive_price)
  units[i]["le0"]        share of the unit's dispatchable range (HSL - LSL) it offered at or below
                         $0, averaged over the day's online runs (units.le0_share)
  units[i]["noff"]       share of the day's online runs without an offer curve
  units[i]["le20"]       MW at or below -$20 in the curve SCED dispatched against, averaged over
                         the runs the unit was online that day (null when it never was); the page
                         spreads it over the hours the unit ran (unit_hours_60d)
  units[i]["rel"]        first minus the day's median for the unit's peer group; "peer" says which
                         group: 1 its resource type (PEER_MIN or more units with a price), 0 its
                         technology
  changes                sustained shifts in le0, noff or rel (detect_changes)
  flips                  thermal units whose submitted curve offered some MW at or below $0
                         above LSL in some online runs and none in others on the same day:
                         [unit, tech, date, n_switches, first_switch "HH:MM", hours_le0]
"""
import numpy as np

from .config import DATA_DIR, PRICE_GRID, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz
from .units import first_positive_price, le0_above_lsl, le20_sced_runs

# hourly MW at or near the floor (see the module docstring); le0_sub_lsl is thermal only
FLOOR_STATS = ["le20_sced", "floor_sced", "floor_submitted", "le0_sub_lsl"]
FLOOR_TECHS = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "hydro", "other"]
# hourly capacity (HSL) online and offline-but-available -> stat name in the 60-day summary
RUN_STATS = {"on": "hsl", "off": "hsl_off"}
# stat order of summaries written before they carried "stat_names"
LEGACY_STATS = ["n_online", "hsl", "lsl", "base_point", "output", "floor_sced", "floor_submitted",
                "le0_sced", "le0_submitted", "no_offer_hsl", "no_offer_output_schedule"]
FLIP_EPS = 0.005   # share of the dispatchable range at or below $0 that counts as offering there
UNIT_TECHS = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"]
# a unit's offer price is compared with the median of its own resource type (CCGT90, SCLE90, ...)
# on days when at least PEER_MIN units of that type have one, otherwise with its technology's
PEER_MIN = 8

# Bidding-approach changes. Each signal is compared between the K online days before and
# after a day; a change is a sustained shift larger than its threshold.
K = 7
SIGNALS = {
    # share of the dispatchable range (above LSL) the unit itself offered at or below $0
    "le0": {"thr": 0.25, "label": "MW above LSL offered at or below $0"},
    # share of the day running without an offer curve (held to its output schedule)
    "noff": {"thr": 0.5, "label": "Running without an offer curve"},
    # first offer price above $0 minus that day's median for its peer group: removes fuel-price moves
    "rel": {"thr": 10.0, "label": "Offer price vs peer median"},
}


def detect_changes(series):
    """series: {signal: [value or None per day]} for one unit. Returns
    [(day index, signal, before median, after median)], strongest first within K days."""
    days = sorted({i for v in series.values() for i, x in enumerate(v) if x is not None})
    found = []
    for sig, spec in SIGNALS.items():
        v = series[sig]
        idx = [i for i in days if v[i] is not None]
        best = []
        for n in range(K, len(idx) - K + 1):
            before = np.median([v[i] for i in idx[n - K:n]])
            after = np.median([v[i] for i in idx[n:n + K]])
            if abs(after - before) >= spec["thr"]:
                best.append((abs(after - before), idx[n], before, after))
        # keep the strongest point of each run of candidate days, at least K online days apart
        taken = []
        for score, i, b, a in sorted(best, reverse=True):
            if all(abs(days.index(i) - days.index(j)) >= K for j, *_ in taken):
                taken.append((i, b, a))
        found += [(i, sig, round(float(b), 3), round(float(a), 3)) for i, b, a in taken]
    return sorted(found)


def _online(s):
    return bool(s) and s.startswith("ON")


def unit_day_facts(ud: dict, prev_last: dict):
    """From one per-unit day file: starts per unit, each unit's last known status, flips, each
    thermal unit's first offer price above $0 at or above LSL (units.first_positive_price) and
    its share of the dispatchable range offered at or below $0, per technology and hour the MW
    offered at or below $0 above LSL (averaged over the hour's runs), and each thermal unit's MW
    at or below -$20 as used, averaged over the runs it was online (units.le20_sced_runs).
    prev_last: {unit: status} at the end of the previous day (empty if that day is missing);
    a start in the first run of the day counts only when it is known."""
    n = len(ud["runs"])
    hr = np.minimum(np.array(ud["runs"]) // 60, 23)
    starts, last, flips, pos, le0, tech_le0, le20 = {}, {}, [], {}, {}, {}, {}
    for name, u in ud["units"].items():
        seq = [s for _, s in u["status"] if s]      # skip absent runs (None) and blank statuses ("")
        cnt, prev = 0, prev_last.get(name)
        for s in seq:
            if prev is not None and not _online(prev) and _online(s):
                cnt += 1
            prev = s
        starts[name] = cnt
        if seq:
            last[name] = seq[-1]
        if u["tech"] not in UNIT_TECHS:
            continue
        pos[name] = first_positive_price(u, n)
        v = le20_sced_runs(u, n)
        if not np.isnan(v).all():
            le20[name] = round(float(np.nanmean(v)), 1)
        mw, rng = le0_above_lsl(u, n)
        tech_le0[u["tech"]] = tech_le0.get(u["tech"], np.zeros(n)) + np.nan_to_num(mw)
        with np.errstate(invalid="ignore", divide="ignore"):
            share = np.where(rng >= 1.0, mw / rng, np.nan)
        ok = ~np.isnan(share)
        if ok.any():
            le0[name] = round(float(np.mean(share[ok])), 3)
        if not (np.any(share[ok] > FLIP_EPS) and np.any(share[ok] <= FLIP_EPS)):
            continue
        state, n_sw, first_sw = None, 0, None
        for r in np.flatnonzero(ok):
            cur = "le0" if share[r] > FLIP_EPS else "gt0"
            if state is not None and cur != state:
                n_sw += 1
                if first_sw is None:
                    m = ud["runs"][r] % 1440
                    first_sw = f"{m // 60:02d}:{m % 60:02d}"
            state = cur
        hours = round(float(np.sum(share[ok] > FLIP_EPS)) * 24 / max(n, 1), 1)
        flips.append([name, u["tech"], ud["date"], n_sw, first_sw, hours])
    # per-run technology sums -> hourly means
    tech_le0 = {t: [round(float(v[hr == h].mean()), 1) if (hr == h).any() else None for h in range(24)]
                for t, v in tech_le0.items()}
    return starts, last, flips, pos, le0, tech_le0, le20


def _hour_rows(rows, j):
    """[24] values of column j from a technology's hourly rows (None where missing)."""
    out = []
    for h in range(24):
        r = rows[h] if h < len(rows) else None
        v = r[j] if r and j is not None and j < len(r) else None
        out.append(None if v is None else round(float(v)))
    return out


def build_trends(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    summ = read_json_gz(DATA_DIR / "summary_60d.json.gz", default={})

    # hourly series, [day][24] per technology
    floor = {k: {t: [] for t in (UNIT_TECHS if k == "le0_sub_lsl" else FLOOR_TECHS)} for k in FLOOR_STATS}
    run = {t: {k: [] for k in RUN_STATS} for t in UNIT_TECHS}
    starts_t = {t: [] for t in UNIT_TECHS}
    units = {}
    flips = []
    prev_date, prev_last = None, {}
    n_unit_days, has_units, empty = 0, [], []
    first_seen = {}
    for di, d in enumerate(dates):
        sd = summ.get(d) or {}
        st = sd.get("stats") or {}
        names = sd.get("stat_names") or LEGACY_STATS
        col = lambda nm: names.index(nm) if nm in names else None
        for k in ("floor_sced", "floor_submitted"):
            for t in floor[k]:
                floor[k][t].append(_hour_rows(st.get(t) or [], col(k)))
        for t in UNIT_TECHS:
            for k, nm in RUN_STATS.items():
                run[t][k].append(_hour_rows(st.get(t) or [], col(nm)))
        j = col("n_online")
        empty.append(not any(r and j is not None and j < len(r) and r[j] for t in UNIT_TECHS for r in st.get(t) or []))

        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if ud:
            n_unit_days += 1
            for nm, uu in ud["units"].items():
                fs = first_seen.setdefault(nm, [d, uu.get("tech"), None, 0])
                top = max((x[1] or 0 for x in uu.get("lim") or []), default=0)
                if top > 0:
                    fs[2] = fs[2] or d
                    fs[3] = max(fs[3], top)
            known = prev_last if prev_date and np.datetime64(prev_date) + 1 == np.datetime64(d) else {}
            starts, prev_last, fl, pos, le0, tech_le0, le20 = unit_day_facts(ud, known)
            prev_date = d
            flips += fl
            for t in UNIT_TECHS:
                starts_t[t].append(sum(c for nm, c in starts.items() if ud["units"][nm]["tech"] == t))
                floor["le0_sub_lsl"][t].append(tech_le0.get(t) or [0.0] * 24)
        else:
            pos, le0, le20 = {}, {}, {}
            for t in UNIT_TECHS:
                starts_t[t].append(None)
                floor["le0_sub_lsl"][t].append(None)
        has_units.append(1 if ud else 0)
        day = read_json_gz(DATA_DIR / "60d" / f"{d}.json.gz") or {}
        g = int(np.searchsorted(PRICE_GRID, -20.0))
        for t in FLOOR_TECHS:
            floor["le20_sced"][t].append(_hour_rows((day.get("curves") or {}).get(t) or [], g))
        u = day.get("units") or {"columns": [], "rows": []}
        C = {c: i for i, c in enumerate(u["columns"])}
        for r in u["rows"]:
            if r[C["tech"]] not in UNIT_TECHS:
                continue
            e = units.setdefault(r[C["unit"]], {"tech": r[C["tech"]], "type": r[C["type"]], "first": {},
                                                 "le0": {}, "noff": {}, "le20": {}})
            e["first"][di] = pos.get(r[C["unit"]])
            e["noff"][di] = r[C["no_offer_share"]]
            e["le0"][di] = le0.get(r[C["unit"]])
        # every thermal unit in the day file: MW at or below -$20 while it was online
        for name, v in le20.items():
            if name in units:
                units[name]["le20"][di] = v

    D = len(dates)
    # a day with no thermal unit online is a gap in the disclosure, not a real day
    for i in range(D):
        if empty[i]:
            for ser in [*(v for f in floor.values() for v in f.values()), *(v for r in run.values() for v in r.values())]:
                ser[i] = None
            for t in UNIT_TECHS:
                starts_t[t][i] = None
    # that day's median first offer price above $0 per resource type and per technology
    def _median(sel):
        return {i: float(np.median(p)) if (p := [e["first"][i] for e in units.values() if sel(e) and e["first"].get(i) is not None]) else None
                for i in range(D)}
    tech_med = {t: _median(lambda e, t=t: e["tech"] == t) for t in UNIT_TECHS}
    type_n = {}
    for e in units.values():
        for i, v in e["first"].items():
            if v is not None:
                type_n[(e["type"], i)] = type_n.get((e["type"], i), 0) + 1
    type_med = {ty: _median(lambda e, ty=ty: e["type"] == ty) for ty in {e["type"] for e in units.values()}}

    def peer(e, i):
        """(median, 1 if the unit's resource type, 0 if its technology)"""
        if type_n.get((e["type"], i), 0) >= PEER_MIN:
            return type_med[e["type"]][i], 1
        return tech_med[e["tech"]][i], 0
    unit_out, changes = [], []
    for name, e in sorted(units.items()):
        arr = lambda m: [m.get(i) for i in range(D)]
        pm = [peer(e, i) for i in range(D)]
        rel = [None if e["first"].get(i) is None or pm[i][0] is None
               else round(e["first"][i] - pm[i][0], 1) for i in range(D)]
        ch = detect_changes({"le0": arr(e["le0"]), "noff": arr(e["noff"]), "rel": rel})
        unit_out.append({"unit": name, "tech": e["tech"], "type": e["type"],
                         "first": arr(e["first"]), "rel": rel, "peer": [None if r is None else p[1] for r, p in zip(rel, pm)],
                         "le0": arr(e["le0"]), "noff": arr(e["noff"]), "n_changes": len(ch),
                         "le20": arr(e["le20"])})
        changes += [[name, e["tech"], dates[i], sig, b, a] for i, sig, b, a in ch]

    write_json_gz(DATA_DIR / "trends_hourly_60d.json.gz", {"dates": dates, "floor": floor, "run": run})
    write_json_gz(DATA_DIR / "trends_60d.json.gz", {
        "dates": dates, "starts": starts_t, "has_units": has_units, "first_seen": first_seen,
        "signals": {k: v["label"] for k, v in SIGNALS.items()}, "window": K, "units": unit_out,
        "changes": sorted(changes, key=lambda c: c[2]),
        "flips": sorted(flips, key=lambda f: (f[2], f[0])),
    })
    print(f"trends_60d / trends_hourly_60d: {D} days, {len(unit_out)} units, {len(changes)} bidding changes; "
          f"{n_unit_days} per-unit day file(s), {len(flips)} flips")
