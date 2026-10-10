"""Fetch new ERCOT reports and rebuild the dashboard's data files.

Usage:
  python -m pipeline.update                       # daily: anything posted in the last few days
  python -m pipeline.update --days 10             # look further back
  python -m pipeline.update --backfill 2026-07-01 2026-07-31   # operating days in a range
  python -m pipeline.update --local FILE.zip ...  # process report zips you downloaded yourself
  python -m pipeline.update --reprocess-60d --max-files 40   # re-download and reparse 60-day days
        already in the index that have no per-unit day file yet (resumable); `--reprocess-60d all`
        redoes every 60-day day in the index

60-day days also write a per-unit day file to UNIT_DATA_DIR (env var; default ./unitdata).
60-day DAM disclosure days (three-part offers, awards) are written to data/dam/.
"""
import argparse
from collections import Counter
import datetime as dt
import sys
import time
import os
import warnings

from .config import (DATA_DIR, UNIT_DATA_DIR, EMIL_2DAY, EMIL_2DAY_GEN, EMIL_60DAY, EMIL_DAM, EMIL_LAMBDA, EMIL_SPP,
                     NODE_DAYS_PER_RUN)
from .parse_2day import parse_2day_zip
from .parse_2day_gen import is_gen_summary, parse_2day_gen_zip
from .parse_60day import parse_60day_zip, OVERRIDE_STATS
from .units import UNIT_FORMAT
from .parse_dam import parse_dam_zip, has_dam_gen
from .parse_prices import NODE_FORMAT, build_price_day, node_prices, read_lambda, read_spp
from .marginal import build_marginal
from .trends import build_trends
from .intraday import build_intraday
from .stayon import build_stayon
from .curve_trends import build_curve_trends
from .nodes import build_node_curtail
from .marginal_nodes import build_marginal_nodes
from .gas import fetch_gas
from .econ import build_econ
from .store import describe_blob, iter_csvs, zip_names, load_index, read_json_gz, save_index, update_summary, write_json_gz
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
    if has_dam_gen(names):
        return "dam", parse_dam_zip
    return None


def skip_reason(blob: bytes):
    """Why a downloaded zip is not processed, or None: ERCOT's occasional "SUPPLEMENTAL" reposts
    carry only some of a day's files, and the dashboard does not read the Load Resource ones nor
    the DAM files other than the generation resource data."""
    names = [n.lower() for n in zip_names(blob)]
    if names and all(n.startswith("60d_load_resource_data") for n in names):
        return "Load Resource data only"
    if names and all(n.startswith("60d_dam_") for n in names) and not has_dam_gen(names):
        return "DAM files without the generation resource data"
    return None


def is_load_resource_only(blob: bytes) -> bool:
    return skip_reason(blob) is not None


UNIT_FILES = []     # (date, compressed bytes, COV events) written in this run


def _drop_nan(x, path, bad):
    """Copy of a JSON-like structure with NaN floats replaced by None; their paths go in bad."""
    if isinstance(x, float):
        if x != x:
            bad.append(path)
            return None
        return x
    if isinstance(x, dict):
        return {k: _drop_nan(v, f"{path}/{k}", bad) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_drop_nan(v, f"{path}/{i}", bad) for i, v in enumerate(x)]
    return x


def process_curve_zip(blob: bytes, index: dict) -> str:
    found = curve_source(blob)
    if found is None:
        raise ValueError("Not a 2-day SCED energy curves, 2-day generation summary, 60-day SCED disclosure "
                         f"or 60-day DAM disclosure zip ({describe_blob(blob)})")
    source, parser = found
    t0 = time.time()
    date, day, summary, *extra = parser(blob)
    write_json_gz(DATA_DIR / source / f"{date}.json.gz", day)
    update_summary(source, date, summary)
    index["days"].setdefault(source, []).append(date)
    if extra:     # 60-day: per-unit change-of-value day file
        unit_day, n_events = extra[0]
        bad = []
        unit_day = _drop_nan(unit_day, "", bad)
        if bad:
            warn(f"unit file {date}: {len(bad)} NaN value(s) written as null, e.g. {', '.join(bad[:5])}")
        path = UNIT_DATA_DIR / source / f"{date}.json.gz"
        write_json_gz(path, unit_day)
        size = path.stat().st_size
        UNIT_FILES.append((date, size, n_events))
        print(f"  unit file {path.name}: {len(unit_day['units'])} units, {len(unit_day['runs'])} runs, "
              f"{n_events:,} COV events, {size / 1e6:.2f} MB compressed")
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
        nodes = node_prices(date, spp)
        if nodes:                 # resource-node prices: data branch, not the site
            write_json_gz(UNIT_DATA_DIR / "nodes" / f"{date}.json.gz", nodes)
            if date not in index["days"].setdefault("nodes", []):
                index["days"]["nodes"].append(date)
        if date in index["days"]["prices"] and not lam_csvs:
            done.append(date)     # node-only refetch of a day whose hub prices are already in
            continue
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
    lag = 60 if source in ("60d", "dam") else 2
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
            reason = skip_reason(blob)
            if reason:
                print(f"  skipped: {reason} ({describe_blob(blob)})")
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


