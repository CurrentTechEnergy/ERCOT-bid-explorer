"""Wind and solar across the years: fleet size, energy, curtailment, the price they captured and
how much of their output landed in hours priced at $0 or below.  Read by the Renewables page's
"Across the years" panel.  Needs no ERCOT downloads:
  - monthly, from Jan 2019: the wind and solar months of the hourly history (units-YYYY-MM.parquet
    on the `history` release, pipeline/history.py), fetched from the release with the gh CLI
  - daily, from the series month files (data/series/YYYY-MM/{wind,solar}.json.gz, pipeline/series.py),
    which also give each month they cover completely (Dec 2025 on): the history misses a day or
    two in a few months, so a history month short of days has its energy scaled up to the month

Per technology and period:
  gw          fleet size: each unit's highest hourly HSL summed (monthly: over the month; daily: over
              the 30 days ending that day, so a calm day doesn't shrink the fleet; null for the
              first 29 days), GW
  units       units with any HSL in the period (that 30-day window, daily)
  gen         energy generated (telemetered output), GWh
  curt        curtailed: HSL above base point, summed over hours, GWh
              (a history month missing days: both scaled by days in the month / days loaded)
  capture     output-weighted DA price at each unit's settlement point, $/MWh
  avg         plain average DA price over the same unit-hours, $/MWh (capture / avg is the capture rate)
  neg         share of output in hours whose DA price at the unit's settlement point was $0 or below

data/renewables/years.json.gz
  {"format", "months": [YYYY-MM], "monthly": {tech: {field: [month]}}, "monthly_source": [month]
   ("h" history, "s" series), "dates": [YYYY-MM-DD], "daily": {tech: {field: [day]}}}
Monthly summaries from the history are cached on the data branch under renew_years/, keyed on the
release asset's id and size, so a run only fetches months that are new or rebuilt.

  python -m pipeline.renew_years
"""
import calendar
import json
import os
import subprocess
from pathlib import Path

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

FORMAT = 2
PATH = DATA_DIR / "renewables" / "years.json.gz"
CACHE = UNIT_DATA_DIR / "renew_years"
HISTORY = Path("history")
TECHS = ("wind", "solar")
FIELDS = ["gw", "units", "gen", "curt", "capture", "avg", "neg"]
WINDOW = 30
REPO = os.environ.get("GITHUB_REPOSITORY", "CurrentTechEnergy/ERCOT-bid-explorer")


def summarize(units: dict, cap: dict) -> dict:
    """{unit: (hsl, bp, out, da) arrays over the period's hours}, {unit: fleet-size MW} -> FIELDS."""
    gen = curt = wsum = psum = neg = 0.0
    for hsl, bp, out, da in units.values():
        o = np.clip(np.nan_to_num(out), 0, None)
        curt += np.nansum(np.clip(hsl - bp, 0, None))
        gen += o.sum()
        ok = np.isfinite(da)
        wsum += o[ok].sum()
        psum += (o[ok] * da[ok]).sum()
        neg += o[ok & (da <= 0)].sum()
    allp = np.concatenate([u[3][np.isfinite(u[3])] for u in units.values()]) if units else np.array([])
    return {"gw": round(sum(cap.values()) / 1e3, 3), "units": sum(1 for v in cap.values() if v > 0),
            "gen": round(gen / 1e3, 1), "curt": round(curt / 1e3, 1),
            "capture": round(psum / wsum, 2) if wsum else None,
            "avg": round(float(allp.mean()), 2) if len(allp) else None,
            "neg": round(neg / wsum, 4) if wsum else None}


def _month_from_parquet(path: Path, month: str) -> dict:
    import pandas as pd
    d = pd.read_parquet(path, columns=["date", "unit", "tech", "hsl", "bp", "out", "da_node"])
    y, m = map(int, month.split("-"))
    scale = calendar.monthrange(y, m)[1] / max(d.date.nunique(), 1)
    out = {}
    for t in TECHS:
        g = d[d.tech == t]
        units = {u: tuple(x[c].to_numpy(float) for c in ("hsl", "bp", "out", "da_node")) for u, x in g.groupby("unit")}
        cap = {u: float(np.nanmax(v[0])) if np.isfinite(v[0]).any() else 0.0 for u, v in units.items()}
        out[t] = summarize(units, cap)
        out[t]["gen"], out[t]["curt"] = round(out[t]["gen"] * scale, 1), round(out[t]["curt"] * scale, 1)
    return out


