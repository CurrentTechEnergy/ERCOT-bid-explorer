"""Thermal across the years: what each thermal technology earned, what it cost to run and its margin,
day by day from Jan 2019.  Read by the Thermal page (thermal.html): the headline "coal earned $X at
$Y/MWh" for a chosen year, margin by kind of day, and the across-the-years charts.

Per technology (nuclear, coal, combined cycle, gas steam, combustion turbine) and operating day:
  gen      energy produced, MWh (hourly mean net output, negatives as 0)
  rev      energy revenue on the two-settlement basis, $: DAM award x DA node price + (output -
           award) x real-time node price; an hour missing one of the prices settles at the other
  as       DAM ancillary service awards x their clearing prices, $
  fuel     fuel and variable O&M, $: output x the unit's heat rate at that output (its measured
           curve from minimum to full load, pipeline/heat_rates, a CC configuration its train's)
           x its fuel price, plus VOM x output.  Gas at the unit's own hub (Houston Ship Channel or
           Waha, fuel_hubs.json.gz) that day, Henry Hub plus the calendar month's hub basis where the
           hub has no price; coal at the plant's EIA-923 delivered price that month; nuclear at the
           EIA heat rate x NUC_FUEL.  The same basis as the Thermal units table's default ("Measured heat
           rate", own hub, two-settlement).
  starts   starts (offline or outage to online; a CC train counted as a whole)
  start    start-up cost, $: hot, intermediate or cold by hours offline (8 and 24, econ.py); the 60-day
           days at the unit's own DAM offer for that class, else the site's generic cost (thermal-units.js
           startCost); the history keeps only the hot offer, so its intermediate and cold starts
           take the generic cost
Per day also hub_rt, the day's mean real-time HB_HUBAVG price ($/MWh), which sorts days into kinds.

Two sources, one writer each (as pipeline/coal_years.py):
  history release thermal-, rt-prices-, as-, as-mcpc-YYYY-MM.parquet (to Nov 2025): the Goal
      workflow's `--full` writes them to thermal_years_hist.json.gz
  data/econ/<tech>.json.gz (pipeline/econ.py) and data/prices/<date>.json.gz: the update run adds the
      60-day days after the history's last day and writes thermal/years.json.gz, which the page reads
No ERCOT downloads.  Gas: the private daily hub files (pipeline/private.py, R2) where they can be
read, else the published 7-day hub averages (gas_hub_avg.json.gz); Henry Hub from the EIA files.

    python -m pipeline.thermal_years --full   # the Goal workflow (needs the history months in HISTORY_DIR)
    python -m pipeline.thermal_years          # the update run

File: {"format", "built", "hist_last", "dates": [YYYY-MM-DD], "src": "h" | "s" per date,
       "hub_rt": [$/MWh per date], "techs": {tech: {field: [per date]}}, "vom", "generic_start"}
"""
import argparse
import datetime as dt
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

from . import heat_rates, private
from .config import DATA_DIR, GENERIC_COSTS, HISTORY_DIR
from .intraday import train_of
from .log import warn
from .store import read_json_gz, write_json_gz

FORMAT = 1
PATH = DATA_DIR / "thermal" / "years.json.gz"            # the page reads this one (update run)
HIST_PATH = DATA_DIR / "thermal_years_hist.json.gz"     # 2019 on from the history release (Goal --full)
TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine")
GAS_TECHS = ("combined_cycle", "gas_steam", "combustion_turbine")
FIELDS = ("gen", "rev", "as", "fuel", "starts", "start")
# the Thermal units table defaults (thermal-units.js DEFAULTS, FUEL_PRICE, EIA_HR)
VOM = {"combined_cycle": 3.0, "combustion_turbine": 5.0, "gas_steam": 4.0, "coal": 5.0, "nuclear": 2.5}
# hot, intermediate and cold start ($): the site's GENERIC_COSTS (config.py), as thermal-units.js; nuclear none
GENERIC_START = {**{t: v[:3] for t, v in GENERIC_COSTS.items()}, "nuclear": (0.0, 0.0, 0.0)}
HOT_H, INTER_H = 8, 24     # hours offline: hot at most, intermediate at most, else cold (econ.py)
EIA_HR = {"combined_cycle": 7.548, "combustion_turbine": 10.999, "gas_steam": 10.337, "coal": 10.018, "nuclear": 10.443}
NUC_FUEL = 0.7      # $/MMBtu
HUB = "HB_HUBAVG"
AS_KEYS = ("regup", "regdn", "rrs", "ecrs", "nspin")


