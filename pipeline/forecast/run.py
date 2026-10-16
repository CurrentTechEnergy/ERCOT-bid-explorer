"""Build the forecast files: curve snapshots, one file per day, scores and the index."""
import argparse
import time

from ..store import load_index
from . import context as C
from .build import OUT_DIR, forecast_days, write_day, write_index
from .score import score_days


def build_forecast(index: dict, days=None) -> list:
    t0 = time.time()
    ctx = C.Context(index)
    C.update_snapshots(ctx)
    all_days = forecast_days(ctx)
    todo = [d for d in all_days if days is None or days[0] <= d <= days[1]]
    for d in todo:
        write_day(d, ctx)
    score_days(all_days, ctx, OUT_DIR)
    write_index(ctx, all_days)
    # files for days that no longer have a price source are stale; drop them
    for p in [*OUT_DIR.glob("20*.json.gz"), *(OUT_DIR / "stack").glob("20*.json.gz")]:
        if p.name[:10] not in set(all_days):
            p.unlink()
    print(f"forecast: {len(todo)} day(s) built, {len(all_days)} in the index, {time.time() - t0:.0f}s"
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
