"""One day's aggregated offer stack from ERCOT's archive, for a reference chart.

Downloads the 60-Day SCED Disclosure (NP3-965-ER) for each operating day asked for, runs
parse_60day_zip on it, and keeps only the hourly curves and statistics by technology: the same
"curves" / "submitted" / "stats" blocks as a site day file (data/60d/<date>.json.gz), on the
site's price grid.  Writes one JSON file per day to the output folder and nothing else: it never
reads or writes data/ or the data branch.  Run by the "Archive offer stack" workflow, which
uploads the files as a run artifact.

The grid stops at $5,000, so before June 2023 (when the cap was $9,000) the MW offered above
$5,000 is the gap between the $5,000 point and the hour's HSL.

    python -m pipeline.archive_stack 2019-08-13 [2019-08-15 ...] [--out archive-stack]
"""
import argparse
import datetime as dt
import gzip
import json
import time
from pathlib import Path

from .config import EMIL_60DAY, PRICE_GRID
from .ercot_api import ErcotAPI
from .log import warn
from .parse_60day import parse_60day_zip
from .update import curve_source, skip_reason

LAG = 60          # the 60-day disclosures post about 60 days after the operating day
SLACK = 4         # days either side of that a file may post


def _t(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d, dt.time())


def fetch_day(api, day: dt.date):
    """-> parsed day file for `day`, or None if no posted disclosure carries it."""
    docs = api.list_archives(EMIL_60DAY, _t(day + dt.timedelta(days=LAG - SLACK)),
                             _t(day + dt.timedelta(days=LAG + SLACK + 1)))
    # the file posted closest to 60 days on first; largest first among same-day posts (skips
    # partial "SUPPLEMENTAL" reposts)
    docs.sort(key=lambda d: (abs((dt.date.fromisoformat(d["postDatetime"][:10]) - day).days - LAG),
                             -(d.get("size") or 0)))
    for doc in docs:
        blob = api.download(EMIL_60DAY, doc["docId"])
        if blob[:2] != b"PK":
            time.sleep(10)
            blob = api.download(EMIL_60DAY, doc["docId"])
        found = curve_source(blob)
        if skip_reason(blob) or not found or found[0] != "60d":
            continue
        t0 = time.time()
        date, parsed, *_ = parse_60day_zip(blob)
        print(f"  {doc.get('friendlyName', doc['docId'])} posted {doc['postDatetime'][:10]}: "
              f"operating day {date}, {len(blob) / 1e6:.0f} MB zip, {time.time() - t0:.0f}s", flush=True)
        if date == day.isoformat():
            return parsed
    return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("days", nargs="+", help="operating days, YYYY-MM-DD")
    ap.add_argument("--out", default="archive-stack")
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    api = ErcotAPI()
    missing = []
    for s in args.days:
        parsed = fetch_day(api, dt.date.fromisoformat(s))
        if parsed is None:
            warn(f"{s}: no 60-day SCED disclosure found for this operating day")
            missing.append(s)
            continue
        keep = {k: parsed[k] for k in ("date", "runs", "curves", "submitted", "stats", "stat_names")}
        keep["grid"] = [float(p) for p in PRICE_GRID]
        with gzip.open(out / f"{s}.json.gz", "wt") as f:
            json.dump(keep, f, separators=(",", ":"))
        print(f"  wrote {out / (s + '.json.gz')}", flush=True)
    if missing:
        raise SystemExit(f"no disclosure for: {', '.join(missing)}")


if __name__ == "__main__":
    main()
