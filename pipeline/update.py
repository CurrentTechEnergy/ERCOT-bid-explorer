"""Fetch new ERCOT reports and rebuild the dashboard's data files.

Usage:
  python -m pipeline.update                       # daily: anything posted in the last few days
  python -m pipeline.update --days 10             # look further back
  python -m pipeline.update --backfill 2026-07-01 2026-07-31   # operating days in a range
  python -m pipeline.update --local FILE.zip ...  # process report zips you downloaded yourself
"""
import argparse
from collections import Counter
import datetime as dt
import sys
import time
import warnings

from .config import DATA_DIR, EMIL_2DAY, EMIL_2DAY_GEN, EMIL_60DAY, EMIL_LAMBDA, EMIL_SPP
from .parse_2day import parse_2day_zip
from .parse_2day_gen import is_gen_summary, parse_2day_gen_zip
from .parse_60day import parse_60day_zip
from .parse_prices import build_price_day, read_lambda, read_spp
from .marginal import build_marginal
from .trends import build_trends
from .curve_trends import build_curve_trends
from .store import describe_blob, iter_csvs, zip_names, load_index, save_index, update_summary, write_json_gz
from .log import warn, write_summary, WARNINGS

warnings.filterwarnings("ignore", category=RuntimeWarning)


def _d(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


# ------------------------------------------------------------- processing --
def curve_source(blob: bytes):
    """("2d" | "2dgen" | "60d", parser) for a report zip, or None if it is none of them."""
    names = [n.lower() for n in zip_names(blob)]
    if is_gen_summary(names):      # NP3-910-ER: also named 2d_Agg_*, so check it first
        return "2dgen", parse_2day_gen_zip
    if any(n.startswith("2d_agg_") for n in names):
        return "2d", parse_2day_zip
    # the same files parse_60day_zip reads
    if any(n.startswith(("60d_sced_gen_resource_data", "60d_esr_data_in_sced")) for n in names):
        return "60d", parse_60day_zip
    return None


def is_load_resource_only(blob: bytes) -> bool:
    names = [n.lower() for n in zip_names(blob)]
    return bool(names) and all(n.startswith("60d_load_resource_data") for n in names)


def process_curve_zip(blob: bytes, index: dict) -> str:
    found = curve_source(blob)
    if found is None:
        raise ValueError("Not a 2-day SCED energy curves, 2-day generation summary or 60-day SCED disclosure zip "
                         f"({describe_blob(blob)})")
    source, parser = found
    t0 = time.time()
    date, day, summary = parser(blob)
    write_json_gz(DATA_DIR / source / f"{date}.json.gz", day)
    update_summary(source, date, summary)
    index["days"].setdefault(source, []).append(date)
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
    """Download and process report files not yet loaded.

    ERCOT usually posts one file per day, `lag` days after the operating day, but
    postings are sometimes late, doubled up on one day, or reposted.  So files are
    tracked by document id; the posting date is only used as a hint."""
    docs = api.list_archives(emil, posted_from, posted_to)
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    print(f"{emil}: {len(docs)} file(s) posted {posted_from:%Y-%m-%d} .. {posted_to:%Y-%m-%d}")
    lag = 60 if source == "60d" else 2
    have = set(index["days"].setdefault(source, []))
    done_ids = set(index.setdefault("docs", {}).setdefault(emil, []))
    guess_of = {d["docId"]: (_d(d["postDatetime"][:10]) - dt.timedelta(days=lag)).isoformat() for d in docs}
    per_guess = Counter(guess_of.values())
    if want_dates:   # allow for files posted a few days late or early
        lo, hi = _d(min(want_dates)) - dt.timedelta(days=4), _d(max(want_dates)) + dt.timedelta(days=4)
    # A file posted a day or two off its usual schedule can carry a date we are missing
    # while its posting date points at a day we already have, so near a gap open every
    # file rather than trusting the posting date.
    gaps = {_d(d) for d in want_dates or () if d not in have}

    def near_gap(day: str) -> bool:
        return any(abs((_d(day) - g).days) <= 3 for g in gaps)

    n, failed = 0, set()
    for doc in docs:
        doc_id, guess = doc["docId"], guess_of[doc["docId"]]
        if doc_id in done_ids:
            continue
        # skip without downloading only when the posting date unambiguously maps to a day we have
        if guess in have and per_guess[guess] == 1 and not near_gap(guess):
            continue
        if want_dates and not (lo <= _d(guess) <= hi):
            continue
        print(f"  downloading {doc.get('friendlyName', doc_id)} posted {doc['postDatetime'][:16]} (op day ~{guess})")
        try:
            blob = api.download(emil, doc_id)
            if blob[:2] != b"PK":     # an error page or empty body instead of the zip: try once more
                print(f"  download was not a zip ({describe_blob(blob)}); retrying")
                time.sleep(10)
                blob = api.download(emil, doc_id)
            if is_load_resource_only(blob):
                # ERCOT's occasional "SUPPLEMENTAL" repost of only the Load Resource files;
                # the dashboard doesn't read those, and the regular daily zips carry the rest
                print(f"  skipped: Load Resource data only ({describe_blob(blob)})")
            else:
                have.add(process_curve_zip(blob, index))
            index["docs"][emil].append(doc_id)
            save_index(index)
        except Exception as e:  # keep going; one bad file shouldn't stop the run
            failed.add(doc_id)
            warn(f"{emil} {guess} ({doc.get('friendlyName', '')} doc {doc_id}, "
                 f"posted {doc['postDatetime'][:16]}): failed: {type(e).__name__}: {e}")
        n += 1
        if limit and n >= limit:
            print(f"  reached the limit of {limit} files for this run; run again to continue")
            return
    if want_dates:
        missing = sorted(d for d in want_dates if d not in have and d <= max(guess_of.values(), default=""))
        if missing:
            nearby = [d for d in docs if any(abs((_d(guess_of[d["docId"]]) - _d(m)).days) <= 3 for m in missing)]
            warn(f"{emil}: no file found for {len(missing)} day(s) in the range: {', '.join(missing[:20])}"
                 + (" ..." if len(missing) > 20 else "")
                 + (f". All {len(nearby)} files posted within 3 days of these have been opened"
                    " and none holds them, so ERCOT appears not to have posted them."
                    if not failed & {d["docId"] for d in nearby} else
                    ". Some files posted near them failed to load (see the warnings above)."))


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
            warn(f"Prices {date}: failed: {type(e).__name__}: {e}")
            done, failed = [], True
        print(f"  prices {date}: {'ok' if done else 'none found'}")
        if not done and not failed:
            warn(f"Prices {date}: no system lambda or hub prices found on the ERCOT API")
        if not done and not failed:       # count only genuine "no prices" results
            misses[date] = misses.get(date, 0) + 1
        save_index(index)


# -------------------------------------------------------------------- main --
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=4, help="look back this many days of postings (default 4)")
    ap.add_argument("--backfill", nargs=2, metavar=("START", "END"), help="operating-day range to fill")
    ap.add_argument("--max-files", type=int, default=None, help="cap curve files per report per run")
    ap.add_argument("--skip", choices=["2d", "2dgen", "60d", "prices"], action="append", default=[])
    ap.add_argument("--local", nargs="+", help="process local zip files instead of calling the API")
    args = ap.parse_args(argv)

    index = load_index()
    before = {k: set(v) for k, v in index["days"].items()}

    if args.local:
        price_blobs, curve_dates = [], []
        for path in args.local:
            blob = open(path, "rb").read()
            if curve_source(blob):
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
        build_marginal(index)
        build_trends(index)
        build_curve_trends(index)
        save_index(index)
        return

    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    now = dt.datetime.now()

    if args.backfill:
        start, end = _d(args.backfill[0]), _d(args.backfill[1])
        want = {(start + dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)}
        for source, emil, lag in (("2d", EMIL_2DAY, 2), ("2dgen", EMIL_2DAY_GEN, 2), ("60d", EMIL_60DAY, 60)):
            if source in args.skip:
                continue
            fetch_curves(api, emil,
                         dt.datetime.combine(start + dt.timedelta(days=lag - 1), dt.time()),
                         dt.datetime.combine(end + dt.timedelta(days=lag + 5), dt.time()),
                         index, source, want_dates=want, limit=args.max_files)
    else:
        since = now - dt.timedelta(days=args.days)
        if "2d" not in args.skip:
            fetch_curves(api, EMIL_2DAY, since, now + dt.timedelta(days=1), index, "2d", limit=args.max_files)
        if "2dgen" not in args.skip:
            fetch_curves(api, EMIL_2DAY_GEN, since, now + dt.timedelta(days=1), index, "2dgen", limit=args.max_files)
        if "60d" not in args.skip:
            fetch_curves(api, EMIL_60DAY, since, now + dt.timedelta(days=1), index, "60d", limit=args.max_files)

    if "prices" not in args.skip:
        need = set(index["days"]["2d"]) | set(index["days"]["60d"])
        fetch_prices(api, need, index)

    build_marginal(index)
    build_trends(index)
    build_curve_trends(index)
    save_index(index)
    added = {k: sorted(set(index["days"][k]) - before.get(k, set())) for k in index["days"]}
    names = {"2d": "2-day curves", "2dgen": "2-day generation summary", "60d": "60-day curves", "prices": "prices"}
    lines = ["### ERCOT data update", "", "| Data | Days added | Range |", "|---|---|---|"]
    for k, v in added.items():
        lines.append(f"| {names.get(k, k)} | {len(v)} | {v[0] + ' to ' + v[-1] if v else '–'} |")
    lines += ["", f"**{len(WARNINGS)} warning(s)**" if WARNINGS else "No warnings."]
    lines += [f"- {w}" for w in WARNINGS[:50]]
    write_summary(lines)
    print("done:", {k: len(v) for k, v in added.items()}, f"{len(WARNINGS)} warning(s)")


if __name__ == "__main__":
    sys.exit(main())
