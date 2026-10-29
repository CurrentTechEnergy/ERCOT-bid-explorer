"""The goal page (site/goal.html): will fossil units turn off as renewables and batteries grow?
Four questions, each answered by year from Jan 2019, from the 60-day data alone (the `history`
release's monthly files, pipeline/history.py, and for months it does not hold yet, the same rows
built from the 60-day day files, pipeline/decision_table.month_file):

  1. What turns off?  Fossil output against net load hour by hour (_floor): the floor it does not
     go below, and how much of it sits at minimum.  Also each coal, combined-cycle and gas steam
     unit's group (_group: from its off spells over the year, or for a part year the 365 days to its end), its capacity (95th
     percentile HSL online), and the minimum output it took offline in cheap hours (offline, and
     online at some hour in the 24 before, inside one of its off spells, at its median LSL online).
  2. Why does the rest stay on?  Fossil minimum output online in cheap hours and what it cost to
     stay on (_day_cost: gas cost at the unit's own hub, or coal's generic cost, less the real-time
     node price, times LSL; not the DAM minimum-energy offer), by reason, the
     first that applies (REASONS): coal; never off (its group that year); held by its award (a DAM
     energy award of at least AWARD_LSL x its running LSL that hour); rode through (the
     operator-informed model, pipeline/models/operator_informed.py, also called it on); turned
     down against the model (the model called it off); no model call (no day file).
  3. Is behaviour changing?  Of the CC and gas steam loss windows (decision table,
     pipeline/decision_table.py), the share each year the unit was off for most of the window,
     split by whether the window's loss beat a restart (its hot start offer, else the generic) and
     whether a DAM award held at least half its hours; and where the loss windows fall (overnight
     or midday).
  4. Where do fossil decisions slow decarbonization?  Wind and solar curtailment (HSL above base
     point), the part in oversupply hours (real-time hub average at OVER_PRICE or less) at units not
     behind congestion (DA node within CONGESTED of the DA bus average), and the fossil minimum
     online in those hours by whether each unit was losing money (ECON, _losing), with how much of
     that curtailment shutting each group would have let run (hour by hour, the smaller of the two).

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
VERSION = "v4"
START = "2019-01"
CHEAP = 10.0          # $/MWh, day-ahead hub average: a cheap hour
OVER_PRICE = 5.0      # $/MWh, real-time hub average: an oversupply hour
CONGESTED = 5.0       # $/MWh: a unit's DA node this far below the DA bus average is behind congestion
CURT_MIN = 0.5        # MW: smaller unit-hour curtailment is noise
OVER_CURT_MIN = 100.0  # MW of uncongested curtailment for an oversupply hour to count in the fossil split
AWARD_LSL = 0.9
MIDDAY = (8, 19)      # hours ending of the cheap midday stretch (question 2's award chart)
OUT_MIN_H = 4         # offline hours an off spell needs (pipeline.forecast.groups)
FOSSIL = ("coal", "combined_cycle", "gas_steam")
REASONS = ("coal", "never off", "held by its award", "rode through", "against the model", "no model call")
# question 4: a fossil unit at minimum in an hour of its day's loss window (decision table) is losing
# money; it loses more than a restart costs when the window's loss beats its hot start offer (the
# generic one when it submits none)
ECON = ("losing more than a restart", "losing, less than a restart", "covering its costs")
SCENARIOS = (("losing more than a restart", ECON[:1]), ("losing money", ECON[:2]))
# question 1's floor: hours binned by net load (load less the wind and solar available), GW
FLOOR_BIN, STUCK_BIN, MIN_BIN_HOURS = 2, 4, 10
FOSSIL_MIN = 1000.0   # MW: fossil has not run below this since 2019; an hour under it is a gap in the data
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


def _rt_nodes(month):
    """The month's real-time settlement point prices by hour: a DataFrame of sp, date, he, rt_node.
    The `history` release's rt-prices file, else the live node files (UNIT_DATA_DIR/nodes,
    from Nov 2025)."""
    p = HISTORY_DIR / f"rt-prices-{month}.parquet"
    if p.exists():
        r = pd.read_parquet(p, columns=["date", "he", "point", "price"])
        r = r.rename(columns={"point": "sp", "price": "rt_node"})
        r["sp"] = r["sp"].astype(str)
        r["he"] = r["he"].astype(int)
        return r
    from .parse_prices import node_hourly
    rows = []
    for f in sorted((UNIT_DATA_DIR / "nodes").glob(f"{month}-*.json.gz")):
        d = f.name[:10]
        for sp, v in node_hourly(read_json_gz(f, default=None)).items():
            rows += [(sp, d, h + 1, x) for h, x in enumerate(v[:24]) if x is not None]
    return pd.DataFrame(rows, columns=["sp", "date", "he", "rt_node"])


def _operator(month):
    """{(date, train): [24] P(online)} from the operator day files of the month."""
    out = {}
    for f in sorted((DATA_DIR / "operator").glob(f"{month}-*.json.gz")):
        for k, u in ((read_json_gz(f, default={}) or {}).get("units") or {}).items():
            out[(f.name[:10], k)] = u.get("p")
    return out


def _train_hours(f, rt=None):
    """Thermal unit-hours merged into trains (combined-cycle configurations): state by RANK,
    running LSL and HSL summed over the running configurations, award summed, the smallest
    minimum-energy offer and the mean DA and RT node prices (`rt`, _rt_nodes)."""
    f = f[f["tech"].astype(str).isin(FOSSIL + ("combustion_turbine", "nuclear"))].copy()
    f["sp"] = f["sp"].astype(str)
    f["he"] = f["he"].astype(int)
    f = f.merge(rt, on=["sp", "date", "he"], how="left") if rt is not None and len(rt) else f.assign(rt_node=np.nan)
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
              award=("award", "sum"), out=("out", "sum"), mingen=("mingen", "min"), da_node=("da_node", "mean"),
              rt_node=("rt_node", "mean")).reset_index()
    h["state"] = CODE[h["r"].to_numpy()]
    return h.drop(columns="r")


def _renewables(u, hubs):
    """[(date, he, curtailed MW, of it uncongested, available MW, output MW)] for wind and solar."""
    u = u[u["tech"].astype(str).isin(["wind", "solar"])]
    curt = (u["hsl"] - u["bp"]).clip(lower=0).fillna(0.0)
    curt = curt.where(curt >= CURT_MIN, 0.0)
    bus = np.array([hubs[(d, int(he))][1] for d, he in zip(u["date"], u["he"])])
    free = curt.where((u["da_node"].to_numpy() - bus) > -CONGESTED, 0.0)
    r = pd.DataFrame({"date": u["date"].to_numpy(), "he": u["he"].astype(int).to_numpy(), "curt": curt.to_numpy(),
                      "free": free.to_numpy(), "avail": u["hsl"].fillna(0.0).to_numpy(), "out": u["out"].fillna(0.0).to_numpy()})
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
def _losing(table):
    """{(train, date, he): ECON index} for the hours of each decision block's loss window."""
    from .config import GENERIC_COSTS
    start = table["hot_start"].fillna(table["tech"].map(lambda t: GENERIC_COSTS[t][0]))
    worth = (table["loss"] > start).to_numpy()
    out = {}
    for tr, d, f, n, w in zip(table["train"], table["date"], table["win_from"], table["win_h"], worth):
        d0 = dt.date.fromisoformat(str(d)[:10])
        for i in range(int(f), int(f) + int(n)):
            out[(tr, (d0 + dt.timedelta(days=(i - 1) // 24)).isoformat(), (i - 1) % 24 + 1)] = 0 if w else 1
    return out


def _day_cost(h, gas, hubs):
    """{(train, date): cost of running at minimum $/MWh} for the fossil trains, by the decision
    table's rule (pipeline/decision_table.run_cost): gas units at their gas cost at their own hub,
    coal at the generic cost.  Not the DAM minimum-energy offer."""
    from .decision_table import run_cost
    d = h.loc[h["tech"].isin(FOSSIL), ["train", "date", "tech"]].drop_duplicates(["train", "date"])
    return {(tr, dd): run_cost(t, tr, dd, gas, hubs)[0] for tr, dd, t in zip(d["train"], d["date"], d["tech"])}


def _floor(year, h, r):
    """Question 1: each hour's net load (thermal and wind and solar output less the wind and solar
    available, so the load the other units had to carry) and fossil output (coal, combined cycle,
    gas steam, combustion turbines), and fossil output split into minimum (the smaller of output
    and running LSL) and above it, by technology."""
    th = h.groupby(["date", "he"])["out"].sum()
    fos = h[h["tech"].isin(FOSSIL + ("combustion_turbine",))].copy()
    run = fos["state"].isin(["m", "a"]).to_numpy()
    fos["min"] = np.where(run, np.minimum(fos["out"], fos["lsl"]), 0.0)
    fos["above"] = (fos["out"] - fos["min"]).clip(lower=0.0)
    fo = fos.groupby(["date", "he"])["out"].sum()
    x = pd.concat([th.rename("thermal"), fo.rename("fossil")], axis=1).join(r.set_index(["date", "he"])[["out", "avail"]], how="inner")
    x["net"] = x["thermal"] + x["out"] - x["avail"]
    x = x[x["fossil"] >= FOSSIL_MIN].reset_index()      # an hour with almost no fossil is missing rows
    grid = x.assign(gx=np.floor(x["net"] / 1000).astype(int), gy=np.floor(x["fossil"] / 1000).astype(int)).groupby(["gx", "gy"]).size()
    sb = (np.floor(x["net"] / 1000 / STUCK_BIN) * STUCK_BIN).astype(int)
    st = fos.merge(x[["date", "he"]].assign(sb=sb), on=["date", "he"]).groupby(["sb", "tech"])[["min", "above"]].sum()
    return {"net": x["net"].to_numpy(), "fossil": x["fossil"].to_numpy(),
            "grid": [[year, int(a), int(b), int(n)] for (a, b), n in grid.items()],
            "stuck": [[year, int(b), t, round(float(v["min"])), round(float(v["above"]))] for (b, t), v in st.iterrows()],
            "hours": [[year, int(b), int(n)] for b, n in sb.value_counts().sort_index().items()]}


def _medians(net, fossil):
    """[[net load bin's lower edge GW, median fossil MW, hours]] by FLOOR_BIN GW of net load."""
    b = (np.floor(np.asarray(net) / 1000 / FLOOR_BIN) * FLOOR_BIN).astype(int)
    s = pd.Series(np.asarray(fossil)).groupby(b)
    return [[int(k), round(float(m)), int(n)] for (k, m), n in zip(s.median().items(), s.size()) if n >= MIN_BIN_HOURS]


def _year(year, months, cache, before=None, losing=None, gas=None):
    """Questions 1, 2 and 4 for one calendar year; `before` is the year before's train states
    (train, date, he, state), so a part year's groups still read a full year of states, and
    `losing` the loss-window hours (_losing) and `gas` (gas by hub and date, the unit hubs) for the
    cost of staying on."""
    th, ren, hubs, op = [], [], {}, {}
    for m in months:
        f = month_file("thermal", m, cache)
        if f is None:
            continue
        hb = _hubs(m)
        hubs.update(hb)
        th.append(_train_hours(f, _rt_nodes(m)))
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
    # question 2: minimum online in cheap hours, by reason, and what staying on cost: the day's
    # cost of running at minimum (_day_cost: gas cost, not the offer) less the real-time node
    # price, times the LSL (negative where the node paid more): a DAM award pays the same whether
    # or not the unit runs, so in every hour the choice is to generate or buy the energy back in
    # real time.  The DA node price stands in where the RT one is missing
    c = h[h["cheap"] & atmin].copy()
    dc = _day_cost(h, *(gas or ({}, {})))
    node = c["rt_node"].fillna(c["da_node"]).to_numpy()
    c["cost"] = (np.array([dc.get(k, np.nan) for k in zip(c["train"], c["date"])]) - node) * c["lsl"].to_numpy()
    q2rows = [[year, t, w, round(float(g["lsl"].sum())), round(float(g["cost"].sum()))] for (t, w), g in c.groupby(["tech", "why"])]
    # ... and by the same groups as the award chart, hour by hour: a DAM award over 0.5 MW that
    # hour; else self-committed (DAM resource status on) or neither (_status_for)
    status = _status_for(c["date"].unique())

    def grp(tr, d, he, aw):
        if aw > 0.5:
            return "award"
        sd = status[d]
        return "no award" if sd is None else "self" if tr in sd and sd[tr][he - 1] else "neither"
    c["grp"] = [grp(*k) for k in zip(c["train"], c["date"], c["he"], c["award"])]
    q2cost = [[year, t, k, round(float(g["lsl"].sum())), round(float(g["cost"].sum()))]
              for (t, k), g in c[c["tech"].isin(FOSSIL)].groupby(["tech", "grp"])]
    q2award = _award_stretches(year, h)
    # question 4: curtailment, and fossil at minimum in oversupply hours
    q4 = floor = None
    if ren:
        r = pd.concat(ren, ignore_index=True)
        floor = _floor(year, h, r)
        r["rt"] = [hubs.get((d, int(he)), [np.nan] * 3)[2] for d, he in zip(r["date"], r["he"])]
        r["over"] = r["rt"] <= OVER_PRICE
        r["free"] = r["free"].where(r["over"], 0.0)
        oh = r[r["over"] & (r["free"] >= OVER_CURT_MIN)][["date", "he", "free"]]
        s = h[atmin].merge(oh[["date", "he"]], on=["date", "he"])
        nuc = h[(h["tech"] == "nuclear") & h["state"].isin(["m", "a"])].merge(oh[["date", "he"]], on=["date", "he"])
        s["econ"] = [t if t not in FOSSIL else ECON[(losing or {}).get((tr, d, he), 2)]
                     for tr, d, he, t in zip(s["train"], s["date"], s["he"], s["tech"])]
        by = s.groupby(["tech", "econ"])["lsl"].sum()
        atm = [[year, t, w, round(float(v))] for (t, w), v in by.items() if t != "nuclear"]
        atm.append([year, "nuclear", "nuclear output", round(float(nuc["out"].sum()))])
        avoid = []
        for name, whys in SCENARIOS:
            mw = s[s["econ"].isin(whys)].groupby(["date", "he"])["lsl"].sum()
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
    return {"q1": q1rows, "q2": q2rows, "q2award": q2award, "q2cost": q2cost, "q4": q4, "floor": floor, "cheap_hours": cheap_hours, "from": days[0], "to": days[-1],
            "states": h[h["tech"].isin(FOSSIL)][["train", "date", "he", "state"]]}


def _award_stretches(year, h):
    """[[year, tech, group, stretches, stayed]]: coal, combined-cycle, gas steam and combustion
    turbine trains online in the hour before the day's
    day's first run of two or more cheap midday hours (MIDDAY), with no outage or missing hour in it, and
    whether they stayed online through all of it.  group: "award" (a DAM award over 0.5 MW in at
    least half the stretch's hours), "self" (no award, DAM resource status on at the first cheap
    hour), "neither", or "no award" where neither the DAM day file nor the history's dam-status
    file gives the status (_status_for)."""
    hours = h[["date", "he", "cheap"]].drop_duplicates(["date", "he"]).sort_values(["date", "he"]).reset_index(drop=True)
    idx = {k: i for i, k in enumerate(zip(hours["date"], hours["he"]))}
    runs = []
    for d, g in hours.groupby("date", sort=True):
        c = g.index[g["cheap"].to_numpy() & g["he"].between(*MIDDAY).to_numpy()]
        if len(c) and c[0] > 0:
            e = c[0] + 1
            while e in set(c):
                e += 1                  # the first run of cheap hours in a row
            if e - c[0] >= 2:
                runs.append((d, int(hours.at[c[0], "he"]), c[0], e))
    status = _status_for([r[0] for r in runs])
    out = defaultdict(lambda: [0, 0])
    techs = FOSSIL + ("combustion_turbine",)
    n = len(hours)
    for tr, g in h[h["tech"].isin(techs)].groupby("train", sort=False):
        tech = g["tech"].iat[0]
        st = np.full(n, "-", dtype=object)
        aw = np.zeros(n, bool)
        k = np.array([idx[x] for x in zip(g["date"], g["he"])])
        st[k] = g["state"].to_numpy()
        aw[k] = (g["award"] > 0.5).to_numpy()
        for d, he, a, b in runs:
            if st[a - 1] not in ("m", "a") or np.isin(st[a:b], ["o", "-"]).any():
                continue
            sd = status[d]
            grp = "award" if aw[a:b].mean() >= 0.5 else "no award" if sd is None else \
                "self" if tr in sd and sd[tr][he - 1] else "neither"
            r = out[(tech, grp)]
            r[0] += 1
            r[1] += int(not (st[a:b] == "0").any())
    return [[year, t, grp, n_, stayed] for (t, grp), (n_, stayed) in sorted(out.items())]


def _status_for(dates):
    """{date: {train: [24] DAM resource status on} or None}: the DAM day file (data/dam) where there
    is one, else the history's dam-status file for the month (pipeline/history.py --dam-status,
    from our own copies of the 60-day DAM disclosure), else None."""
    out, months = {}, {}
    for d in sorted(set(dates)):
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz", default=None)
        if dd:
            out[d] = _dam_status(dd)
            continue
        m = d[:7]
        if m not in months:
            p = HISTORY_DIR / f"dam-status-{m}.parquet"
            months[m] = _status_month(pd.read_parquet(p)) if p.exists() else {}
        out[d] = months[m].get(d)
    return out


def _status_month(st):
    """{date: {train: [24] on}} from a history dam-status file."""
    from .models.operator_informed import ON_STATUS
    st = st[st["tech"].astype(str).isin(FOSSIL + ("combustion_turbine",)) & st["he"].between(1, 24)]
    t, u = st["tech"].astype(str), st["unit"].astype(str)
    st = st.assign(train=np.where(t == "combined_cycle", u.map(train_of), u),
                   on=st["status"].astype(str).str.upper().isin(ON_STATUS))
    g = st.groupby(["date", "train", "he"])["on"].any()
    out = {}
    for (d, tr), v in g.groupby(level=[0, 1]):
        a = np.zeros(24, bool)
        a[v.index.get_level_values(2).to_numpy() - 1] = v.to_numpy()
        out.setdefault(str(d), {})[tr] = a
    return out


def _dam_status(dd):
    """{train: [24] True when any of its units' DAM resource status is on}, from a DAM day file."""
    from .models.operator_informed import ON_STATUS
    out = {}
    for name, u in dd.get("units", {}).items():
        t = u.get("tech")
        if t not in FOSSIL + ("combustion_turbine",):
            continue
        key = train_of(name) if t == "combined_cycle" else name
        sh = u.get("status_h") or [u.get("status") or ""] * 24
        on = np.array([str(x).upper() in ON_STATUS for x in (list(sh) + [""] * 24)[:24]])
        out[key] = out[key] | on if key in out else on
    return out


def _rule(table):
    """Question 3, from the decision table: how often units losing money turned off, and where the
    loss windows fall."""
    from .config import GENERIC_COSTS
    x = table[table["tech"].isin(["combined_cycle", "gas_steam"])].copy()
    start = x["hot_start"].fillna(x["tech"].map(lambda t: GENERIC_COSTS[t][0]))
    x["small"] = (x["loss"] <= start).astype(int)          # 0: losing more than a restart
    x["awarded"] = (x["award_share"] >= 0.5).astype(int)
    x["off"] = x["on_share"] < 0.5
    mwh = x["lsl"] * x["win_h"]                              # minimum output over the window
    x["on_mwh"], x["off_mwh"] = mwh * x["on_share"], mwh * (1 - x["on_share"])
    off = [[int(y), t, int(sm), int(aw), len(g), round(float(g["off"].mean()), 4),
            round(float(g["on_mwh"].sum())), round(float(g["off_mwh"].sum()))]
           for (y, t, sm, aw), g in x.groupby(["year", "tech", "small", "awarded"])]
    he = (x["win_from"] - 1) % 24 + 1
    mix = []
    for (y, t), g in x.groupby(["year", "tech"]):
        h = he[g.index]
        mix.append([int(y), t, len(g), round(float((g["win_from"] >= 25).mean()), 4),
                    round(float(((h >= 9) & (h <= 17) & (g["win_from"] < 25)).mean()), 4),
                    round(float(g["off"].mean()), 4), round(float(g["loss_per_mw"].median()), 1)])
    return {"off": off, "mix": mix}


def build(cache: Path, end=None, table=None) -> dict:
    """data/goal.json.gz:
      {"version", "built", "through", "cheap", "over_price",
       "years": {year: {"from", "to", "cheap_hours"}},
       "q1": {"columns": [year, tech, group, trains, capacity_mw, off_mwh], "rows"},
       "floor": {"grid": [[year, net load GW, fossil GW, hours]] (1 GW cells, lower edges),
                 "median": {"all" | year: [[net load bin GW, median fossil MW, hours]]} (FLOOR_BIN),
                 "stuck": [[year, net load bin GW, tech, minimum_mwh, above_minimum_mwh]],
                 "hours": [[year, net load bin GW, hours]] (STUCK_BIN), "bin", "stuck_bin"},
       "q2": {"columns": [year, tech, reason, mwh, cost_usd], "rows", "reasons",
              "award": [[year, tech, group, stretches, stayed]],
              "cost": [[year, tech, group (as award), minimum_mwh, cost_usd]]},
       "q3": {"off": [[year, tech, small (0: losing more than a restart), awarded, windows, off_share,
                        minimum_online_mwh, minimum_offline_mwh]],
              "mix": [[year, tech, windows, overnight, midday, off_rate, median_loss_per_mw]]},
       "q4": {"years": [[year, available_mwh, curtailed_mwh, in_oversupply_mwh, uncongested_mwh,
                         oversupply_hours, counted_hours, uncongested_in_counted_mwh, uncongested_by_he[24]]],
              "atmin": [[year, tech, ECON or the tech, mwh]], "avoid": [[year, scenario, mwh]], "scenarios", "econ"}}
    MWh sums over the year's hours; the page divides by the hours for means."""
    end = end or max((p.name[:7] for p in (UNIT_DATA_DIR / "60d").glob("20*.json.gz")), default=None) \
        or max(p.stem[8:] for p in HISTORY_DIR.glob("thermal-*.parquet"))
    months = _months(START, end)
    out = {"version": VERSION, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "cheap": CHEAP, "over_price": OVER_PRICE, "years": {},
           "q1": {"columns": ["year", "tech", "group", "trains", "capacity_mw", "off_mwh"], "rows": [], "groups": list(GROUPS)},
           "floor": {"grid": [], "median": {}, "stuck": [], "hours": [], "bin": FLOOR_BIN, "stuck_bin": STUCK_BIN},
           "q2": {"columns": ["year", "tech", "reason", "mwh", "cost_usd"], "rows": [], "reasons": list(REASONS), "award": [], "cost": []},
           "q4": {"years": [], "atmin": [], "avoid": [], "scenarios": [s for s, _ in SCENARIOS] + ["all fossil at minimum"], "econ": list(ECON)}}
    if table is None:
        from .decision_table import build as build_table
        table = build_table(months, cache)
    losing = _losing(table)
    from .decision_table import gas_by_hub, hub_of
    gas = (gas_by_hub(cache), hub_of())
    before, nets, fos = None, [], []
    for y in sorted({m[:4] for m in months}):
        r = _year(int(y), [m for m in months if m[:4] == y], cache, before, losing, gas)
        if r is None:
            continue
        before = r["states"]
        print(f"goal: {y} {r['from']} to {r['to']}", flush=True)
        out["years"][y] = {"from": r["from"], "to": r["to"], "cheap_hours": r["cheap_hours"]}
        out["q1"]["rows"] += r["q1"]
        out["q2"]["rows"] += r["q2"]
        out["q2"]["award"] += r["q2award"]
        out["q2"]["cost"] += r["q2cost"]
        if r["floor"]:
            f = r["floor"]
            for k in ("grid", "stuck", "hours"):
                out["floor"][k] += f[k]
            out["floor"]["median"][y] = _medians(f["net"], f["fossil"])
            nets.append(f["net"])
            fos.append(f["fossil"])
        if r["q4"]:
            out["q4"]["years"].append(r["q4"]["year"])
            out["q4"]["atmin"] += r["q4"]["atmin"]
            out["q4"]["avoid"] += r["q4"]["avoid"]
        out["through"] = r["to"]
    if nets:
        out["floor"]["median"]["all"] = _medians(np.concatenate(nets), np.concatenate(fos))
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
