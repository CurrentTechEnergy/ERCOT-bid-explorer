"""The Prices page's data: ERCOT hub prices by year from 2019, for whether the highest and lowest
prices are compressing as batteries grow.  Writes data/prices_years.json.gz.

Inputs (no ERCOT download; everything is already in the repository or on the `history` release):
  real-time hub prices   history release rt-prices-YYYY-MM (hub rows, hourly means of the 15-minute
                         prices), else data/summary_prices.json.gz (Nov 30, 2025 on)
  day-ahead hub prices   history release da-hubs-YYYY-MM, else data/dam_hubs.json.gz
  gas                    Houston Ship Channel: the 7-day average the site already publishes
                         (data/gas_hub_avg.json.gz, gas.write_hub_averages), carried over weekends
                         for up to 4 days; on days with none (before Jul 15, 2019, most of Jun 2024
                         to Aug 2025) Henry Hub (gas_history.json.gz, gas.json.gz) plus that
                         calendar month's median Ship Channel basis.  The daily Ship Channel prices
                         are licensed (pipeline/private.py) and never reach the file: only yearly
                         and monthly means and price divided by gas do.
  riding through         combined-cycle and gas steam LSL online (state m/a) from the history
                         release's thermal-YYYY-MM files, then data/60d-units (online_share x lsl)
                         for days after the last thermal month
  battery capacity       pipeline/reference/battery_capacity.csv (CDR year ends), and for the latest
                         year the site's battery HSL total on the latest day of storage/units.json.gz

Two files, one writer each.  The weekly Goal workflow downloads the real-time months and runs
`--full`: every year and month from the history release, into prices_years_hist.json.gz, and it
moves the "same months" cut ("ytd": January to the last complete month) forward.  The update run
starts from that file and adds what it lacks (the latest year, and any year it has no entry for)
plus the ride-through months of the 60-day unit files, into prices_years.json.gz, which the page
reads.  A past year with too few hours on hand is left out with a warning.

    python -m pipeline.prices_years --full   # the Goal workflow (needs the rt-prices and thermal months)
    python -m pipeline.prices_years          # the update run

File:
  {"built", "through": {"rt", "da"}, "years": [2019, ...], "ytd_month": 10,
   "x": [exceedance %, ...],
   "data": {"<rt|da>|<hub>|<full|ytd>|<usd|hr>": {"<year>": {
       "curve": [price at each x], "n", "mean", "p50", "p1", "p5", "p95", "p99", "sp_mean", "sp_med",
       "hod_p50", "hod_mean", "hod_p95", "hod_p05" (24 each, hour ending 1..24), "gas",
       "cnt": {"ge1000", "ge500", "ge100", "le10", "le0", "len20"} (usd only), "from", "to"}}},
   "gas": {"<year>": {"mean", "filled"}},   filled = share of days on Henry Hub plus basis
   "ride": {"columns": ["ym", "gas", "cheap_h", "lsl_cheap", "lsl_other"], "rows": [...]},
   "therm_last": last thermal history month (later ride months come from the 60-day unit files),
   "battery": {"<year>": {"mw", "source"}}}
"usd" is $/MWh, "hr" is price divided by the day's gas price (MMBtu/MWh).  Cheap hours for riding
through are real-time Hub average at or below CHEAP ($/MWh); LSL in MW, means over the hours.
"""
import argparse
import calendar
import csv
import datetime as dt
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR, HISTORY_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "prices_years.json.gz"            # the page reads this one (update run)
HIST_PATH = DATA_DIR / "prices_years_hist.json.gz"  # every year, from the Goal workflow's --full
BATTERY_REF = Path(__file__).parent / "reference" / "battery_capacity.csv"
HUBS = ["HB_HUBAVG", "HB_NORTH", "HB_WEST", "HB_HOUSTON", "HB_SOUTH"]
FIRST_YEAR = 2019
CHEAP = 10.0            # $/MWh, the site's cheap-hour cut
GAS_TECHS = ("combined_cycle", "gas_steam")
COVER = 0.98            # a past year is rebuilt only with this share of its hours on hand
X = sorted(set([0, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 9]
               + list(range(10, 91, 2))
               + [91, 92, 93, 94, 95, 96, 97, 97.5, 98, 98.5, 99, 99.3, 99.5, 99.7, 99.8, 99.9, 99.95, 99.98, 100]))
COUNTS = (("ge1000", lambda p: p >= 1000), ("ge500", lambda p: p >= 500), ("ge100", lambda p: p >= 100),
          ("le10", lambda p: p <= 10), ("le0", lambda p: p <= 0), ("len20", lambda p: p <= -20))