def _gh(*args) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def history_months() -> dict:
    """{YYYY-MM: {tech: FIELDS}} from the history release's units months (cached)."""
    try:
        assets = json.loads(_gh("api", f"repos/{REPO}/releases/tags/history", "--jq",
                                '[.assets[] | select(.name | test("^units-[0-9]{4}-[0-9]{2}\\\\.parquet$")) | {id, name, size}]'))
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        warn(f"renew_years: can't list the history release ({e}); using cached months only")
        assets = None
    out = {}
    if assets is None:
        for p in sorted(CACHE.glob("*.json.gz")):
            c = read_json_gz(p) or {}
            if c.get("format") == FORMAT:
                out[c["month"]] = c["techs"]
        return out
    for a in sorted(assets, key=lambda a: a["name"]):
        month, key = a["name"][6:13], [a["id"], a["size"]]
        c = read_json_gz(CACHE / f"{month}.json.gz")
        if c and c.get("format") == FORMAT and c.get("key") == key:
            out[month] = c["techs"]
            continue
        path = HISTORY / a["name"]
        try:
            if not path.exists() or path.stat().st_size != a["size"]:
                HISTORY.mkdir(exist_ok=True)
                _gh("release", "download", "history", "-R", REPO, "-p", a["name"], "-D", str(HISTORY), "--clobber")
            techs = _month_from_parquet(path, month)
        except (OSError, subprocess.CalledProcessError, ValueError) as e:
            warn(f"renew_years: skipped {a['name']} ({e})")
            continue
        write_json_gz(CACHE / f"{month}.json.gz", {"month": month, "format": FORMAT, "key": key, "techs": techs})
        out[month] = techs
    return out


def series_days() -> tuple:
    """-> (dates, {tech: {field: [day]}}, {YYYY-MM: {tech: FIELDS}} for complete months) from the
    series month files."""
    idx = read_json_gz(DATA_DIR / "series" / "index.json.gz") or {}
    dates, daily, months = [], {t: {k: [] for k in FIELDS} for t in TECHS}, {}
    per = {t: {} for t in TECHS}     # tech -> month -> (dates, {unit: (hsl, bp, out, da) per day})
    for month in idx.get("months", []):
        for t in TECHS:
            f = read_json_gz(DATA_DIR / "series" / month / f"{t}.json.gz")
            if not f:
                continue
            per[t][month] = f
    all_dates = sorted({d for t in TECHS for f in per[t].values() for d in f["dates"]})
    for t in TECHS:
        # unit -> {date: (hsl, bp, out, da) 24-hour arrays}
        days = {}
        for f in per[t].values():
            for u, v in f["units"].items():
                arr = {k: np.array([np.nan if x is None else x for x in v[k]], float) for k in ("hsl", "bp", "out", "da")}
                for i, d in enumerate(f["dates"]):
                    days.setdefault(d, {})[u] = tuple(arr[k][24 * i:24 * i + 24] for k in ("hsl", "bp", "out", "da"))
        dmax = {d: {u: (float(np.nanmax(x[0])) if np.isfinite(x[0]).any() else 0.0) for u, x in us.items()} for d, us in days.items()}
        for j, d in enumerate(all_dates):
            if d not in days:
                for k in FIELDS:
                    daily[t][k].append(None)
                continue
            cap = {}
            for dd in all_dates[max(0, j - WINDOW + 1):j + 1]:
                for u, m in dmax.get(dd, {}).items():
                    cap[u] = max(cap.get(u, 0.0), m)
            s = summarize(days[d], cap)
            if j < WINDOW - 1:      # not 30 days behind it yet: the fleet would read small
                s["gw"] = s["units"] = None
            for k in FIELDS:
                daily[t][k].append(s[k])
        for month in sorted({d[:7] for d in days}):
            ds = [d for d in days if d.startswith(month)]
            y, m = map(int, month.split("-"))
            if len(ds) < calendar.monthrange(y, m)[1]:
                continue
            units = {}
            for d in sorted(ds):
                for u, x in days[d].items():
                    units.setdefault(u, []).append(x)
            units = {u: tuple(np.concatenate([x[i] for x in xs]) for i in range(4)) for u, xs in units.items()}
            cap = {u: float(np.nanmax(v[0])) if np.isfinite(v[0]).any() else 0.0 for u, v in units.items()}
            months.setdefault(month, {})[t] = summarize(units, cap)
    dates = all_dates
    return dates, daily, {m: v for m, v in months.items() if all(t in v for t in TECHS)}


def build_renew_years(index: dict = None) -> None:
    hist = history_months()
    dates, daily, smonths = series_days()
    months = sorted(set(hist) | set(smonths))
    if not months and not dates:
        return
    monthly = {t: {k: [] for k in FIELDS} for t in TECHS}
    for m in months:
        src = smonths.get(m) or hist[m]
        for t in TECHS:
            for k in FIELDS:
                monthly[t][k].append((src.get(t) or {}).get(k))
    write_json_gz(PATH, {"format": FORMAT, "months": months, "monthly": monthly,
                         "monthly_source": ["s" if m in smonths else "h" for m in months],
                         "dates": dates, "daily": daily})
    last = {t: monthly[t]["gw"][-1] for t in TECHS} if months else {}
    print(f"renew_years: {len(months)} months ({len(set(months) - set(smonths))} from the history), {len(dates)} days; "
          + ", ".join(f"{t} {v:.1f} GW" for t, v in last.items() if v is not None))


if __name__ == "__main__":
    build_renew_years()
