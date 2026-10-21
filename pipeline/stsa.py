"""ERCOT's Short-Term System Adequacy report (NP3-763-CD), hourly, for the commitment model:
the generation capacity the QSEs' current operating plans show online, and the capacity
available offline, for each hour of the current day and the next six.  Posted hourly.

For each operating day D the values kept are from the newest posting at or before CUTOFF_HOUR
Central on D - 1, as in pipeline/load.py: what the COPs said before the day-ahead market for D
cleared.  A posting's first delivery date is its own day, which is how a posting in a bulk
download is matched to the day it was picked for.  Days from BACKFILL_FROM on are filled from
the archive in one run; a day with no posting before its cutoff is noted under "unavailable".

Columns kept (MW, ERCOT total):
  online    CapGenResTotal           generation resources online in the COPs
  offline   OfflineAvailableMWTotal  generation resources offline but available
  load_res  CapLoadResTotal          load resources

Writes data/stsa.json.gz:
  {"days": {date: {"online": [24], "offline": [24], "load_res": [24], "posted": ts}},
   "unavailable": [date, ...]}

  python -m pipeline.stsa --sample OUT  # fill OUT, not the site's file, and print a few days (CI check)
"""
import argparse
import datetime as dt
import io

import pandas as pd
from pathlib import Path

from .config import DATA_DIR
from .load import BACKFILL_FROM, LOOKBACK_DAYS, _bulk, _days, _frame
from .log import warn
from .renew_forecast import _cutoff, _find
from .store import iter_csvs, read_json_gz, write_json_gz

PATH = DATA_DIR / "stsa.json.gz"
EMIL = "np3-763-cd"
FIELDS = {"online": "capgenrestotal", "offline": "offlineavailablemwtotal", "load_res": "caploadrestotal"}


def read_postings(csvs) -> list:
    """CSVs of NP3-763-CD -> [{date: {field: [24]}}], one dict per posting, its days in order."""
    out = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        date, he = _find(f.columns, "deliverydate"), _find(f.columns, "hourending")
        cols = {k: _find(f.columns, c) for k, c in FIELDS.items()}
        if not (date and he and cols["online"]):
            warn(f"STSA file {n}: columns not recognised: {list(f.columns)}")
            continue
        p = {}
        for k, c in cols.items():
            if c:
                for d, v in _days(_frame(f, date, he, c)).items():
                    p.setdefault(d, {})[k] = v
        if p:
            out.append(dict(sorted(p.items())))
    return out


def fetch_stsa(api, index: dict = None, today: dt.date = None, path=None) -> None:
    today = today or dt.date.today()
    path = path or PATH
    store = read_json_gz(path, default=None) or {"days": {}}
    days = store["days"]
    unavailable = set(store.get("unavailable", []))
    recent = {(today + dt.timedelta(days=k)).isoformat() for k in range(-LOOKBACK_DAYS, 2)}
    span = [(BACKFILL_FROM + dt.timedelta(days=k)).isoformat() for k in range((today - BACKFILL_FROM).days + 2)]
    want = [d for d in span if d in recent or (d not in days and d not in unavailable)]
    if not want:
        return
    since = dt.datetime.combine(dt.date.fromisoformat(want[0]) - dt.timedelta(days=2), dt.time())
    until = dt.datetime.combine(today + dt.timedelta(days=1), dt.time())
    try:
        docs = sorted(api.list_archives(EMIL, since, until), key=lambda x: x.get("postDatetime", ""))
    except Exception as e:
        warn(f"STSA: listing failed: {type(e).__name__}: {e}")
        return
    picks, no_post, j = {}, set(), 0
    posts = [x.get("postDatetime", "")[:19] for x in docs]
    for d in want:              # want and docs both ascending: walk them together
        cut = _cutoff(d)
        while j < len(docs) and posts[j] <= cut:
            j += 1
        if j and posts[j - 1][:10] == (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat():
            picks[d] = docs[j - 1]
        elif d < today.isoformat():
            no_post.add(d)
    if picks:
        print(f"STSA: {len(picks)} day(s) to fill, {min(picks)} to {max(picks)}")
    try:
        posted = read_postings(_bulk(api, EMIL, list({x["docId"]: x for x in picks.values()}.values())))
    except Exception as e:
        warn(f"STSA: download failed: {type(e).__name__}: {e}")
        posted, no_post = [], set()
    when = {d: x.get("postDatetime", "")[:19] for d, x in picks.items()}
    for p in posted:
        d = (dt.date.fromisoformat(min(p)) + dt.timedelta(days=1)).isoformat()
        if d in picks and d in p:
            days[d] = {**p[d], "posted": when[d]}
    unavailable |= {d for d in no_post if d < (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()}
    store["days"] = dict(sorted(days.items()))
    store["unavailable"] = sorted(unavailable)
    write_json_gz(path, store)
    print(f"STSA: {len(days)} day(s)" + (f" ({min(days)} to {max(days)})" if days else "")
          + (f", {len(unavailable)} not in the archive" if unavailable else ""))


def sample(api, out):
    """Fill `out` from BACKFILL_FROM to today as fetch_stsa would, and print the first and last days."""
    fetch_stsa(api, path=out)
    got = read_json_gz(out, default={"days": {}})["days"]
    for d in list(got)[:3] + list(got)[-4:]:
        v = got[d]
        print(f"  {d} (posted {v.get('posted')}): " + ", ".join(
            f"{k} {min(x for x in v[k] if x is not None):,.0f}-{max(x for x in v[k] if x is not None):,.0f}"
            for k in FIELDS if v.get(k) and any(x is not None for x in v[k])))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", metavar="OUT", help="fill OUT instead of data/stsa.json.gz and print a few days")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    if args.sample:
        sample(api, Path(args.sample))
    else:
        fetch_stsa(api)


if __name__ == "__main__":
    main()
