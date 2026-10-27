"""The goal page (site/goal.html): will fossil units turn off as renewables and batteries grow?
Four questions, each answered by year from Jan 2019, from the 60-day data alone (the `history`
release's monthly files, pipeline/history.py, and for months it does not hold yet, the same rows
built from the 60-day day files, pipeline/decision_table.month_file):

  1. What turns off?  Each coal, combined-cycle and gas steam unit's group (_group: from its off
     spells over the year, or for a part year the 365 days to its end), its capacity (95th
     percentile HSL online), and the minimum output it took offline in cheap hours (offline, and
     online at some hour in the 24 before, inside one of its off spells, at its median LSL online).
  2. Why does the rest stay on?  Fossil minimum output online in cheap hours, by reason, the
     first that applies (REASONS): coal; never off (its group that year); held by its award (a DAM
     energy award of at least AWARD_LSL x its running LSL that hour); rode through (the
     operator-informed model, pipeline/models/operator_informed.py, also called it on); turned
     down against the model (the model called it off); no model call (no day file).
  3. Is behaviour changing?  The stay-on rule fitted on each year's loss windows (decision table,
     pipeline/decision_table.py; rule, pipeline/decision_rule.py, no-award variant), and the change
     in the CC and gas steam off rate split into triggers (the losses changed) and behaviour (the
     rule changed), each year against 2019 and against the year before; and where the loss
     windows fall (overnight or midday).
  4. Where do fossil decisions slow decarbonization?  Wind and solar curtailment (HSL above base
     point), the part in oversupply hours (real-time hub average at OVER_PRICE or less) at units not
     behind congestion (DA node within CONGESTED of the DA bus average), and the fossil minimum
     online in those hours by the same reasons, with how much of that curtailment shutting each
     group would have freed (hour by hour, the smaller of the two).

"Cheap" is a day-ahead hub average (HB_HUBAVG) of CHEAP $/MWh or less, as on the Commitment
scorecard.  Writes data/goal.json.gz (format in build()).  Run monthly by the Goal page workflow
(.github/workflows/goal.yml): about 30 minutes, most of it the decision table.

    python -m pipeline.goal [--cache goal-cache]
"""
import argparse
import datetime as dt
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR, UNIT_DATA_DIR
from .decision_table import _months, month_file
from .intraday import train_of
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "goal.json.gz"
VERSION = "v1"
START = "2019-01"
CHEAP = 10.0          # $/MWh, day-ahead hub average: a cheap hour
OVER_PRICE = 5.0      # $/MWh, real-time hub average: an oversupply hour
CONGESTED = 5.0       # $/MWh: a unit's DA node this far below the DA bus average is behind congestion
CURT_MIN = 0.5        # MW: smaller unit-hour curtailment is noise
OVER_CURT_MIN = 100.0  # MW of uncongested curtailment for an oversupply hour to count in the fossil split
AWARD_LSL = 0.9
OUT_MIN_H = 4         # offline hours an off spell needs (pipeline.forecast.groups)
FOSSIL = ("coal", "combined_cycle", "gas_steam")
REASONS = ("coal", "never off", "held by its award", "rode through", "against the model", "no model call")
SCENARIOS = (("against the model", ("against the model",)),
             ("all CC and gas steam without an award", ("against the model", "rode through", "no model call")),
             ("those and coal", ("against the model", "rode through", "no model call", "coal")))
RANK = {"a": 4, "m": 3, "0": 2, "o": 1, "-": 0}
CODE = np.array(sorted(RANK, key=RANK.get))