# ---- gas -----------------------------------------------------------------------------------
def gas_by_hub(first="2018-12-01", last=None):
    """{"hsc" | "waha" | "hh": pd.Series of $/MMBtu on every calendar day}: each hub's own daily
    price (the private files; else the published 7-day averages), carried up to 7 days, then Henry
    Hub plus the hub's median basis for the calendar month (pipeline/gas.hub_with_basis's rule)."""
    last = last or dt.date.today().isoformat()
    cal = pd.date_range(first, last).strftime("%Y-%m-%d")
    hh = pd.Series(dtype=float)
    for name, key in (("gas_history.json.gz", "henry_hub"), ("gas.json.gz", None)):
        g = read_json_gz(DATA_DIR / name, default={}) or {}
        g = g.get(key, {}) if key else g
        if g.get("dates"):
            hh = pd.concat([hh, pd.Series(g["value"], index=g["dates"], dtype=float)])
    hh = hh[~hh.index.duplicated(keep="last")].sort_index().reindex(cal).ffill().bfill()
    raw = {}
    for name in ("gas_hub_history.json.gz", "gas_hubs.json.gz"):
        h = private.read(name, default=None) or {}
        for k, v in (h.get("hubs", h) or {}).items():
            if isinstance(v, dict) and v.get("dates"):
                raw.setdefault(k, []).append(pd.Series(v["value"], index=v["dates"], dtype=float))
    if not raw:
        avg = (read_json_gz(DATA_DIR / "gas_hub_avg.json.gz", default={}) or {}).get("hubs") or {}
        raw = {k: [pd.Series(v.get("value") or [], index=v.get("dates") or [], dtype=float)] for k, v in avg.items()}
    mo = pd.Series(cal.str[5:7], index=cal)
    out = {"hh": hh}
    for k in ("hsc", "waha"):
        s = pd.concat(raw.get(k) or [pd.Series(dtype=float)])
        s = s[~s.index.duplicated(keep="last")].sort_index().reindex(cal)
        basis = (s - hh).groupby(mo).median().reindex(mo.unique()).fillna(0.0)
        out[k] = s.ffill(limit=7).fillna(hh + mo.map(basis))
    return out


def _hubs():
    """{unit or CC train: "hsc" | "waha"} from fuel_hubs.json.gz."""
    hub = {}
    for name, u in ((read_json_gz(DATA_DIR / "fuel_hubs.json.gz", default={}) or {}).get("units") or {}).items():
        hub[name] = u.get("hub") or "hsc"
        if u.get("tech") == "combined_cycle":
            hub.setdefault(train_of(name), hub[name])
    return hub


