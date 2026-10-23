"""Build the forecast files: curve snapshots, one file per day, the 2-day fit, scores and the index.

A past day's file is rebuilt only when its build key changed (data/forecast/build_keys.json.gz):
the forecast code (memo.code_hash), the thermal history release's files, the day's history
point and known dates, and which of the index's day lists hold the day.  Each day is forecast
from what was public the day before it, so new data leaves a day alone unless it moves the
day's history point (the latest days, whose point is the record's last day).  Every
FULL_DAYS days, and with REBUILD_ALL=1, every day is rebuilt, and a day whose key had not
changed but whose file did is reported: the key missed one of its inputs.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import time

from ..config import HISTORY_DIR
from ..memo import code_hash
from ..store import load_index, read_json_gz, write_json_gz
from . import context as C
from .build import OUT_DIR, forecast_days, write_day, write_index
from .score import score_days
from ..models.two_day_fit import fit_days, write_index as write_fit_index


KEYS = OUT_DIR / "build_keys.json.gz"
FULL_DAYS = 7         # days between full rebuilds


def day_key(ctx: C.Context, index: dict, date: str, base: str) -> str:
    """The inputs a day's forecast depends on, beyond the files of its own date (see the docstring)."""
    point, hind = ctx.asof(date)
    known, khind = ctx.known_date(date)
    lists = sorted(k for k, v in index["days"].items() if date in set(v))
    raw = json.dumps([base, point, hind, known, khind, ctx.known_dam_date(date), lists])
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _base() -> str:
    """The forecast code and the thermal history release's files (names and sizes)."""
    hist = sorted((p.name, p.stat().st_size) for p in HISTORY_DIR.glob("*.parquet")) if HISTORY_DIR.exists() else []
    return hashlib.sha1(json.dumps([code_hash(__name__), hist]).encode()).hexdigest()


def build_forecast(index: dict, days=None) -> list:
    t0 = time.time()
    ctx = C.Context(index)
    C.update_snapshots(ctx)
    all_days = forecast_days(ctx)
    prev = read_json_gz(KEYS, default=None) or {}
    today = dt.date.today()
    last_full = prev.get("full")
    full = (days is None and (bool(os.environ.get("REBUILD_ALL")) or not last_full
                              or (today - dt.date.fromisoformat(last_full)).days >= FULL_DAYS))
    base = _base()
    keys = {d: day_key(ctx, index, d, base) for d in all_days}
    old = prev.get("days", {})
    if days is not None:
        todo = [d for d in all_days if days[0] <= d <= days[1]]
    elif full:
        todo = all_days
    else:
        todo = [d for d in all_days if old.get(d) != keys[d] or not (OUT_DIR / f"{d}.json.gz").exists()]
    missed = []
    for d in todo:
        path = OUT_DIR / f"{d}.json.gz"
        before = path.read_bytes() if full and old.get(d) == keys[d] and path.exists() else None
        write_day(d, ctx)
        if before is not None and path.read_bytes() != before:
            missed.append(d)
    if full:
        print(f"forecast: full rebuild; {len(missed)} day(s) changed with an unchanged key"
              + (f": {', '.join(missed[:20])}" if missed else ""))
    write_json_gz(KEYS, {"full": today.isoformat() if full else last_full, "missed": missed if full else prev.get("missed", []),
                         "days": {d: keys[d] for d in all_days if d in set(todo) or old.get(d) == keys[d]}})
    n_fit = len(fit_days(ctx, all_days, OUT_DIR))       # the 2-day fit for every day with a 2-day curve
    write_fit_index(index)
    score_days(all_days, ctx, OUT_DIR)
    write_index(ctx, all_days)
    # files for days that no longer have a price source are stale; drop them
    for p in [*OUT_DIR.glob("20*.json.gz"), *(OUT_DIR / "stack").glob("20*.json.gz")]:
        if p.name[:10] not in set(all_days):
            p.unlink()
    print(f"forecast: {len(todo)} day(s) built{' (full)' if full else ''}, {n_fit} fitted, {len(all_days)} in the index, {time.time() - t0:.0f}s"
          + (f", latest {all_days[-1]}" if all_days else ""))
    return todo


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--days", nargs=2, metavar=("START", "END"), help="only build days in this range")
    ap.add_argument("--score", action="store_true", help="rescore the existing files, build nothing")
    args = ap.parse_args(argv)
    index = load_index()
    if args.score:
        ctx = C.Context(index)
        days = forecast_days(ctx)
        score_days(days, ctx, OUT_DIR)
        write_index(ctx, days)
        return 0
    build_forecast(index, args.days)
    return 0
