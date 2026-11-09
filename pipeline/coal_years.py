"""The coal Unit page's "Year by year: how it spent the year" panel: for each coal unit and calendar
year from 2019, hours online, offline by choice and on outage, and the cheap hours (day-ahead system
lambda at or below CHEAP) it was available for and online in.  Writes data/coal_years.json.gz.

States are the hourly ones data/unit_hours_60d.json.gz writes (intraday.unit_hours): "m" and "a"
online, "0" offline, "o" on outage (ERCOT status OUT, which is how most seasonal layups are filed),
"-" no data (not counted).  A cheap hour counts as available when the unit is not on outage.

Inputs (no ERCOT download; both are already on hand):
  history release thermal-YYYY-MM.parquet, da-lambda-YYYY-MM.parquet   (to Nov 2025)
  data/unit_hours_60d.json.gz, data/dam_lambda.json.gz                 days after the last thermal month

Two files, one writer each, as pipeline/lsl_floor.py: the Goal workflow runs `--full` over the
history release into coal_years_hist.json.gz; the update run starts from that file and adds the
60-day days after its last thermal month, into coal_years.json.gz, which the page reads.

    python -m pipeline.coal_years --full   # the Goal workflow (needs the history months in HISTORY_DIR)
    python -m pipeline.coal_years          # the update run

File:
  {"built", "through", "therm_last", "cheap", "columns": COLUMNS, "rows": [[...], ...]}
  one row per unit and year; counts are hours
"""
import argparse
import datetime as dt
import sys
from collections import defaultdict

import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "coal_years.json.gz"            # the page reads this one (update run)
HIST_PATH = DATA_DIR / "coal_years_hist.json.gz"  # 2019 on from the history release (Goal workflow --full)
CHEAP = 10.0        # $/MWh, day-ahead system lambda: the site's cheap-hour cut
COLUMNS = ["unit", "year", "hours", "on", "off", "out", "cheap_avail", "cheap_on"]


def _add(acc, unit, year, state, cheap):
    a = acc[(unit, year)]
    a[0] += 1
    if state in ("m", "a"):
        a[1] += 1
    elif state == "o":
        a[3] += 1
    else:
        a[2] += 1
    if cheap and state != "o":
        a[4] += 1
        if state in ("m", "a"):
            a[5] += 1


def _history(acc):
    """Counts from the history months into acc; returns (last thermal month YYYY-MM, last day), or ("", "")."""
    lam = [pd.read_parquet(p, columns=["date", "he", "price"]) for p in sorted(HISTORY_DIR.glob("da-lambda-*.parquet"))]
    if not lam:
        return "", ""
    lam = pd.concat(lam).assign(date=lambda d: d["date"].astype(str), he=lambda d: d["he"].astype(int))
    last, day = "", ""
    for p in sorted(HISTORY_DIR.glob("thermal-*.parquet")):
        d = pd.read_parquet(p, columns=["date", "he", "unit", "tech", "state"])
        d = d[d["tech"].astype(str) == "coal"]
        d = d.assign(unit=d["unit"].astype(str), state=d["state"].astype(str), date=d["date"].astype(str), he=d["he"].astype(int))
        d = d[d["state"] != "-"].merge(lam, on=["date", "he"], how="left")
        d["cheap"] = d["price"] <= CHEAP
        d["year"] = d["date"].str[:4].astype(int)
        g = d.groupby(["unit", "year"])
        for (u, y), r in g:
            on = r["state"].isin(["m", "a"])
            out = r["state"] == "o"
            av = r["cheap"] & ~out
            a = acc[(u, int(y))]
            a[0] += len(r)
            a[1] += int(on.sum())
            a[2] += int((~on & ~out).sum())
            a[3] += int(out.sum())
            a[4] += int(av.sum())
            a[5] += int((av & on).sum())
        last = max(last, p.stem[8:])
        if len(d):
            day = max(day, d["date"].max())
    return last, day


def _recent(acc, after_month):
    """Counts from data/unit_hours_60d.json.gz for days in months after `after_month`; the last day."""
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default=None) or {}
    lam = (read_json_gz(DATA_DIR / "dam_lambda.json.gz", default=None) or {}).get("days") or {}
    ix = read_json_gz(DATA_DIR / "unit_index.json.gz", default=None) or {}
    cols = ix.get("columns") or []
    if "unit" not in cols or "tech" not in cols:
        warn("coal_years: unit_index.json.gz has no unit/tech columns; recent days skipped")
        return ""
    cu, ct = cols.index("unit"), cols.index("tech")
    coal = {r[cu] for r in ix.get("rows") or [] if r[ct] == "coal"}
    dates, units = uh.get("dates") or [], uh.get("units") or {}
    through = ""
    for u, s in units.items():
        if u not in coal:
            continue
        for i, day in enumerate(dates):
            if day[:7] <= after_month:
                continue
            L = lam.get(day) or []
            for h in range(24):
                c = s[24 * i + h] if 24 * i + h < len(s) else "-"
                if c == "-":
                    continue
                p = L[h] if h < len(L) else None
                _add(acc, u, int(day[:4]), c, p is not None and p <= CHEAP)
                through = max(through, day)
    return through


def build(full=False):
    acc = defaultdict(lambda: [0] * 6)
    if full:
        therm_last, through = _history(acc)
        if not acc:
            warn("coal_years --full: no thermal history months on hand; file left as it is")
            return False
    else:
        hist = read_json_gz(HIST_PATH, default=None) or {}
        therm_last = hist.get("therm_last", "")
        for r in hist.get("rows") or []:
            acc[(r[0], r[1])] = list(r[2:])
        through = _recent(acc, therm_last) or hist.get("through", "")
    if not acc:
        warn("coal_years: no unit-years built; file left as it is")
        return False
    rows = [[u, y, *v] for (u, y), v in sorted(acc.items()) if v[0]]
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "through": through,
           "therm_last": therm_last, "cheap": CHEAP, "columns": COLUMNS, "rows": rows}
    write_json_gz(HIST_PATH if full else PATH, out)
    print(f"coal_years{' --full' if full else ''}: {len({r[0] for r in rows})} units, {len(rows)} unit-years, through {through or 'none'} (history to {therm_last or 'none'})", flush=True)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--full", action="store_true", help="rebuild every year from the history months in HISTORY_DIR")
    a = ap.parse_args(argv)
    return 0 if build(full=a.full) else 1


if __name__ == "__main__":
    sys.exit(main())