# ---- the history months ------------------------------------------------------------------------
def _month(month, gas, hubs, carry):
    """{(date, tech): [FIELDS]} and {date: hub_rt} from one month of the history release.  carry:
    {train or unit: online in the last hour seen (True/False), None unknown}, updated."""
    t = pd.read_parquet(HISTORY_DIR / f"thermal-{month}.parquet",
                        columns=["date", "he", "unit", "tech", "sp", "state", "lsl", "hsl", "out", "award", "da_node", "dam_lsl", "hot_start"])
    for c in ("unit", "tech", "sp", "state", "date"):
        t[c] = t[c].astype(str)
    t = t[t["tech"].isin(TECHS)]
    rp = HISTORY_DIR / f"rt-prices-{month}.parquet"
    hub_rt = {}
    if rp.exists():
        rt = pd.read_parquet(rp, columns=["date", "he", "point", "price"])
        rt["point"] = rt["point"].astype(str)
        rt["date"] = rt["date"].astype(str)
        hub_rt = rt[rt["point"] == HUB].groupby("date")["price"].mean().round(2).to_dict()
        rt = rt[rt["point"].isin(set(t["sp"]))].groupby(["date", "he", "point"], as_index=False)["price"].mean()
        t = t.merge(rt.rename(columns={"point": "sp", "price": "rt"}), on=["date", "he", "sp"], how="left")
    else:
        t["rt"] = np.nan
    out = np.clip(t["out"].fillna(0).to_numpy(float), 0, None)
    award = t["award"].fillna(0).to_numpy(float)
    da, rtp = t["da_node"].to_numpy(float), t["rt"].to_numpy(float)
    da_e, rt_e = np.where(np.isfinite(da), da, rtp), np.where(np.isfinite(rtp), rtp, da)
    t["rev"] = np.nan_to_num(award * da_e) + np.nan_to_num((out - award) * rt_e)
    t["gen"] = out
    # fuel: the heat-rate curve of the unit (a CC configuration: its train's), at each hour's output
    t["key"] = np.where(t["tech"] == "combined_cycle", t["unit"].map(train_of), t["unit"])
    peak = t.groupby(["date", "unit"])["hsl"].transform("max").to_numpy(float)
    lsl = t["dam_lsl"].fillna(t["lsl"]).to_numpy(float)
    curves = {}
    for tech, key in t[["tech", "key"]].drop_duplicates().itertuples(index=False):
        c = heat_rates.curve(tech, key) if tech != "nuclear" else None
        curves[(tech, key)] = (c[0], c[1]) if c else (EIA_HR[tech], EIA_HR[tech])
    cv = np.array([curves[(a, b)] for a, b in zip(t["tech"], t["key"])], float).reshape(-1, 2)
    ok = np.isfinite(lsl) & np.isfinite(peak) & (peak > lsl)
    f = np.where(ok, np.clip((out - np.nan_to_num(lsl)) / np.where(ok, peak - np.nan_to_num(lsl), 1), 0, 1), 1.0)
    mmbtu = out * (cv[:, 0] + (cv[:, 1] - cv[:, 0]) * f)
    tech = t["tech"].to_numpy()
    price = np.full(len(t), np.nan)
    dates = t["date"].to_numpy()
    for h in ("hsc", "waha"):
        m = np.isin(tech, GAS_TECHS) & (t["key"].map(lambda k: hubs.get(k, "hsc")).to_numpy() == h)
        price[m] = gas[h].reindex(dates[m]).to_numpy(float)
    m = tech == "coal"
    if m.any():
        cp = {u: heat_rates.coal_price(u, f"{month}-01")[0] for u in set(t["unit"][m])}
        price[m] = t["unit"][m].map(cp).to_numpy(float)
    price[tech == "nuclear"] = NUC_FUEL
    vom = np.array([VOM[x] for x in tech])
    t["fuel"] = np.nan_to_num(mmbtu * price) + out * vom
    # starts: a train (or unit) online in an hour after an hour offline or on outage; an unknown
    # hour ('-') breaks the chain.  Hours offline before it set the class: hot at most HOT_H,
    # intermediate at most INTER_H, cold beyond (econ.py's rule); a hot start at the unit's own DAM
    # hot-start offer that day, else the generic one; intermediate and cold at the generic ones (the
    # history keeps only the hot offer)
    st = t.assign(on=t["state"].isin(["m", "a"]), known=t["state"] != "-")
    k = st.groupby(["key", "tech", "date", "he"], as_index=False, observed=True).agg(
        on=("on", "max"), known=("known", "max"), hot=("hot_start", "max")).sort_values(["key", "date", "he"])
    k["hot"] = k.groupby(["key", "date"])["hot"].transform("max")
    cost = np.zeros(len(k))
    started = np.zeros(len(k), bool)
    pos = 0
    for key, grp in k.groupby("key", sort=False):
        on, known, hot = grp["on"].to_numpy(bool), grp["known"].to_numpy(bool), grp["hot"].to_numpy(float)
        tc = grp["tech"].iat[0]
        g_hot, g_inter, g_cold = GENERIC_START[tc]
        state = carry.get(key)          # (online, hours offline so far) or None
        for j in range(len(on)):
            if not known[j]:
                state = None
            elif on[j]:
                if state is not None and not state[0]:
                    started[pos + j] = True
                    off = state[1]
                    cost[pos + j] = (hot[j] if np.isfinite(hot[j]) else g_hot) if off <= HOT_H else g_inter if off <= INTER_H else g_cold
                state = (True, 0)
            else:
                state = (False, (state[1] + 1) if state is not None and not state[0] else 1) if state is not None else None
                # an hour offline after an unknown stretch: offline time not known, so the next start is not counted
        carry[key] = state
        pos += len(on)
    k["start"], k["start_cost"] = started, cost
    # ancillary services
    asd = pd.DataFrame(columns=["date", "tech", "as"])
    ap, mp = HISTORY_DIR / f"as-{month}.parquet", HISTORY_DIR / f"as-mcpc-{month}.parquet"
    if ap.exists() and mp.exists():
        a = pd.read_parquet(ap)
        mc = pd.read_parquet(mp)
        a["date"], mc["date"], a["tech"] = a["date"].astype(str), mc["date"].astype(str), a["tech"].astype(str)
        a = a.merge(mc, on=["date", "he"], how="left", suffixes=("", "_p"))
        a["as"] = sum(a[s].fillna(0) * a[f"{s}_p"].fillna(0) for s in AS_KEYS if s in a and f"{s}_p" in a)
        asd = a[a["tech"].isin(TECHS)].groupby(["date", "tech"], as_index=False)["as"].sum()
    res = {}
    g = t.groupby(["date", "tech"])[["gen", "rev", "fuel"]].sum()
    s = k.groupby(["date", "tech"]).agg(starts=("start", "sum"), start=("start_cost", "sum"))
    a = asd.set_index(["date", "tech"])["as"] if len(asd) else pd.Series(dtype=float)
    for (d, tc), r in g.iterrows():
        res[(d, tc)] = [r["gen"], r["rev"], float(a.get((d, tc), 0.0)), r["fuel"],
                        int(s["starts"].get((d, tc), 0)), float(s["start"].get((d, tc), 0.0))]
    return res, hub_rt