def reprocess_60d(api, index: dict, mode: str = "missing", limit=None):
    """Re-download and reparse 60-day days already in the index: those whose per-unit day file
    is missing or predates the current format (mode "missing", so an interrupted run resumes
    and a format change is filled in over several runs), or all of them (mode "all")."""
    def current(d):
        path = UNIT_DATA_DIR / "60d" / f"{d}.json.gz"
        if not path.exists():
            return False
        try:
            return (read_json_gz(path) or {}).get("format") == UNIT_FORMAT
        except Exception:
            return False
    targets = {d for d in index["days"]["60d"] if mode == "all" or not current(d)}
    print(f"reprocess 60d ({mode}): {len(targets)} day(s)")
    if not targets:
        return
    lag = 60
    lo, hi = _d(min(targets)), _d(max(targets))
    docs = api.list_archives(EMIL_60DAY, dt.datetime.combine(lo + dt.timedelta(days=lag - 4), dt.time()),
                             dt.datetime.combine(hi + dt.timedelta(days=lag + 5), dt.time()))
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    guess_of = {d["docId"]: (_d(d["postDatetime"][:10]) - dt.timedelta(days=lag)).isoformat() for d in docs}
    opened, n = set(), 0
    # first the files whose posting date points at a target day, then files posted within
    # 3 days of a target that is still missing (late or doubled-up postings)
    for near in (False, True):
        for doc in docs:
            doc_id, guess = doc["docId"], guess_of[doc["docId"]]
            if doc_id in opened or not targets:
                continue
            if not (any(abs((_d(guess) - _d(t)).days) <= 3 for t in targets) if near else guess in targets):
                continue
            opened.add(doc_id)
            print(f"  downloading {doc.get('friendlyName', doc_id)} posted {doc['postDatetime'][:16]} (op day ~{guess})")
            try:
                blob = api.download(EMIL_60DAY, doc_id)
                if blob[:2] != b"PK":
                    time.sleep(10)
                    blob = api.download(EMIL_60DAY, doc_id)
                if not is_load_resource_only(blob):
                    targets.discard(process_curve_zip(blob, index))
                    save_index(index)
            except Exception as e:
                warn(f"reprocess 60d {guess} (doc {doc_id}): failed: {type(e).__name__}: {e}")
            n += 1
            if limit and n >= limit:
                print(f"  reached the limit of {limit} files; {len(targets)} day(s) left to reprocess")
                return
    if targets:
        warn(f"reprocess 60d: no file found for {len(targets)} day(s): {', '.join(sorted(targets)[:20])}")


