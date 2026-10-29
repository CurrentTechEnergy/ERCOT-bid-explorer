"""Fill the raw store (pipeline/raw_store.py) with one 60-day report's files for a span of
operating days, without parsing them: the one-time fetch of the 60-day DAM disclosure for 2019 to
2025 (Blair, Oct 27 2026), so the history fits can read DAM resource status from our own copy.

Every file the archive lists for posting dates LAG days (+/- SLACK) after the span (--lag for a
report that posts on another lag: -1 for the day-ahead reports, posted the day before) is first looked
up in the bucket with a HEAD request; only files not there are downloaded from ERCOT, and each is
stored before the next is fetched.  If a file can't be stored, or the bucket can't be asked, the
run stops: ERCOT's terms allow about three downloads of a report a year, so nothing is downloaded
that isn't kept.  --dry-run only counts what is stored and what is not.

    python -m pipeline.raw_fetch --emil np3-966-er --start 2019-01-01 --end 2019-12-31 [--dry-run]
    python -m pipeline.raw_fetch --emil np4-523-cd --lag -1 --start 2019-01-01 --end 2019-12-31
    python -m pipeline.raw_fetch --emil np6-970-cd --lag 0 --start 2026-10-01 --end 2026-10-01 --max-files 1
"""
import argparse
import datetime as dt
import sys

from .ercot_api import ErcotAPI
from .history import LAG, SLACK


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emil", required=True)
    ap.add_argument("--start", required=True, help="first operating day, YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="last operating day, YYYY-MM-DD")
    ap.add_argument("--lag", type=int, default=LAG, help=f"days from operating day to posting (default {LAG})")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-files", type=int, default=0, help="stop after fetching this many files from ERCOT (0: no limit)")
    a = ap.parse_args(argv)
    api = ErcotAPI()
    store = api.raw
    if not store.enabled:
        print("raw store: R2_ENDPOINT, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is not set; nothing fetched")
        return 1
    lo, hi = dt.date.fromisoformat(a.start), dt.date.fromisoformat(a.end)
    t = lambda d: dt.datetime(d.year, d.month, d.day)
    docs = api.list_archives(a.emil, t(lo + dt.timedelta(days=a.lag - SLACK)), t(hi + dt.timedelta(days=a.lag + SLACK + 1)))
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    print(f"{a.emil}: {len(docs)} files posted {docs[0]['postDatetime'][:10] if docs else '-'} to "
          f"{docs[-1]['postDatetime'][:10] if docs else '-'}", flush=True)
    have = fetched = 0
    for doc in docs:
        got = store.has(a.emil, doc["docId"])
        if got is None:
            print(f"raw store: can't ask the bucket about doc {doc['docId']}; stopping before any further download")
            return 1
        if got:
            have += 1
            continue
        if a.dry_run:
            continue
        before = store.stats["stored"]
        blob = api.download(a.emil, doc["docId"])
        if store.stats["stored"] == before:
            print(f"doc {doc['docId']} ({doc.get('friendlyName', '')}, {len(blob) / 1e6:.1f} MB) was downloaded but not "
                  "stored; stopping so no file is downloaded without being kept")
            print(store.summary())
            return 1
        fetched += 1
        if a.max_files and fetched >= a.max_files:
            print(f"stopping at --max-files {a.max_files}: last file {doc.get('friendlyName', '')}, "
                  f"posted {doc.get('postDatetime', '')[:16]}, {len(blob) / 1e3:.1f} kB", flush=True)
            break
    missing = 0 if a.max_files else len(docs) - have - fetched
    print(f"{a.emil} {lo} to {hi}: {len(docs)} files, {have} already stored, {fetched} fetched from ERCOT and stored"
          + (f", {missing} not stored (dry run)" if a.dry_run else ""))
    print(store.summary())
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
