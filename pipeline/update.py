"""Fetch new ERCOT reports and rebuild the dashboard's data files.

Usage:
  python -m pipeline.update                       # daily: anything posted in the last few days
  python -m pipeline.update --days 10             # look further back
  python -m pipeline.update --backfill 2026-07-01 2026-07-31   # operating days in a range
  python -m pipeline.update --local FILE.zip ...  # process report zips you downloaded yourself
"""
import argparse
import datetime as dt
import sys
import time
import warnings

from .config import DATA_DIR, EMIL_2DAY, EMIL_60DAY, EMIL_LAMBDA, EMIL_SPP
from .parse_2day import parse_2day_zip
from .parse_60day import parse_60day_zip
from .parse_prices import build_price_day, read_lambda, read_spp
from .store import iter_csvs, zip_names, load_index, save_index, update_summary, write_json_gz

warnings.filterwarnings("ignore", category=RuntimeWarning)


def _d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


# ------------------------------------------------------------- processing --
def process_curve_zip(blob: bytes, index: dict) -> str:
    names = zip_names(blob)
    if any(n.startswith("2d_Agg_") for n in names):
        source, parser = "2d", parse_2day_zip
    elif any(n.startswith("60d_SCED_Gen_Resource_Data") for n in names):
        source, parser = "60d", parse_60day_zip
    else:
        raise ValueError("Not a 2-day SCED energy curves or 60-day SCED disclosure zip")
    t0 = time.time()
    date, day, summary = parser(blob)
    write_json_gz(DATA_DIR / source / f"{date}.json.gz", day)
    update_summary(source, date, summary)
    index["days"][source].append(date)
    print(f"  {source} {date} processed in {time.time() - t0:.0f}s")
    return date


def process_price_blobs(blobs, dates, index: dict):
    lam_csvs, spp_csvs = [], []
    for b in blobs:
        for n, data in iter_csvs(b, "x.zip"):
            u = n.upper()
            if "SYSLAMBDA" in u or "SYSTEM_LAMBDA" in u or data[:60].find(b"SystemLambda") >= 0:
                lam_csvs.append((n, data))
            elif "SPP" in u or b"SettlementPointPrice" in data[:200]:
                spp_csvs.append((n, data))
    lam, spp = read_lambda(lam_csvs), read_spp(spp_csvs)
    done = []
    for date in sorted(set(dates)):
        res = build_price_day(date, lam, spp)
        if res is None:
            continue
        day, summary = res
        write_json_gz(DATA_DIR / "prices" / f"{date}.json.gz", day)
        update_summary("prices", date, summary)
        index["days"]["prices"].append(date)
        done.append(date)
    return done


# ---------------------------------------------------------------- fetching --
def fetch_curves(api, emil: str, posted_from: dt.datetime, posted_to: dt.datetime,
                 index: dict, source: str, want_dates=None, limit=None):
    docs = api.list_archives(emil, posted_from, posted_to)
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    print(f"{emil}: {len(docs)} file(s) posted {posted_from:%Y-%m-%d} .. {posted_to:%Y-%m-%d}")
    lag = 2 if source == "2d" else 60
    have = set(index["days"][source])
    n = 0
    for doc in docs:
        posted = _d(doc["postDatetime"][:10])
        guess = (posted - dt.timedelta(days=lag)).isoformat()   # operating day = posting day - lag
        if guess in have:
            continue
        if want_dates and guess not in want_dates:
            continue
        print(f"  downloading {doc.get('friendlyName', doc['docId'])} (op day ~{guess})")
        try:
            date = process_curve_zip(api.download(emil, doc["docId"]), index)
            have.add(date)
            save_index(index)
        except Exception as e:  # keep going; one bad file shouldn't stop the run
            print(f"  ! failed: {e}")
        n += 1
        if limit and n >= limit:
            break


def fetch_prices(api, dates, index: dict):
    have = set(index["days"]["prices"])
    misses = index.setdefault("price_misses", {})
    for date in sorted(set(dates) - have):
        if misses.get(date, 0) >= 3:      # stop retrying days ERCOT has no prices for
            continue
        d = _d(date)
        start = dt.datetime.combine(d, dt.time(0, 0))
        end = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(2, 0))
        failed = False
        try:
            blobs = []
            for emil in (EMIL_LAMBDA, EMIL_SPP):
                docs = api.list_archives(emil, start, end)
                if docs:
                    blobs.extend(api.download_many(emil, [x["docId"] for x in docs]))
            done = process_price_blobs(blobs, [date], index)
        except Exception as e:   # a price problem must not lose the curve data already processed
            print(f"  ! prices {date} failed: {type(e).__name__}: {e}")
            done, failed = [], True
        print(f"  prices {date}: {'ok' if done else 'none found'}")
        if not done and not failed:       # count only genuine "no prices" results
            misses[date] = misses.get(date, 0) + 1
        save_index(index)


# -------------------------------------------------------------------- main --
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=4, help="look back this many days of postings (default 4)")
    ap.add_argument("--backfill", nargs=2, metavar=("START", "END"), help="operating-day range to fill")
    ap.add_argument("--max-files", type=int, default=None, help="cap curve files per report per run")
    ap.add_argument("--skip", choices=["2d", "60d", "prices"], action="append", default=[])
    ap.add_argument("--local", nargs="+", help="process local zip files instead of calling the API")
    args = ap.parse_args(argv)

    index = load_index()

    if args.local:
        price_blobs, curve_dates = [], []
        for path in args.local:
            blob = open(path, "rb").read()
            names = zip_names(blob)
            if any(n.startswith(("2d_Agg_", "60d_")) for n in names):
                print(f"{path}")
                curve_dates.append(process_curve_zip(blob, index))
            else:
                price_blobs.append(blob)
        if price_blobs:
            # price files carry their own dates; build every date they cover
            lam = read_lambda([c for b in price_blobs for c in iter_csvs(b, "x.zip")
                               if b"SystemLambda" in c[1][:80]])
            spp = read_spp([c for b in price_blobs for c in iter_csvs(b, "x.zip")
                            if b"SettlementPointPrice" in c[1][:200]])
            dates = set(lam["date"]) | set(spp["date"])
            print("prices:", process_price_blobs(price_blobs, dates, index))
        save_index(index)
        return

    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    now = dt.datetime.now()

    if args.backfill:
        start, end = _d(args.backfill[0]), _d(args.backfill[1])
        want = {(start + dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)}
        for source, emil, lag in (("2d", EMIL_2DAY, 2), ("60d", EMIL_60DAY, 60)):
            if source in args.skip:
                continue
            fetch_curves(api, emil,
                         dt.datetime.combine(start + dt.timedelta(days=lag - 1), dt.time()),
                         dt.datetime.combine(end + dt.timedelta(days=lag + 2), dt.time()),
                         index, source, want_dates=want, limit=args.max_files)
    else:
        since = now - dt.timedelta(days=args.days)
        if "2d" not in args.skip:
            fetch_curves(api, EMIL_2DAY, since, now + dt.timedelta(days=1), index, "2d", limit=args.max_files)
        if "60d" not in args.skip:
            fetch_curves(api, EMIL_60DAY, since, now + dt.timedelta(days=1), index, "60d", limit=args.max_files)

    if "prices" not in args.skip:
        need = set(index["days"]["2d"]) | set(index["days"]["60d"])
        fetch_prices(api, need, index)

    save_index(index)
    print("done")


if __name__ == "__main__":
    sys.exit(main())