r2 = lambda v: None if v is None or not np.isfinite(v) else round(float(v), 2)


# ------------------------------------------------------------------ inputs --
def _months(first, last):
    y, m = first
    while (y, m) <= last:
        yield f"{y}-{m:02d}"
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def hub_hours(market):
    """Hourly hub prices for one market: DataFrame date, he, point, price (2019 on)."""
    parts, have = [], set()
    kind = "rt-prices" if market == "rt" else "da-hubs"
    for p in sorted(HISTORY_DIR.glob(f"{kind}-*.parquet")):
        d = pd.read_parquet(p, columns=["date", "he", "point", "price"])
        d = d[d["point"].astype(str).isin(HUBS)].copy()
        d["point"] = d["point"].astype(str)
        parts.append(d)
        have.add(p.stem[len(kind) + 1:])
    rows = []
    if market == "rt":
        for day, v in (read_json_gz(DATA_DIR / "summary_prices.json.gz", default={}) or {}).items():
            if day[:7] in have or not isinstance(v, dict):
                continue
            for pt in HUBS:
                rows += [(day, h + 1, pt, x) for h, x in enumerate((v.get("spp") or {}).get(pt) or []) if x is not None and h < 24]
    else:
        for day, v in ((read_json_gz(DATA_DIR / "dam_hubs.json.gz", default={}) or {}).get("days") or {}).items():
            if day[:7] in have:
                continue
            for pt in HUBS:
                rows += [(day, h + 1, pt, x) for h, x in enumerate(v.get(pt) or []) if x is not None and h < 24]
    if rows:
        parts.append(pd.DataFrame(rows, columns=["date", "he", "point", "price"]))
    if not parts:
        return pd.DataFrame(columns=["date", "he", "point", "price"])
    d = pd.concat(parts, ignore_index=True)
    d["date"] = d["date"].astype(str)
    d["he"] = d["he"].astype(int)
    d["price"] = d["price"].astype(float)
    d = d.dropna(subset=["price"])
    d = d[d["date"] >= f"{FIRST_YEAR}-01-01"].drop_duplicates(["date", "he", "point"], keep="last")
    return d


def gas_daily(last_day):
    """{date: $/MMBtu} Ship Channel (published 7-day mean) else Henry Hub plus the calendar month's
    median basis, every calendar day from Dec 2018 to last_day; and {date: True} where filled."""
    cal = pd.date_range("2018-12-01", last_day).strftime("%Y-%m-%d")
    hh = pd.Series(dtype=float)
    for name, key in (("gas_history.json.gz", "henry_hub"), ("gas.json.gz", None)):
        g = read_json_gz(DATA_DIR / name, default={}) or {}
        g = g.get(key, {}) if key else g
        if g.get("dates"):
            hh = pd.concat([hh, pd.Series(g["value"], index=g["dates"], dtype=float)])
    hh = hh[~hh.index.duplicated(keep="last")].sort_index().reindex(cal).ffill().bfill()
    ha = (((read_json_gz(DATA_DIR / "gas_hub_avg.json.gz", default={}) or {}).get("hubs") or {}).get("hsc") or {})
    hsc = pd.Series(ha.get("value") or [], index=ha.get("dates") or [], dtype=float).reindex(cal)
    mo = pd.Series(cal.str[5:7], index=cal)
    basis = (hsc - hh).groupby(mo).median().reindex(mo.unique()).fillna(0.0)
    carried = hsc.ffill(limit=4)
    gas = carried.fillna(hh + mo.map(basis))
    return gas, carried.isna()


def battery_mw():
    out = {}
    if BATTERY_REF.exists():
        with open(BATTERY_REF, newline="") as f:
            for r in csv.DictReader(f):
                out[r["year"]] = {"mw": float(r["mw"]), "source": r["source"]}
    su = read_json_gz(DATA_DIR / "storage" / "units.json.gz", default=None) or {}
    dates = su.get("dates") or []
    if dates:
        tot = np.zeros(len(dates))
        for r in (su.get("units") or {}).values():
            tot += np.array([v or 0 for v in r.get("hsl", [])] + [0] * (len(dates) - len(r.get("hsl", []))))[:len(dates)]
        i = max(k for k in range(len(dates)) if tot[k] > 0) if tot.any() else None
        if i is not None and dates[i][:4] not in out:
            out[dates[i][:4]] = {"mw": round(float(tot[i])), "source": f"Battery HSL total on {dates[i]} (60-day SCED disclosure)"}
    return out


