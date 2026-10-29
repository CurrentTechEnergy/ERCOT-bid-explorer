"""Keep ERCOT's 5-minute look-ahead reports in the raw store (pipeline/raw_store.py), one bulk zip
per report and posting day, for the operator-informed peaker model (Blair, Oct 29 2026).

  np6-970-cd  RTD Indicative LMPs by Resource Nodes, Load Zones and Hubs (archive from 2016)
  np4-751-cd  Intra-Hour Wind Power Forecast by Geographical Region   (archive from Mar 26 2026)
  np4-752-cd  Intra-Hour Solar Power Forecast by Geographical Region  (archive from Mar 26 2026)
  np3-562-cd  Intra-Hour Load Forecast by Weather Zone               (archive from Mar 26 2026)

Each posts 288 small files a day (RTD about 86 kB zipped, the forecasts about 3 kB), too many to
fetch one request at a time.  So, as pipeline/rt_as.py does for the 15-minute MCPCs, each day's
files come in one bulk download and the zip of zips is kept under raw/<emil>/day-YYYY-MM-DD
(posting day, ERCOT's Central time).  A day already in the bucket is never asked for again; a
day whose zip can't be stored stops the run, so nothing is downloaded that isn't kept.  Only
complete days (before today) are fetched.  Nothing is parsed here.

  python -m pipeline.raw_days --emil np4-751-cd,np4-752-cd,np3-562-cd --start 2026-03-26 --end 2026-10-28
  python -m pipeline.raw_days --emil np6-970-cd --start 2026-03-01 --end 2026-08-31 [--dry-run]
  python -m pipeline.raw_days --days 7          # the daily run: the last 7 complete days, every report
"""
import argparse
import datetime as dt
import io
import sys
import zipfile

from .ercot_api import ErcotAPI
from .log import warn

EMILS = ("np6-970-cd", "np4-751-cd", "np4-752-cd", "np3-562-cd")


def day_key(d: dt.date) -> str:
    return f"day-{d.isoformat()}"


def _bulk(api, emil: str, ids: list, d) -> bytes:
    """One bulk download of the documents.  ERCOT refuses the whole request when one document in
    it can't be served, so on a failure the list is split in halves until the bad documents are
    found and left out; the parts are packed into one zip of zips (as pipeline/rt_as.py)."""
    try:
        return api.download_many(emil, ids)[0]
    except RuntimeError as e:
        if len(ids) == 1:
            warn(f"{emil} {d}: document {ids[0]} left out ({str(e)[:120]})")
            return b""
    half = len(ids) // 2
    parts = [b for b in (_bulk(api, emil, ids[:half], d), _bulk(api, emil, ids[half:], d)) if b]
    if not parts:
        return b""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, b in enumerate(parts):
            z.writestr(f"part-{i}.zip", b)
    return buf.getvalue()


def fetch_day(api, emil: str, d: dt.date, dry_run=False) -> str:
    """'stored' (already there), 'fetched', 'empty', 'missing' (dry run) or 'failed'."""
    key = day_key(d)
    got = api.raw.has(emil, key)
    if got is None:
        return "failed"
    if got:
        return "stored"
    if dry_run:
        return "missing"
    t = dt.datetime(d.year, d.month, d.day)
    docs = api.list_archives(emil, t, t + dt.timedelta(days=1))
    if not docs:
        return "empty"
    ids = [x["docId"] for x in docs]
    if len(ids) > 1000:
        warn(f"{emil} {d}: {len(ids)} documents, only the first 1,000 kept")
    blob = _bulk(api, emil, ids[:1000], d)
    if not blob:
        return "empty"
    before = api.raw.stats["stored"]
    api.raw.put(emil, key, blob, {"friendlyName": f"bulk download of {len(docs)} documents posted {d}"})
    if api.raw.stats["stored"] == before:
        return "failed"
    print(f"  {emil} {d}: {len(docs)} files, {len(blob) / 1e6:.1f} MB stored", flush=True)
    return "fetched"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--emil", default=",".join(EMILS), help="comma-separated EMIL ids")
    ap.add_argument("--start", help="first posting day, YYYY-MM-DD")
    ap.add_argument("--end", help="last posting day, YYYY-MM-DD (at most yesterday)")
    ap.add_argument("--days", type=int, help="instead of --start/--end: the last N complete days")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    api = ErcotAPI()
    if not api.raw.enabled:
        print("raw store: R2_ENDPOINT, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is not set; nothing fetched")
        return 1
    yesterday = dt.date.today() - dt.timedelta(days=1)
    if a.days:
        lo, hi = yesterday - dt.timedelta(days=a.days - 1), yesterday
    else:
        lo, hi = dt.date.fromisoformat(a.start), min(dt.date.fromisoformat(a.end), yesterday)
    for emil in [e.strip().lower() for e in a.emil.split(",") if e.strip()]:
        counts = {}
        d = lo
        while d <= hi:
            r = fetch_day(api, emil, d, a.dry_run)
            counts[r] = counts.get(r, 0) + 1
            if r == "failed":
                print(f"{emil} {d}: the day's zip could not be stored (or the bucket asked); stopping")
                print(api.raw.summary())
                return 1
            d += dt.timedelta(days=1)
        print(f"{emil} {lo} to {hi}: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())), flush=True)
    print(api.raw.summary())
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
