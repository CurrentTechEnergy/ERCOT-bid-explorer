"""The combustion turbine Unit page's "Year by year: the prices it ran at" chart: for each CT and
calendar year from 2019, percentiles of the day-ahead price at its node over the hours it was
online, divided by that day's Houston Ship Channel gas price (an implied heat rate, MMBtu/MWh: the
heat rate a gas unit would need to break even).  Dividing by gas lets years with different gas
prices compare.  Writes data/ct_years.json.gz.

Online is state "m" or "a" in the hourly states data/unit_hours_60d.json.gz writes
(intraday.unit_hours).  Gas is prices_years.gas_daily, the series the Prices page divides by.

Inputs (no ERCOT download; all already on hand):
  history release thermal-YYYY-MM.parquet          state, da_node (to Nov 2025)
  data/unit_hours_60d.json.gz, data/dam/{date}.json.gz (spp)   days after the last thermal month

Percentiles do not add up across the two sources, so each unit-year is kept as a histogram of the
implied heat rate in BIN steps (clipped to LO..HI): the Goal workflow's `--full` writes the
history months' histograms to ct_years_hist.json.gz; the update run adds the 60-day days and
writes the percentiles the page reads to ct_years.json.gz.

    python -m pipeline.ct_years --full   # the Goal workflow (needs the thermal months in HISTORY_DIR)
    python -m pipeline.ct_years          # the update run

Page file:
  {"built", "through", "therm_last", "gas", "columns": COLUMNS, "rows": [[...], ...]}
  one row per unit and year: hours online with a price, then p10, p25, p50, p75, p90 (MMBtu/MWh)
"""
import argparse
import datetime as dt
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .log import warn
from .prices_years import gas_daily
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "ct_years.json.gz"            # the page reads this one (update run)
HIST_PATH = DATA_DIR / "ct_years_hist.json.gz"  # histograms from the history release (Goal workflow --full)
BIN, LO, HI = 0.25, -10.0, 40.0                  # MMBtu/MWh
NBIN = int(round((HI - LO) / BIN))
QS = [0.1, 0.25, 0.5, 0.75, 0.9]
COLUMNS = ["unit", "year", "hours", "p10", "p25", "p50", "p75", "p90"]


def _bins(ihr):
    return np.clip(((np.asarray(ihr, float) - LO) / BIN).astype(int), 0, NBIN - 1)


def _history(acc, gas):
    last, day = "", ""
    for p in sorted(HISTORY_DIR.glob("thermal-*.parquet")):
        d = pd.read_parquet(p, columns=["date", "unit", "tech", "state", "da_node"])
        d = d[(d["tech"].astype(str) == "combustion_turbine") & d["state"].astype(str).isin(["m", "a"])].dropna(subset=["da_node"])
        d = d.assign(unit=d["unit"].astype(str), date=d["date"].astype(str))
        g = d["date"].map(gas)
        d = d[g.notna() & (g > 0)]
        d = d.assign(b=_bins(d["da_node"].to_numpy() / d["date"].map(gas).to_numpy()), year=d["date"].str[:4].astype(int))
        for (u, y, b), n in d.groupby(["unit", "year", "b"]).size().items():
            acc[(u, int(y))][int(b)] += int(n)
        last = max(last, p.stem[8:])
        if len(d):
            day = max(day, d["date"].max())
    return last, day


def _recent(acc, gas, after_month):
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default=None) or {}
    ix = read_json_gz(DATA_DIR / "unit_index.json.gz", default=None) or {}
    cols = ix.get("columns") or []
    if "unit" not in cols or "tech" not in cols:
        warn("ct_years: unit_index.json.gz has no unit/tech columns; recent days skipped")
        return ""
    cu, ct = cols.index("unit"), cols.index("tech")
    cts = {r[cu] for r in ix.get("rows") or [] if r[ct] == "combustion_turbine"}
    dates, states = uh.get("dates") or [], uh.get("units") or {}
    through = ""
    for i, day in enumerate(dates):
        if day[:7] <= after_month or not (gas.get(day) or 0) > 0:
            continue
        dam = read_json_gz(DATA_DIR / "dam" / f"{day}.json.gz", default=None) or {}
        du = dam.get("units") or {}
        for u in cts:
            s, spp = states.get(u), (du.get(u) or {}).get("spp")
            if not s or not spp:
                continue
            for h in range(24):
                c = s[24 * i + h] if 24 * i + h < len(s) else "-"
                p = spp[h] if h < len(spp) else None
                if c in ("m", "a") and p is not None:
                    acc[(u, int(day[:4]))][int(_bins([p / gas[day]])[0])] += 1
                    through = max(through, day)
    return through


def _pct(h):
    """Percentiles from a {bin: count} histogram, at bin midpoints."""
    ks = sorted(h)
    n = np.array([h[k] for k in ks], float)
    c = np.cumsum(n) / n.sum()
    mid = LO + (np.array(ks) + 0.5) * BIN
    return [round(float(mid[np.searchsorted(c, q)]), 2) for q in QS]


def build(full=False):
    last_day = dt.date.today().isoformat()
    g, _ = gas_daily(last_day)
    gas = {k: float(v) for k, v in g.dropna().items()}
    acc = defaultdict(lambda: defaultdict(int))
    if full:
        therm_last, through = _history(acc, gas)
        if not acc:
            warn("ct_years --full: no thermal history months on hand; file left as it is")
            return False
        out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "through": through,
               "therm_last": therm_last, "bin": BIN, "lo": LO,
               "hist": [[u, y, {str(b): n for b, n in sorted(h.items())}] for (u, y), h in sorted(acc.items())]}
        write_json_gz(HIST_PATH, out)
        print(f"ct_years --full: {len(out['hist'])} unit-years, through {through} (history to {therm_last})", flush=True)
        return True
    hist = read_json_gz(HIST_PATH, default=None) or {}
    therm_last = hist.get("therm_last", "")
    for u, y, h in hist.get("hist") or []:
        for b, n in h.items():
            acc[(u, y)][int(b)] += n
    through = _recent(acc, gas, therm_last) or hist.get("through", "")
    if not acc:
        warn("ct_years: no unit-years built; file left as it is")
        return False
    rows = [[u, y, int(sum(h.values())), *_pct(h)] for (u, y), h in sorted(acc.items()) if sum(h.values())]
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "through": through,
           "therm_last": therm_last, "gas": "Houston Ship Channel", "columns": COLUMNS, "rows": rows}
    write_json_gz(PATH, out)
    print(f"ct_years: {len({r[0] for r in rows})} units, {len(rows)} unit-years, through {through or 'none'} (history to {therm_last or 'none'})", flush=True)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--full", action="store_true", help="rebuild the history months' histograms from HISTORY_DIR")
    a = ap.parse_args(argv)
    return 0 if build(full=a.full) else 1


if __name__ == "__main__":
    sys.exit(main())