# ------------------------------------------------------------------- stats --
def year_stats(v, col, unit):
    p = v[col].to_numpy(dtype=float)
    p = p[np.isfinite(p)]
    if not len(p):
        return None
    dd = v.groupby("date")[col].agg(["max", "min"])
    sp = (dd["max"] - dd["min"]).to_numpy()
    hod = v.groupby("he")[col]
    hrs = range(1, 25)
    out = {"curve": [r2(np.percentile(p, 100 - q)) for q in X], "n": int(len(p)),
           "mean": r2(p.mean()), "p50": r2(np.median(p)), "p1": r2(np.percentile(p, 1)), "p5": r2(np.percentile(p, 5)),
           "p95": r2(np.percentile(p, 95)), "p99": r2(np.percentile(p, 99)),
           "sp_mean": r2(np.nanmean(sp)), "sp_med": r2(np.nanmedian(sp)),
           "hod_p50": [r2(z) for z in hod.median().reindex(hrs).to_numpy()],
           "hod_mean": [r2(z) for z in hod.mean().reindex(hrs).to_numpy()],
           "hod_p95": [r2(z) for z in hod.quantile(.95).reindex(hrs).to_numpy()],
           "hod_p05": [r2(z) for z in hod.quantile(.05).reindex(hrs).to_numpy()],
           "gas": r2(v.groupby("date")["gas"].first().mean()),
           "from": str(v["date"].min()), "to": str(v["date"].max())}
    if unit == "usd":
        out["cnt"] = {k: int(f(p).sum()) for k, f in COUNTS}
    return out


def expected_hours(year, to=None, ytd_month=None):
    """Hours from Jan 1 to `to` (or the year's end, or the end of ytd_month)."""
    end = dt.date(year, 12, 31)
    if ytd_month:
        end = dt.date(year, ytd_month, calendar.monthrange(year, ytd_month)[1])
    if to:
        end = min(end, dt.date.fromisoformat(to))
    return ((end - dt.date(year, 1, 1)).days + 1) * 24


def ride_rows(rt_hub, gas, therm_last=None):
    """{ym: [ym, gas, cheap_h, lsl_cheap, lsl_other]} for every month whose inputs are on hand for at
    least 90% of its days (so a stored row is always a whole month, and is kept when a later run
    lacks the month's inputs)."""
    cheap = {(d, h): p <= CHEAP for d, h, p in rt_hub[["date", "he", "price"]].itertuples(index=False)}
    rt_days = set(rt_hub["date"])
    lsl = {}                                           # (date, he) -> gas LSL online, MW
    files = [] if therm_last is not None else sorted(HISTORY_DIR.glob("thermal-*.parquet"))
    therm_last = therm_last or ""
    for p in files:
        d = pd.read_parquet(p, columns=["date", "he", "tech", "state", "lsl"])
        d = d[d["tech"].astype(str).isin(GAS_TECHS) & d["state"].astype(str).isin(["m", "a"])]
        for (day, he), v in d.groupby(["date", "he"], observed=True)["lsl"].sum().items():
            lsl[(str(day), int(he))] = float(v)
        therm_last = max(therm_last, p.stem[8:])
    units_dir = DATA_DIR / "60d-units"
    for p in sorted(units_dir.glob("*.json.gz")):
        day = p.name[:10]
        if day[:7] <= therm_last:
            continue
        j = read_json_gz(p, default=None) or {}
        cols = j.get("columns") or []
        if not {"online_share", "lsl"} <= set(cols):
            continue
        io, il = cols.index("online_share") + 2, cols.index("lsl") + 2
        gas_units = {i for i, u in enumerate(j.get("units") or []) if u[2] in GAS_TECHS}
        acc = {}
        for r in j.get("rows") or []:
            if r[0] in gas_units and r[io] and r[il]:
                acc[r[1]] = acc.get(r[1], 0.0) + r[io] * r[il]
        for he in range(1, 25):
            lsl[(day, he)] = acc.get(he, 0.0)
    by = {}
    for (day, he), mw in lsl.items():
        if day not in rt_days or (day, he) not in cheap:
            continue
        ym = day[:7]
        b = by.setdefault(ym, [0, 0.0, 0, 0.0, set()])
        if cheap[(day, he)]:
            b[0] += 1; b[1] += mw
        else:
            b[2] += 1; b[3] += mw
        b[4].add(day)
    out = {}
    for ym, (nc, sc, no, so, days) in by.items():
        y, m = int(ym[:4]), int(ym[5:])
        if len(days) < calendar.monthrange(y, m)[1] * 0.9:
            continue      # a month mostly missing (the end of the 60-day record): left out until it fills
        g = gas[gas.index.str[:7] == ym]
        out[ym] = [ym, r2(g.mean()), nc, r2(sc / nc) if nc else None, r2(so / no) if no else None]
    return out, therm_last


