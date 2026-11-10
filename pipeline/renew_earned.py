"""What wind and solar earned, day by day from Jan 2019, on the Thermal page's revenue basis: read by
the Renewables page's "What wind and solar earned" and "Where the revenue comes from" panels, set
beside thermal (pipeline/thermal_years.py).

Per technology (wind, solar) and operating day:
  gen      energy produced, MWh (hourly mean telemetered output, negatives as 0)
  rev      energy revenue on the two-settlement basis, $: DAM award x DA node price + (output -
           award) x real-time node price; an hour missing one of the prices settles at the other.
           The 60-day days take pipeline/econ.py's per-unit series (real-time at the node where a
           unit has no day-ahead data, system lambda where the node price is missing)
  as       DAM ancillary service revenue, $ (60-day days only; the history files keep no wind or
           solar AS, which is a few tenths of a percent of their revenue)
  curt     curtailed energy, MWh: HSL above base point, summed over hours
Per day also hub_rt (the day's mean real-time HB_HUBAVG, $/MWh: sorts days into kinds as on Thermal),
and sys_gen (ERCOT generation, MWh: wind, solar and thermal output, storage left out) and sys_rev
(that generation x the hour's real-time hub average, $), whose ratio over a period is what the
average MWh earned at the hub (renew_years' hub_rt_gen).

Two sources, one writer each (as thermal_years.py):
  history release units-, thermal-, rt-prices-YYYY-MM.parquet (to the last rt-prices month, Nov
      2025): the Goal workflow's `--full` writes renew_earned_hist.json.gz
  data/econ/{wind,solar}.json.gz, data/renewables/years.json.gz (daily curtailment and ERCOT
      generation, renew_years.py) and data/prices/<date>.json.gz: the update run adds the 60-day
      days after the history and writes renewables/earned.json.gz, which the page reads
No ERCOT downloads.

    python -m pipeline.renew_earned --full   # the Goal workflow (needs the history months in HISTORY_DIR)
    python -m pipeline.renew_earned          # the update run

File: {"format", "built", "hist_last", "dates", "src": "h" | "s" per date, "hub_rt", "sys_gen",
       "sys_rev": [per date], "techs": {tech: {field: [per date]}}}
"""
import argparse
import datetime as dt
import sys

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

FORMAT = 1
PATH = DATA_DIR / "renewables" / "earned.json.gz"
HIST_PATH = DATA_DIR / "renew_earned_hist.json.gz"
TECHS = ("wind", "solar")
FIELDS = ("gen", "rev", "as", "curt")
HUB = "HB_HUBAVG"


def _month(month):
    """{(date, tech): [FIELDS]} and {date: (hub_rt, sys_gen, sys_rev)} from one history month."""
    u = pd.read_parquet(HISTORY_DIR / f"units-{month}.parquet", columns=["date", "he", "tech", "sp", "hsl", "bp", "out", "award", "da_node"])
    for c in ("date", "tech", "sp"):
        u[c] = u[c].astype(str)
    u = u[u["tech"].isin(TECHS)]
    rt = pd.read_parquet(HISTORY_DIR / f"rt-prices-{month}.parquet", columns=["date", "he", "point", "price"])
    rt["point"], rt["date"] = rt["point"].astype(str), rt["date"].astype(str)
    hub = rt[rt["point"] == HUB].groupby(["date", "he"])["price"].mean()
    rt = rt[rt["point"].isin(set(u["sp"]))].groupby(["date", "he", "point"], as_index=False)["price"].mean()
    u = u.merge(rt.rename(columns={"point": "sp", "price": "rt"}), on=["date", "he", "sp"], how="left")
    out = np.clip(u["out"].fillna(0).to_numpy(float), 0, None)
    award = u["award"].fillna(0).to_numpy(float)
    da, rtp = u["da_node"].to_numpy(float), u["rt"].to_numpy(float)
    da_e, rt_e = np.where(np.isfinite(da), da, rtp), np.where(np.isfinite(rtp), rtp, da)
    u["rev"] = np.nan_to_num(award * da_e) + np.nan_to_num((out - award) * rt_e)
    u["gen"] = out
    u["curt"] = np.clip(u["hsl"].fillna(0).to_numpy(float) - u["bp"].fillna(0).to_numpy(float), 0, None)
    g = u.groupby(["date", "tech"])[["gen", "rev", "curt"]].sum()
    res = {(d, t): [r["gen"], r["rev"], 0.0, r["curt"]] for (d, t), r in g.iterrows()}
    # ERCOT generation by hour (wind, solar, thermal) against the hub average
    gen = u.groupby(["date", "he"])["gen"].sum()
    tp = HISTORY_DIR / f"thermal-{month}.parquet"
    if tp.exists():
        th = pd.read_parquet(tp, columns=["date", "he", "out"])
        th["date"] = th["date"].astype(str)
        gen = gen.add(th.assign(out=th["out"].clip(lower=0)).groupby(["date", "he"])["out"].sum(), fill_value=0)
    j = pd.DataFrame({"gen": gen}).join(hub.rename("hub"), how="inner").dropna()
    sysd = j.assign(rev=j["gen"] * j["hub"]).groupby(level=0)[["gen", "rev"]].sum()
    hub_d = hub.groupby(level=0).mean()
    days = {d: (float(hub_d.get(d, np.nan)), float(sysd["gen"].get(d, np.nan)), float(sysd["rev"].get(d, np.nan))) for d in sorted(set(u["date"]))}
    return res, days