def build_hist():
    months = sorted(p.stem[8:] for p in HISTORY_DIR.glob("thermal-*.parquet"))
    if not months:
        warn("thermal_years: no thermal months in HISTORY_DIR; nothing written")
        return False
    gas = gas_by_hub(last=f"{months[-1]}-28")
    last_cal = pd.Period(months[-1]).end_time.strftime("%Y-%m-%d")
    gas = {k: v.reindex(pd.date_range("2018-12-01", last_cal).strftime("%Y-%m-%d")).ffill() for k, v in gas.items()}
    hubs, carry = _hubs(), {}
    rows, hub_rt = {}, {}
    for m in months:
        r, h = _month(m, gas, hubs, carry)
        rows.update(r)
        hub_rt.update(h)
        print(f"thermal_years: {m}: {len({d for d, _ in r})} days")
    dates = sorted({d for d, _ in rows})
    obj = _file(dates, ["h"] * len(dates), [hub_rt.get(d) for d in dates], rows)
    obj["hist_last"] = dates[-1]
    write_json_gz(HIST_PATH, obj)
    print(f"thermal_years: history {dates[0]} to {dates[-1]} -> {HIST_PATH.name}")
    return True


def _file(dates, src, hub_rt, rows):
    techs = {}
    for tc in TECHS:
        f = {k: [] for k in FIELDS}
        for d in dates:
            v = rows.get((d, tc))
            for i, k in enumerate(FIELDS):
                f[k].append(None if v is None else int(round(v[i])))
        techs[tc] = f
    return {"format": FORMAT, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "dates": dates, "src": "".join(src), "hub_rt": [None if v is None or not np.isfinite(v) else round(float(v), 2) for v in hub_rt],
            "techs": techs, "vom": VOM, "generic_start": GENERIC_START, "nuc_fuel": NUC_FUEL}


# ---- the 60-day days ---------------------------------------------------------------------------
def _num(v):
    return 0.0 if v is None else float(v)