# ------------------------------------------------------------------- build --
def build(full=False):
    """full: every year and month from the history release, written to HIST_PATH (the Goal
    workflow's file).  Otherwise: the years and months HIST_PATH lacks, plus the latest year and
    the 60-day months, over HIST_PATH, written to PATH (the update run's file).  Each file has
    one writer, so the two workflows never collide on a commit."""
    hist = read_json_gz(HIST_PATH, default=None) or {}
    today = dt.date.today()
    markets = {m: hub_hours(m) for m in ("rt", "da")}
    last = max((d["date"].max() for d in markets.values() if len(d)), default=None)
    if last is None:
        warn("prices_years: no hub prices on hand; file left as it is")
        return False
    gas, filled = gas_daily(max(last, today.isoformat()))
    latest_year = int(last[:4])
    ytd_month = hist.get("ytd_month")
    if full or not ytd_month:
        d = dt.date.fromisoformat(markets["rt"]["date"].max() if len(markets["rt"]) else last)
        ytd_month = d.month if d.day == calendar.monthrange(d.year, d.month)[1] else max(1, d.month - 1)
    data = {} if full else {k: dict(v) for k, v in (hist.get("data") or {}).items()}
    years = list(range(FIRST_YEAR, latest_year + 1))
    rebuilt, skipped = [], []
    for m, d in markets.items():
        if not len(d):
            continue
        d = d.copy()
        d["year"] = d["date"].str[:4].astype(int)
        d["gas"] = gas.reindex(d["date"]).to_numpy()
        d["hr"] = d["price"] / d["gas"]
        for y in years:
            current = y == latest_year
            v_all = d[d["year"] == y]
            for per in ("full", "ytd"):
                have = all(str(y) in (data.get(f"{m}|{h}|{per}|usd") or {}) for h in HUBS)
                if not full and have and not current:
                    continue                     # a past year the Goal workflow built
                need = expected_hours(y, to=last if current else None, ytd_month=ytd_month if per == "ytd" else None)
                v_per = v_all if per == "full" else v_all[v_all["date"].str[5:7].astype(int) <= ytd_month]
                n_per = int((v_per["point"] == "HB_HUBAVG").sum())
                if not n_per or (not current and n_per < COVER * need):
                    if n_per or full:
                        skipped.append(f"{m} {y} {per} ({n_per} of {need} hours)")
                    continue
                for hub in HUBS:
                    v = v_per[v_per["point"] == hub]
                    for unit, col in (("usd", "price"), ("hr", "hr")):
                        s = year_stats(v, col, unit)
                        if s:
                            data.setdefault(f"{m}|{hub}|{per}|{unit}", {})[str(y)] = s
                rebuilt.append(f"{m} {y} {per}")
    rt_hub = markets["rt"][markets["rt"]["point"] == "HB_HUBAVG"]
    ride = {} if full else {r[0]: r for r in ((hist.get("ride") or {}).get("rows") or [])}
    new, therm_last = ride_rows(rt_hub, gas, therm_last=None if full else hist.get("therm_last", ""))
    ride.update(new)
    gy = {}
    for y in years:
        idx = (gas.index.str[:4] == str(y)) & (gas.index <= last)
        if idx.any():
            gy[str(y)] = {"mean": r2(gas[idx].mean()), "filled": r2(filled[idx].mean())}
    through = {m: (str(d["date"].max()) if len(d) else None) for m, d in markets.items()}
    for m in ("rt", "da"):
        if (hist.get("through") or {}).get(m) and (through[m] or "") < hist["through"][m]:
            through[m] = hist["through"][m]
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "through": through, "years": years, "ytd_month": ytd_month, "x": X, "hubs": HUBS, "cheap": CHEAP,
           "therm_last": therm_last,
           "data": {k: dict(sorted(v.items())) for k, v in sorted(data.items())},
           "gas": gy, "battery": battery_mw(),
           "ride": {"columns": ["ym", "gas", "cheap_h", "lsl_cheap", "lsl_other"], "rows": [ride[k] for k in sorted(ride)]}}
    write_json_gz(HIST_PATH if full else PATH, out)
    print(f"prices_years{' --full' if full else ''}: built {len(rebuilt)} market-year-periods; "
          f"{len(out['ride']['rows'])} ride-through months; ytd through month {ytd_month}", flush=True)
    for k in skipped:
        warn(f"prices_years: too few hours to build {k}")
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--full", action="store_true", help="rebuild every year (needs the rt-prices months in HISTORY_DIR) and move the ytd cut")
    a = ap.parse_args(argv)
    return 0 if build(full=a.full) else 1


if __name__ == "__main__":
    sys.exit(main())
