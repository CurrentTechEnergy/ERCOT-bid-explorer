"""Wear and tear: hours run and starts per thermal unit and calendar year from 2019, with every
start split into a start by choice and a return from an outage.  Read by the Unit page ("Run
hours and starts by year") and the Thermal page ("Run hours and starts by year", by technology).
Writes data/wear.json.gz.  Needs no ERCOT download.

States are the hourly ones (intraday.unit_hours): "m"/"a" running, "0" offline, "o" outage, "-" no
data, from the history release's thermal-YYYY-MM.parquet months and, for the days after the last
of them, data/unit_hours_60d.json.gz.  A combined-cycle train is one unit (its configurations
merged hour by hour, the most-running state winning, as groups.merged_strips).  The site's outage
rule (groups.rewrite_outages) is applied first, so the OFF hours a unit reports around an outage
count as outage.  Then each non-running spell that follows a running hour and ends in one is:
  a start by choice      at least OUT_MIN_H OFF hours and no more missing hours than OFF hours
                         (an economic shutdown, outage hours inside it included: maintenance
                         slotted into a shutdown); hot when the unit was off HOT_H hours or less,
                         intermediate up to INTER_H, cold beyond (the site's restart classes)
  a return from outage   otherwise, when it holds an outage hour
and anything else (a one-hour blip, a gap in the data) is not counted.  A start counts in the
year of its first running hour.  Hours are hourly states, so a start and stop inside one hour is
not seen (the run-by-run count in econ.py sees it).

The history months are read whole each run (about a minute); without them on hand (the update
run fetches them; history.py) the file is left as it is.

File:
  {"built", "through", "therm_last", "out_min_h", "hot_h", "inter_h", "columns": COLUMNS,
   "rows": [[unit, tech, year, hours, run_h, off_h, out_h, starts, returns, hot, inter, cold], ...]}
  hours: hours with a state that year; off_h: offline by choice; out_h: outage (after the rule).

    python -m pipeline.wear
"""
import datetime as dt
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .groups import GROUPED_TECHS, OUT_MIN_H, key_of, outage_ruled
from .log import warn
from .store import read_json_gz, write_json_gz
from .trends import unit_techs

PATH = DATA_DIR / "wear.json.gz"
START = "2019-01-01"
HOT_H, INTER_H = 8, 24       # hours off: hot start at most HOT_H, intermediate at most INTER_H, else cold
COLUMNS = ["unit", "tech", "year", "hours", "run_h", "off_h", "out_h", "starts", "returns", "hot", "inter", "cold"]
CH = np.array(["-", "o", "0", "m", "a"])         # rank order: the most-running state wins a merge
RANK = {c: i for i, c in enumerate(CH)}


def starts(st) -> list:
    """[(index of the first running hour, "choice" | "outage", hours off before it)] on one unit's
    outage-ruled states (the module docstring's rule; common.js hourlyStarts is the same)."""
    out, N, k = [], len(st), 1
    while k < N:
        if st[k] in "ma" or st[k - 1] not in "ma":
            k += 1
            continue
        j, off, o, gap = k, 0, 0, 0
        while j < N and st[j] not in "ma":
            c = st[j]
            off += c == "0"
            o += c == "o"
            gap += c == "-"
            j += 1
        if j < N:
            if off >= OUT_MIN_H and gap <= off:
                out.append((j, "choice", j - k))
            elif o:
                out.append((j, "outage", j - k))
        k = j
    return out


def _strips():
    """-> (day0, N, {key: (tech, int8 rank array)}, last history month, last day) or None."""
    files = sorted(HISTORY_DIR.glob("thermal-*.parquet"))
    if not files:
        return None
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    techs = unit_techs(read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {})
    dates = uh.get("dates") or []
    d0 = np.datetime64(START)
    last_hist = ""
    frames = []
    for p in files:
        d = pd.read_parquet(p, columns=["date", "unit", "tech", "he", "state"])
        d = d[d["tech"].astype(str).isin(GROUPED_TECHS)]
        if len(d):
            last_hist = max(last_hist, str(d["date"].max()))
            frames.append(d)
    end = max([last_hist] + dates[-1:]) if (last_hist or dates) else ""
    if not end:
        return None
    N = (int((np.datetime64(end) - d0).astype(int)) + 1) * 24
    arr, tk = {}, {}
    if frames:
        df = pd.concat(frames, ignore_index=True)
        df["k"] = (pd.to_datetime(df["date"].astype(str)).values.astype("datetime64[D]") - d0).astype(int) * 24 + df["he"].astype(int) - 1
        df = df[(df["k"] >= 0) & (df["k"] < N)]
        df["r"] = df["state"].astype(str).map(RANK).fillna(0).astype(np.int8)
        df["key"] = [key_of(u, t) for u, t in zip(df["unit"].astype(str), df["tech"].astype(str))]
        for key, g in df.groupby("key", sort=False):
            a = np.zeros(N, np.int8)
            np.maximum.at(a, g["k"].to_numpy(), g["r"].to_numpy())
            arr[key], tk[key] = a, str(g["tech"].iloc[0])
    for name, s in (uh.get("units") or {}).items():
        t = techs.get(name)
        if t not in GROUPED_TECHS:
            continue
        key = key_of(name, t)
        a = arr.get(key)
        if a is None:
            a = arr[key] = np.zeros(N, np.int8)
            tk[key] = t
        for i, day in enumerate(dates):
            if day <= last_hist:
                continue
            base = int((np.datetime64(day) - d0).astype(int)) * 24
            seg = np.array([RANK.get(c, 0) for c in s[24 * i:24 * i + 24]], np.int8)
            a[base:base + len(seg)] = np.maximum(a[base:base + len(seg)], seg)
    return d0, N, {k: (tk[k], a) for k, a in arr.items()}, last_hist[:7], end


def build():
    got = _strips()
    if got is None:
        warn("wear: no thermal history months on hand; wear.json.gz left as it is")
        return False
    d0, N, units, therm_last, through = got
    years = (d0 + (np.arange(N) // 24).astype("timedelta64[D]")).astype("datetime64[Y]").astype(int) + 1970
    acc = defaultdict(lambda: [0] * 9)       # (key, year) -> hours, run, off, out, starts, returns, hot, inter, cold
    for key, (t, a) in units.items():
        st = outage_ruled(CH[a], t)
        for y in np.unique(years[a > 0]):
            m = years == y
            s = st[m]
            v = acc[(key, int(y))]
            v[0] = int((s != "-").sum())
            v[1] = int(np.isin(s, ("m", "a")).sum())
            v[2] = int((s == "0").sum())
            v[3] = int((s == "o").sum())
        for k, kind, off in starts(st):
            v = acc[(key, int(years[k]))]
            if kind == "outage":
                v[5] += 1
            else:
                v[4] += 1
                v[6 if off <= HOT_H else 7 if off <= INTER_H else 8] += 1
    tech = {k: t for k, (t, _) in units.items()}
    rows = [[k, tech[k], y, *v] for (k, y), v in sorted(acc.items()) if v[0]]
    write_json_gz(PATH, {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "through": through,
                         "therm_last": therm_last, "out_min_h": OUT_MIN_H, "hot_h": HOT_H, "inter_h": INTER_H,
                         "columns": COLUMNS, "rows": rows})
    print(f"wear: {len({r[0] for r in rows})} units, {len(rows)} unit-years, through {through} (history to {therm_last or 'none'})", flush=True)
    return True


def main(argv=None):
    return 0 if build() else 1


if __name__ == "__main__":
    sys.exit(main())