def _file(dates, src, sysrow, rows):
    techs = {t: {k: [None if (d, t) not in rows else int(round(rows[(d, t)][i])) for d in dates] for i, k in enumerate(FIELDS)} for t in TECHS}
    num = lambda v, nd: None if v is None or not np.isfinite(v) else round(float(v), nd)
    return {"format": FORMAT, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "dates": dates, "src": "".join(src),
            "hub_rt": [num(sysrow[d][0], 2) for d in dates],
            "sys_gen": [num(sysrow[d][1], 0) for d in dates],
            "sys_rev": [num(sysrow[d][2], 0) for d in dates], "techs": techs}


def build_hist():
    last_rt = sorted(p.stem[10:] for p in HISTORY_DIR.glob("rt-prices-*.parquet"))
    months = sorted(p.stem[6:] for p in HISTORY_DIR.glob("units-*.parquet"))
    months = [m for m in months if last_rt and m <= last_rt[-1] and (HISTORY_DIR / f"rt-prices-{m}.parquet").exists()]
    if not months:
        warn("renew_earned: no units and rt-prices months in HISTORY_DIR; nothing written")
        return False
    rows, sysrow = {}, {}
    for m in months:
        r, s = _month(m)
        rows.update(r)
        sysrow.update(s)
        print(f"renew_earned: {m}: {len(s)} days")
    dates = sorted(sysrow)
    obj = _file(dates, ["h"] * len(dates), sysrow, rows)
    obj["hist_last"] = dates[-1]
    write_json_gz(HIST_PATH, obj)
    print(f"renew_earned: history {dates[0]} to {dates[-1]} -> {HIST_PATH.name}")
    return True


def recent_days(after):
    """{(date, tech): [FIELDS]} and {date: (hub_rt, sys_gen, sys_rev)} for the 60-day days after `after`."""
    rows = {}
    for t in TECHS:
        e = read_json_gz(DATA_DIR / "econ" / f"{t}.json.gz", default=None)
        if not e:
            warn(f"renew_earned: no econ file for {t}")
            continue
        for u in e["units"].values():
            for i, d in enumerate(e["dates"]):
                q = u["mwh"][i]
                if d <= after or q is None:
                    continue
                da, rt, dart = u["rev_da"][i], u["rev_rt"][i], u["rev_da_rt"][i]
                en = da + rt - dart if None not in (da, rt, dart) else rt if rt is not None else u["rev_lam"][i]
                if en is None:
                    continue
                r = rows.setdefault((d, t), [0.0, 0.0, 0.0, 0.0])
                r[0] += q
                r[1] += en
                r[2] += u["rev_as"][i] or 0
    ry = read_json_gz(DATA_DIR / "renewables" / "years.json.gz", default=None) or {}
    ydates = ry.get("dates") or []
    for t in TECHS:
        c = ((ry.get("daily") or {}).get(t) or {}).get("curt") or []
        for i, d in enumerate(ydates):
            if (d, t) in rows and i < len(c) and c[i] is not None:
                rows[(d, t)][3] = c[i] * 1e3      # GWh -> MWh
    w = (ry.get("daily") or {}).get("wind") or {}
    ys = {d: (w.get("hub_rt_gen", [None] * len(ydates))[i], w.get("sys_gen", [None] * len(ydates))[i]) for i, d in enumerate(ydates)}
    sysrow = {}
    for d in sorted({d for d, _ in rows}):
        p = ((read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz", default=None) or {}).get("spp15") or {}).get(HUB)
        v = [x for x in (p or []) if x is not None]
        hg, sg = ys.get(d, (None, None))
        sysrow[d] = (sum(v) / len(v) if v else np.nan, sg * 1e3 if sg is not None else np.nan,
                     hg * sg * 1e3 if hg is not None and sg is not None else np.nan)
    return rows, sysrow


def build():
    hist = read_json_gz(HIST_PATH, default=None)
    rows, src, sysrow, after = {}, {}, {}, ""
    if hist and hist.get("format") == FORMAT:
        after = hist.get("hist_last") or hist["dates"][-1]
        for i, d in enumerate(hist["dates"]):
            for t in TECHS:
                f = hist["techs"][t]
                if f["gen"][i] is not None:
                    rows[(d, t)] = [f[k][i] or 0 for k in FIELDS]
            src[d] = "h"
            nz = lambda v: np.nan if v is None else v
            sysrow[d] = (nz(hist["hub_rt"][i]), nz(hist["sys_gen"][i]), nz(hist["sys_rev"][i]))
    else:
        warn("renew_earned: no history file at this format; the page shows the 60-day days alone")
    r, s = recent_days(after)
    rows.update(r)
    for d in s:
        src[d], sysrow[d] = "s", s[d]
    dates = sorted(src)
    if not dates:
        warn("renew_earned: no days; nothing written")
        return
    obj = _file(dates, [src[d] for d in dates], sysrow, rows)
    obj["hist_last"] = after or None
    write_json_gz(PATH, obj)
    print(f"renew_earned: {len(dates)} days, {dates[0]} to {dates[-1]} ({sum(1 for d in dates if src[d] == 'h')} from the history)")


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
