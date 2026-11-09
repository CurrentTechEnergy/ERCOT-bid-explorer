"""The Turn-ons and Turn-offs page's "Daily minimum floor" panels: for each day from Jan 2019, the
hour when the online thermal fleet's minimum output was lowest, split by technology.  Writes
data/lsl_floor.json.gz.

The floor in an hour is the LSL of every online coal, combined-cycle, gas steam and combustion
turbine unit, plus nuclear output (nuclear has no offer curve and does not back down, but its
registered LSL is a few hundred MW a unit and changed in 2024, so its LSL would understate it).
Each day is ranked twice:
  all     the hour with the lowest floor including nuclear
  fossil  the hour with the lowest fossil floor alone (no nuclear), so a nuclear refuelling outage
          cannot pull a day into the lowest days
An hour whose total is under LOW_SHARE of the day's median is a gap in the data and is skipped.

Inputs (no ERCOT download; both are already on hand):
  history release thermal-YYYY-MM.parquet   state m/a counts as online; lsl, out (to Nov 2025)
  data/60d-units/{date}.json.gz             each unit weighted by the share of the hour's SCED runs
                                            it was online and not starting up or shutting down
                                            (online_share less ramp_share), so a unit online for a
                                            third of the hour adds a third of its LSL, as the Real-time
                                            offers stack does (pipeline/actual_stack.py); lsl, output;
                                            for days after the last thermal month

Two files, one writer each, as pipeline/prices_years.py: the weekly Goal workflow runs `--full`
over the history release into lsl_floor_hist.json.gz; the update run starts from that file and
adds the 60-day days after its last thermal month, into lsl_floor.json.gz, which the page reads.

    python -m pipeline.lsl_floor --full   # the Goal workflow (needs the thermal months in HISTORY_DIR)
    python -m pipeline.lsl_floor          # the update run

File:
  {"built", "from", "through", "therm_last", "columns": COLUMNS, "rows": [[...], ...]}
  one row per day, MW rounded to whole MW, he = hour ending (Central)
"""
import argparse
import datetime as dt
import sys

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "lsl_floor.json.gz"            # the page reads this one (update run)
HIST_PATH = DATA_DIR / "lsl_floor_hist.json.gz"  # 2019 on from the history release (Goal workflow --full)
FOSSIL = ["coal", "combined_cycle", "gas_steam", "combustion_turbine"]
TECHS = ["nuclear"] + FOSSIL
COLUMNS = ["date", "he", *TECHS, "he_fos", *[f"{t}_fos" for t in FOSSIL]]
LOW_SHARE = 0.4        # an hour under this share of the day's median total is missing rows
MIN_HOURS = 20         # a day needs this many usable hours to be kept


def _history_hours():
    """Hourly MW by technology from the thermal history months: (frame, last month)."""
    parts, last = [], ""
    for p in sorted(HISTORY_DIR.glob("thermal-*.parquet")):
        d = pd.read_parquet(p, columns=["date", "he", "tech", "state", "lsl", "out"])
        d = d[d["state"].astype(str).isin(["m", "a"]) & d["tech"].astype(str).isin(TECHS)]
        d = d.assign(tech=d["tech"].astype(str), date=d["date"].astype(str), he=d["he"].astype(int))
        d["mw"] = np.where(d["tech"] == "nuclear", d["out"], d["lsl"])
        parts.append(d.groupby(["date", "he", "tech"])["mw"].sum().reset_index())
        last = max(last, p.stem[8:])
    return (pd.concat(parts) if parts else pd.DataFrame(columns=["date", "he", "tech", "mw"])), last


def _unit_file_hours(after_month):
    """Hourly MW by technology from data/60d-units for days in months after `after_month`."""
    rows = []
    for p in sorted((DATA_DIR / "60d-units").glob("*.json.gz")):
        day = p.name[:10]
        if day[:7] <= after_month:
            continue
        j = read_json_gz(p, default=None) or {}
        cols = j.get("columns") or []
        if not {"online_share", "lsl", "output"} <= set(cols):
            continue
        ix = {c: cols.index(c) + 2 for c in ("online_share", "ramp_share", "lsl", "output") if c in cols}
        tech = [u[2] for u in j.get("units") or []]
        for r in j.get("rows") or []:
            t = tech[r[0]]
            if t not in TECHS:
                continue
            on = (r[ix["online_share"]] or 0) - ((r[ix["ramp_share"]] or 0) if "ramp_share" in ix else 0)
            mw = r[ix["output"]] if t == "nuclear" else r[ix["lsl"]]
            on = min(max(on, 0.0), 1.0)
            if on > 0 and mw is not None:
                rows.append((day, int(r[1]), t, float(mw) * on))
    return pd.DataFrame(rows, columns=["date", "he", "tech", "mw"])


def daily_rows(h):
    """[[COLUMNS...]] per day from hourly MW by technology."""
    if not len(h):
        return []
    P = h.pivot_table(index=["date", "he"], columns="tech", values="mw", aggfunc="sum").reindex(columns=TECHS).fillna(0.0)
    P["all"] = P[TECHS].sum(axis=1)
    P["fos"] = P[FOSSIL].sum(axis=1)
    out = []
    for day, g in P.groupby(level="date"):
        ga = g[g["all"] >= LOW_SHARE * g["all"].median()]
        gf = g[g["fos"] >= LOW_SHARE * g["fos"].median()]
        if len(ga) < MIN_HOURS or len(gf) < MIN_HOURS:
            continue
        a, f = ga["all"].idxmin(), gf["fos"].idxmin()
        out.append([day, int(a[1]), *[round(float(ga.at[a, t])) for t in TECHS],
                    int(f[1]), *[round(float(gf.at[f, t])) for t in FOSSIL]])
    return out


def build(full=False):
    hist = {} if full else (read_json_gz(HIST_PATH, default=None) or {})
    if full:
        h, therm_last = _history_hours()
        if not len(h):
            warn("lsl_floor --full: no thermal history months on hand; file left as it is")
            return False
        rows = {r[0]: r for r in daily_rows(h)}
    else:
        therm_last = hist.get("therm_last", "")
        rows = {r[0]: r for r in hist.get("rows") or []}
        rows.update({r[0]: r for r in daily_rows(_unit_file_hours(therm_last))})
    if not rows:
        warn("lsl_floor: no days built; file left as it is")
        return False
    days = sorted(rows)
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "from": days[0], "through": days[-1], "therm_last": therm_last,
           "columns": COLUMNS, "rows": [rows[d] for d in days]}
    write_json_gz(HIST_PATH if full else PATH, out)
    print(f"lsl_floor{' --full' if full else ''}: {len(days)} days, {days[0]} to {days[-1]} (history to {therm_last or 'none'})", flush=True)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--full", action="store_true", help="rebuild every day from the thermal history months in HISTORY_DIR")
    a = ap.parse_args(argv)
    return 0 if build(full=a.full) else 1


if __name__ == "__main__":
    sys.exit(main())