# ------------------------------------------------------------------ inputs --
def _hubs(month):
    """{(date, he): (DA hub average, DA bus average, RT hub average)} for the month."""
    out = defaultdict(lambda: [np.nan, np.nan, np.nan])
    p = HISTORY_DIR / f"da-hubs-{month}.parquet"
    if p.exists():
        h = pd.read_parquet(p)
        for col, pt in ((0, "HB_HUBAVG"), (1, "HB_BUSAVG")):
            for d, he, v in h[h["point"] == pt][["date", "he", "price"]].itertuples(index=False):
                out[(d, int(he))][col] = float(v)
    else:
        for d, v in (read_json_gz(DATA_DIR / "dam_hubs.json.gz", default={}) or {}).get("days", {}).items():
            if d[:7] == month:
                for col, pt in ((0, "HB_HUBAVG"), (1, "HB_BUSAVG")):
                    for h, x in enumerate((v.get(pt) or [])[:24]):
                        if x is not None:
                            out[(d, h + 1)][col] = float(x)
    p = HISTORY_DIR / f"rt-prices-{month}.parquet"
    if p.exists():
        r = pd.read_parquet(p, columns=["date", "he", "point", "price"])
        for d, he, v in r[r["point"] == "HB_HUBAVG"][["date", "he", "price"]].itertuples(index=False):
            out[(d, int(he))][2] = float(v)
    else:
        for f in sorted((DATA_DIR / "prices").glob(f"{month}-*.json.gz")):
            q = ((read_json_gz(f, default={}) or {}).get("spp15") or {}).get("HB_HUBAVG") or []
            d = f.name[:10]
            for h in range(min(24, len(q) // 4)):
                v = [x for x in q[h * 4:h * 4 + 4] if x is not None]
                if v:
                    out[(d, h + 1)][2] = float(np.mean(v))
    return out


def _operator(month):
    """{(date, train): [24] P(online)} from the operator day files of the month."""
    out = {}
    for f in sorted((DATA_DIR / "operator").glob(f"{month}-*.json.gz")):
        for k, u in ((read_json_gz(f, default={}) or {}).get("units") or {}).items():
            out[(f.name[:10], k)] = u.get("p")
    return out


def _train_hours(f):
    """Thermal unit-hours merged into trains (combined-cycle configurations): state by RANK,
    running LSL and HSL summed over the running configurations, award summed."""
    f = f[f["tech"].astype(str).isin(FOSSIL + ("combustion_turbine", "nuclear"))].copy()
    t = f["tech"].astype(str)
    f["train"] = np.where(t == "combined_cycle", f["unit"].astype(str).map(train_of), f["unit"].astype(str))
    f["tech"] = t
    st = f["state"].astype(str)
    f["r"] = st.map(RANK).fillna(0).astype(int)
    run = st.isin(["m", "a"])
    f["lsl_run"] = f["lsl"].where(run, 0.0).fillna(0.0)
    f["hsl_run"] = f["hsl"].where(run, 0.0).fillna(0.0)
    f["award"] = f["award"].fillna(0.0)
    f["out"] = f["out"].fillna(0.0)
    g = f.groupby(["train", "date", "he"], sort=True)
    h = g.agg(tech=("tech", "first"), r=("r", "max"), lsl=("lsl_run", "sum"), hsl=("hsl_run", "sum"),
              award=("award", "sum"), out=("out", "sum")).reset_index()
    h["state"] = CODE[h["r"].to_numpy()]
    return h.drop(columns="r")


def _renewables(u, hubs):
    """[(date, he, curtailed MW, of it uncongested, available MW)] for wind and solar."""
    u = u[u["tech"].astype(str).isin(["wind", "solar"])]
    curt = (u["hsl"] - u["bp"]).clip(lower=0).fillna(0.0)
    curt = curt.where(curt >= CURT_MIN, 0.0)
    bus = np.array([hubs[(d, int(he))][1] for d, he in zip(u["date"], u["he"])])
    free = curt.where((u["da_node"].to_numpy() - bus) > -CONGESTED, 0.0)
    r = pd.DataFrame({"date": u["date"].to_numpy(), "he": u["he"].astype(int).to_numpy(), "curt": curt.to_numpy(),
                      "free": free.to_numpy(), "avail": u["hsl"].fillna(0.0).to_numpy()})
    return r.groupby(["date", "he"]).sum().reset_index()


# --------------------------------------------------------------- groups --
def _group(seq):
    """A train's group over a year of hourly states, as the site's timescale groups
    (pipeline/forecast/groups.py): from its off spells (OUT_MIN_H offline hours or more after a
    running hour, not mostly outage), never off with none, seasonal when every one lasted a week or
    more, multi-day when the shortest lasted a day to a week, daily with two or more under a day,
    split by how many a week; None when it never ran.  Also the hours inside those spells."""
    run = np.isin(seq, ["m", "a"])
    inside = np.zeros(len(seq), bool)
    if not run.any():
        return None, inside
    spells, n, k = [], len(seq), 1
    while k < n:
        if not run[k] and run[k - 1]:
            j = k
            while j < n and not run[j]:
                j += 1
            seg = seq[k:j]
            off, out = int((seg == "0").sum()), int((seg == "o").sum())
            if seg[0] == "0" and off >= OUT_MIN_H and off >= out:
                spells.append(j - k)
                inside[k:j] = True
            k = j
        else:
            k += 1
    if not spells:
        return "never off", inside
    short = sum(1 for v in spells if v < 24)
    if short >= 2:
        week = short / (len(seq) / 168)
        return ("daily, over 2 a week" if week > 2 else "daily, 1 to 2 a week" if week >= 1 else "daily, under 1 a week"), inside
    return ("seasonal" if min(spells) >= 24 * 7 else "multi-day"), inside


GROUPS = ("daily, over 2 a week", "daily, 1 to 2 a week", "daily, under 1 a week", "multi-day", "seasonal", "never off")


# ---------------------------------------------------------------- build --
def _year(year, months, cache, before=None):
    """Questions 1, 2 and 4 for one calendar year; `before` is the year before's train states
    (train, date, he, state), so a part year's groups still read a full year of states."""
    th, ren, hubs, op = [], [], {}, {}
    for m in months:
        f = month_file("thermal", m, cache)
        if f is None:
            continue
        hb = _hubs(m)
        hubs.update(hb)
        th.append(_train_hours(f))
        u = month_file("units", m, cache)
        if u is not None:
            ren.append(_renewables(u, hb))
        op.update(_operator(m))
    if not th:
        return None
    h = pd.concat(th, ignore_index=True)
    h = h.sort_values(["train", "date", "he"]).reset_index(drop=True)
    key = list(zip(h["date"], h["he"]))
    h["da"] = [hubs.get(k, [np.nan] * 3)[0] for k in key]
    h["rt"] = [hubs.get(k, [np.nan] * 3)[2] for k in key]
    h["cheap"] = h["da"] <= CHEAP
    # each fossil train's group, capacity and typical minimum over the year
    info = {}
    span = h[h["tech"].isin(FOSSIL)][["train", "date", "he", "state"]]
    days = h["date"].nunique()
    if before is not None and days < 365:
        lo = (dt.date.fromisoformat(h["date"].min()) - dt.timedelta(days=365 - days)).isoformat()
        span = pd.concat([before[before["date"] >= lo], span], ignore_index=True)
    states = {tr: g["state"].to_numpy() for tr, g in span.groupby("train", sort=False)}
    inside = {}
    for tr, g in h[h["tech"].isin(FOSSIL)].groupby("train", sort=False):
        grp, ins = _group(states[tr])
        inside[tr] = ins[len(ins) - len(g):]          # this year's hours
        if grp is None:
            continue
        on = g[g["state"].isin(["m", "a"])]
        info[tr] = (g["tech"].iat[0], grp, float(on["hsl"].quantile(0.95)), float(on["lsl"].median()))
    h["group"] = h["train"].map(lambda t: info.get(t, (None, None))[1])
    # operator call and the reason a unit at minimum was on
    p = np.array([(lambda v: v[he - 1] if v and he <= len(v) and v[he - 1] is not None else np.nan)(op.get((d, t)))
                  for d, he, t in zip(h["date"], h["he"], h["train"])], float)
    atmin = (h["state"] == "m").to_numpy()
    tech = h["tech"].to_numpy()
    h["why"] = np.select(
        [tech == "coal", h["group"].to_numpy() == "never off", (h["award"] >= AWARD_LSL * h["lsl"]).to_numpy() & (h["lsl"] > 0).to_numpy(),
         p >= 0.5, p < 0.5],
        ["coal", "never off", "held by its award", "rode through", "against the model"], "no model call")
    h.loc[~np.isin(tech, FOSSIL), "why"] = h["tech"]
    # question 1: minimum taken offline in cheap hours, by the train's group
    q1 = defaultdict(float)
    for tr, g in h[h["train"].isin(info)].groupby("train", sort=False):
        st = g["state"].to_numpy()
        run = np.isin(st, ["m", "a"]).astype(int)
        recent = np.convolve(run, np.ones(24, int))[:len(run)]          # running hours in the 24 up to each hour
        prior = np.r_[0, recent[:-1]] > 0
        off = (st == "0") & prior & inside[tr] & g["cheap"].to_numpy()
        q1[tr] = float(off.sum()) * info[tr][3]
    cheap_hours = int(h.drop_duplicates(["date", "he"])["cheap"].sum())
    rows1 = defaultdict(lambda: [0, 0.0, 0.0])
    for tr, (t, grp, cap, lsl) in info.items():
        r = rows1[(t, grp)]
        r[0] += 1
        r[1] += cap if np.isfinite(cap) else 0.0
        r[2] += q1[tr]
    q1rows = [[year, t, grp, n, round(c), round(o)] for (t, grp), (n, c, o) in sorted(rows1.items())]
    # question 2: minimum online in cheap hours, by reason
    c = h[h["cheap"] & atmin]
    q2rows = [[year, t, w, round(float(v))] for (t, w), v in c.groupby(["tech", "why"])["lsl"].sum().items()]
    # question 4: curtailment, and fossil at minimum in oversupply hours
    q4 = None
    if ren:
        r = pd.concat(ren, ignore_index=True)
        r["rt"] = [hubs.get((d, int(he)), [np.nan] * 3)[2] for d, he in zip(r["date"], r["he"])]
        r["over"] = r["rt"] <= OVER_PRICE
        r["free"] = r["free"].where(r["over"], 0.0)
        oh = r[r["over"] & (r["free"] >= OVER_CURT_MIN)][["date", "he", "free"]]
        s = h[atmin].merge(oh[["date", "he"]], on=["date", "he"])
        nuc = h[(h["tech"] == "nuclear") & h["state"].isin(["m", "a"])].merge(oh[["date", "he"]], on=["date", "he"])
        by = s.groupby(["tech", "why"])["lsl"].sum()
        atm = [[year, t, w, round(float(v))] for (t, w), v in by.items() if t != "nuclear"]
        atm.append([year, "nuclear", "nuclear output", round(float(nuc["out"].sum()))])
        avoid = []
        for name, whys in SCENARIOS:
            mw = s[s["why"].isin(whys) & s["tech"].isin(FOSSIL)].groupby(["date", "he"])["lsl"].sum()
            j = oh.set_index(["date", "he"]).join(mw.rename("x")).fillna({"x": 0.0})
            avoid.append([year, name, round(float(np.minimum(j["free"], j["x"]).sum()))])
        mw = s[s["tech"].isin(FOSSIL + ("combustion_turbine",))].groupby(["date", "he"])["lsl"].sum()
        j = oh.set_index(["date", "he"]).join(mw.rename("x")).fillna({"x": 0.0})
        avoid.append([year, "all fossil at minimum", round(float(np.minimum(j["free"], j["x"]).sum()))])
        q4 = {"year": [year, round(float(r["avail"].sum())), round(float(r["curt"].sum())),
                       round(float(r["curt"].where(r["over"], 0.0).sum())), round(float(r["free"].sum())),
                       int(r["over"].sum()), len(oh), round(float(oh["free"].sum())), [round(float(v)) for v in
                       r[r["over"]].groupby("he")["free"].sum().reindex(range(1, 25), fill_value=0.0)]],
              "atmin": atm, "avoid": avoid}
    days = sorted(h["date"].unique())
    return {"q1": q1rows, "q2": q2rows, "q4": q4, "cheap_hours": cheap_hours, "from": days[0], "to": days[-1],
            "states": h[h["tech"].isin(FOSSIL)][["train", "date", "he", "state"]]}


def _rule(table):
    """Question 3: year-pair splits and where the loss windows fall, from the decision table."""
    from . import decision_rule as R
    x = table.copy()
    keep = R.Rule.features
    R.Rule.features = [f for f in R.FEATURES if f != "award"]
    try:
        xx, z, _, _ = R.load(x)
        dec = R.decompose(xx, z)
    finally:
        R.Rule.features = keep
    y0 = int(dec["a"].min())
    pairs = [[r.tech, int(r.a), int(r.b), int(r.trains), round(r.off_a, 4), round(r.off_b, 4), round(r.triggers, 4), round(r.behaviour, 4)]
             for r in dec.itertuples() if r.a == y0 or r.b == r.a + 1]
    x = x[x["tech"].isin(["combined_cycle", "gas_steam"])]
    he = (x["win_from"] - 1) % 24 + 1
    mix = []
    for (y, t), g in x.groupby(["year", "tech"]):
        h = he[g.index]
        mix.append([int(y), t, len(g), round(float((g["win_from"] >= 25).mean()), 4),
                    round(float(((h >= 9) & (h <= 17) & (g["win_from"] < 25)).mean()), 4),
                    round(float((g["on_share"] < 0.5).mean()), 4), round(float(g["loss_per_mw"].median()), 1)])
    return {"pairs": pairs, "mix": mix}


def build(cache: Path, end=None, table=None) -> dict:
    """data/goal.json.gz:
      {"version", "built", "through", "cheap", "over_price",
       "years": {year: {"from", "to", "cheap_hours"}},
       "q1": {"columns": [year, tech, group, trains, capacity_mw, off_mwh], "rows"},
       "q2": {"columns": [year, tech, reason, mwh], "rows", "reasons"},
       "q3": {"pairs": [[tech, from, to, trains, off_from, off_to, triggers, behaviour]],
              "mix": [[year, tech, windows, overnight, midday, off_rate, median_loss_per_mw]]},
       "q4": {"years": [[year, available_mwh, curtailed_mwh, in_oversupply_mwh, uncongested_mwh,
                         oversupply_hours, counted_hours, uncongested_in_counted_mwh, uncongested_by_he[24]]],
              "atmin": [[year, tech, reason, mwh]], "avoid": [[year, scenario, mwh]], "scenarios"}}
    MWh sums over the year's hours; the page divides by the hours for means."""
    end = end or max((p.name[:7] for p in (UNIT_DATA_DIR / "60d").glob("20*.json.gz")), default=None) \
        or max(p.stem[8:] for p in HISTORY_DIR.glob("thermal-*.parquet"))
    months = _months(START, end)
    out = {"version": VERSION, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "cheap": CHEAP, "over_price": OVER_PRICE, "years": {},
           "q1": {"columns": ["year", "tech", "group", "trains", "capacity_mw", "off_mwh"], "rows": [], "groups": list(GROUPS)},
           "q2": {"columns": ["year", "tech", "reason", "mwh"], "rows": [], "reasons": list(REASONS)},
           "q4": {"years": [], "atmin": [], "avoid": [], "scenarios": [s for s, _ in SCENARIOS] + ["all fossil at minimum"]}}
    before = None
    for y in sorted({m[:4] for m in months}):
        r = _year(int(y), [m for m in months if m[:4] == y], cache, before)
        if r is None:
            continue
        before = r["states"]
        print(f"goal: {y} {r['from']} to {r['to']}", flush=True)
        out["years"][y] = {"from": r["from"], "to": r["to"], "cheap_hours": r["cheap_hours"]}
        out["q1"]["rows"] += r["q1"]
        out["q2"]["rows"] += r["q2"]
        if r["q4"]:
            out["q4"]["years"].append(r["q4"]["year"])
            out["q4"]["atmin"] += r["q4"]["atmin"]
            out["q4"]["avoid"] += r["q4"]["avoid"]
        out["through"] = r["to"]
    if table is None:
        from .decision_table import build as build_table
        table = build_table(months, cache)
    out["q3"] = _rule(table)
    write_json_gz(PATH, out)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", default="goal-cache", help="folder for months built from the day files")
    ap.add_argument("--to", default=None, help="last month (default: the latest the 60-day day files cover)")
    ap.add_argument("--table", default=None, help="a decision table already built (parquet), to skip building it")
    a = ap.parse_args(argv)
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    out = build(cache, a.to, pd.read_parquet(a.table) if a.table else None)
    print(f"goal: written through {out.get('through')}")


if __name__ == "__main__":
    main()