def fetch_prices(api, dates, index: dict, node_dates=(), node_limit=NODE_DAYS_PER_RUN):
    """Hub, load-zone and system lambda prices for `dates` not yet loaded; and resource-node
    prices (settlement point report only) for up to node_limit of `node_dates` that have hub
    prices but no current node file yet, so node prices backfill a few days per run."""
    have = set(index["days"]["prices"])
    # a node file from before NODE_FORMAT (resource nodes of type "RN" only) counts as missing
    have_nodes = {d for d in index["days"].get("nodes", [])
                  if (read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("format") == NODE_FORMAT}
    misses = index.setdefault("price_misses", {})
    todo = [(date, (EMIL_LAMBDA, EMIL_SPP)) for date in sorted(set(dates) - have)]
    node_only = sorted((set(node_dates) & have) - have_nodes, reverse=True)[:node_limit]
    todo += [(date, (EMIL_SPP,)) for date in node_only]
    if node_only:
        print(f"node prices: fetching {len(node_only)} day(s), {node_only[-1]} to {node_only[0]}")
    for date, emils in todo:
        if misses.get(date, 0) >= 3:      # stop retrying days ERCOT has no prices for
            continue
        d = _d(date)
        start = dt.datetime.combine(d, dt.time(0, 0))
        end = dt.datetime.combine(d + dt.timedelta(days=1), dt.time(2, 0))
        failed = False
        try:
            blobs = []
            for emil in emils:
                docs = api.list_archives(emil, start, end)
                if docs:
                    blobs.extend(api.download_many(emil, [x["docId"] for x in docs]))
            done = process_price_blobs(blobs, [date], index)
        except Exception as e:   # a price problem must not lose the curve data already processed
            warn(f"Prices {date}: failed: {type(e).__name__}: {e}")
            done, failed = [], True
        print(f"  {'node prices' if emils == (EMIL_SPP,) else 'prices'} {date}: {'ok' if done else 'none found'}")
        if not done and not failed:
            warn(f"Prices {date}: no system lambda or hub prices found on the ERCOT API")
        if not done and not failed:       # count only genuine "no prices" results
            misses[date] = misses.get(date, 0) + 1
        save_index(index)


def unit_file_summary():
    if not UNIT_FILES:
        return []
    lines = ["", "| Per-unit day file | Compressed | COV events |", "|---|---|---|"]
    lines += [f"| {d} | {b / 1e6:.2f} MB | {n:,} |" for d, b, n in UNIT_FILES]
    return lines


# -------------------------------------------------------------------- main --
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=4, help="look back this many days of postings (default 4)")
    ap.add_argument("--backfill", nargs=2, metavar=("START", "END"), help="operating-day range to fill")
    ap.add_argument("--max-files", type=int, default=None, help="cap curve files per report per run")
    ap.add_argument("--skip", choices=["2d", "2dgen", "60d", "dam", "prices", "gas"], action="append", default=[])
    ap.add_argument("--local", nargs="+", help="process local zip files instead of calling the API")
    ap.add_argument("--reprocess-60d", nargs="?", const="missing", choices=["missing", "all"],
                    help="re-download and reparse 60-day days already in the index: those without a "
                         "per-unit day file (default), or all")
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
        build_intraday(index)
        build_stayon(index)
        build_curve_trends(index)
        build_node_curtail(index)
        build_marginal_nodes(index)
        build_econ(index)
        save_index(index)
        return

    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    now = dt.datetime.now()

    if args.backfill:
        start, end = _d(args.backfill[0]), _d(args.backfill[1])
        want = {(start + dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)}
        for source, emil, lag in (("2d", EMIL_2DAY, 2), ("2dgen", EMIL_2DAY_GEN, 2), ("60d", EMIL_60DAY, 60),
                                  ("dam", EMIL_DAM, 60)):
            if source in args.skip:
                continue
            fetch_curves(api, emil,
                         dt.datetime.combine(start + dt.timedelta(days=lag - 1), dt.time()),
                         dt.datetime.combine(end + dt.timedelta(days=lag + 5), dt.time()),
                         index, source, want_dates=want, limit=args.max_files)
    elif args.reprocess_60d:
        reprocess_60d(api, index, args.reprocess_60d, limit=args.max_files)
    else:
        since = now - dt.timedelta(days=args.days)
        if "2d" not in args.skip:
            fetch_curves(api, EMIL_2DAY, since, now + dt.timedelta(days=1), index, "2d", limit=args.max_files)
        if "2dgen" not in args.skip:
            fetch_curves(api, EMIL_2DAY_GEN, since, now + dt.timedelta(days=1), index, "2dgen", limit=args.max_files)
        if "60d" not in args.skip:
            fetch_curves(api, EMIL_60DAY, since, now + dt.timedelta(days=1), index, "60d", limit=args.max_files)
        if "dam" not in args.skip:
            fetch_curves(api, EMIL_DAM, since, now + dt.timedelta(days=1), index, "dam", limit=args.max_files)

    if "prices" not in args.skip:
        need = set(index["days"]["2d"]) | set(index["days"]["60d"])
        node_need = set(index["days"]["60d"]) | set(index["days"].get("dam", []))
        fetch_prices(api, need, index, node_dates=node_need,
                     node_limit=args.max_files if args.backfill and args.max_files else NODE_DAYS_PER_RUN)
    if "gas" not in args.skip:
        fetch_gas()

    build_marginal(index)
    build_trends(index)
    build_intraday(index)
    build_stayon(index)
    build_curve_trends(index)
    build_node_curtail(index)
    build_marginal_nodes(index)
    build_econ(index)
    save_index(index)
    added = {k: sorted(set(index["days"][k]) - before.get(k, set())) for k in index["days"]}
    names = {"2d": "2-day curves", "2dgen": "2-day generation summary", "60d": "60-day curves",
             "dam": "60-day DAM offers and awards", "prices": "prices", "nodes": "resource-node prices"}
    lines = ["### ERCOT data update", "", "| Data | Days added | Range |", "|---|---|---|"]
    for k, v in added.items():
        lines.append(f"| {names.get(k, k)} | {len(v)} | {v[0] + ' to ' + v[-1] if v else '–'} |")
    lines += unit_file_summary()
    o = OVERRIDE_STATS
    if o["days"]:
        msg = (f"HDL/LDL overrides: {o['files']} file(s) read over {o['days']} day(s), "
               f"{o['rows']} row(s), {o['kept']} on the operating day, on {o['units']} unit-day(s)")
        if o["other"]:
            msg += "; other override files skipped: " + ", ".join(f"{k} ({v} rows)" for k, v in o["other"].items())
        if o["unmatched"]:
            warn(f"HDL/LDL override summary: limit columns not recognised, values left empty: {o['unmatched']}")
        if o["rows"] and not o["kept"]:
            warn(msg + f"; none matched the operating day (first timestamp {o['sample']})")
        else:
            print(f"::notice::{msg}" if os.environ.get("GITHUB_ACTIONS") == "true" else msg, flush=True)
            lines += ["", msg]
    lines += ["", f"**{len(WARNINGS)} warning(s)**" if WARNINGS else "No warnings."]
    lines += [f"- {w}" for w in WARNINGS[:50]]
    write_summary(lines)
    print("done:", {k: len(v) for k, v in added.items()}, f"{len(WARNINGS)} warning(s)")


if __name__ == "__main__":
    sys.exit(main())