def econ_days(after):
    """{(date, tech): [FIELDS]} and {date: hub_rt} from data/econ (pipeline/econ.py) for the dates
    after `after`, on the Thermal units table's default basis (thermal-units.js unitEcon with S.cost "meas")."""
    rows, hub_rt = {}, {}
    for tc in TECHS:
        e = read_json_gz(DATA_DIR / "econ" / f"{tc}.json.gz", default=None)
        if not e:
            warn(f"thermal_years: no econ file for {tc}")
            continue
        dates, hh = e["dates"], e.get("gas") or []
        for name, u in e["units"].items():
            for i, d in enumerate(dates):
                if d <= after or u["mwh"][i] is None:
                    continue
                mwh = u["mwh"][i]
                da, rt, dart = u["rev_da"][i], u["rev_rt"][i], u["rev_da_rt"][i]
                if da is not None and rt is not None and dart is not None:
                    en = da + rt - dart
                elif rt is not None:
                    en = rt
                else:
                    en = _num(u["rev_lam"][i])
                fm = (u.get("fuel_meas") or [None] * len(dates))[i]
                if tc == "nuclear":
                    fuel = mwh * EIA_HR[tc] * NUC_FUEL
                elif fm is not None:
                    fuel = fm
                elif tc in GAS_TECHS and (u.get("gas_own") or [None] * len(dates))[i] is not None:
                    fuel = u["gas_own"][i] * EIA_HR[tc]
                elif tc in GAS_TECHS and i < len(hh) and hh[i] is not None:
                    fuel = mwh * EIA_HR[tc] * hh[i]
                elif tc == "coal":
                    fuel = mwh * EIA_HR[tc] * heat_rates.coal_price(name, d)[0]
                else:
                    continue
                n = _num(u["starts"][i]) if u.get("starts") else 0.0
                ni = _num((u.get("starts_inter") or [None] * len(dates))[i])
                nc = _num((u.get("starts_cold") or [None] * len(dates))[i])
                sc = 0.0
                for key, gen, cnt in (("start_hot", GENERIC_START[tc][0], max(0.0, n - ni - nc)),
                                      ("start_inter", GENERIC_START[tc][1], ni), ("start_cold", GENERIC_START[tc][2], nc)):
                    own = (u.get(key) or [None] * len(dates))[i]
                    sc += cnt * (own if own is not None else gen)
                r = rows.setdefault((d, tc), [0.0] * 6)
                r[0] += mwh
                r[1] += en
                r[2] += _num(u["rev_as"][i])
                r[3] += fuel + mwh * VOM[tc]
                r[4] += n
                r[5] += sc
    for d in sorted({d for d, _ in rows}):
        p = ((read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz", default=None) or {}).get("spp15") or {}).get(HUB)
        v = [x for x in (p or []) if x is not None]
        hub_rt[d] = round(sum(v) / len(v), 2) if v else None
    return rows, hub_rt


def build():
    hist = read_json_gz(HIST_PATH, default=None)
    rows, src, hub = {}, {}, {}
    after = ""
    if hist and hist.get("format") == FORMAT:
        after = hist.get("hist_last") or hist["dates"][-1]
        for i, d in enumerate(hist["dates"]):
            for tc, f in hist["techs"].items():
                if f["gen"][i] is not None:
                    rows[(d, tc)] = [f[k][i] or 0 for k in FIELDS]
            src[d], hub[d] = "h", hist["hub_rt"][i]
    else:
        warn("thermal_years: no history file at this format; the page shows the 60-day days alone")
    r, h = econ_days(after)
    rows.update(r)
    for d in h:
        src[d], hub[d] = "s", h[d]
    dates = sorted(src)
    if not dates:
        warn("thermal_years: no days; nothing written")
        return
    obj = _file(dates, [src[d] for d in dates], [hub.get(d) for d in dates], rows)
    obj["hist_last"] = after or None
    write_json_gz(PATH, obj)
    print(f"thermal_years: {len(dates)} days, {dates[0]} to {dates[-1]} ({sum(1 for d in dates if src[d] == 'h')} from the history)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--full", action="store_true", help="rebuild the history file from HISTORY_DIR (Goal workflow)")
    a = ap.parse_args(argv)
    if a.full:
        ok = build_hist()
        build()
        return 0 if ok else 1
    build()
    return 0


if __name__ == "__main__":
    sys.exit(main())
