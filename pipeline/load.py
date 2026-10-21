"""ERCOT system load, hourly: the seven-day load forecast ERCOT used and the actual load, for
net load (load less wind and solar) in the forecast's models.

Reports (ERCOT Public API):
  NP3-565-CD  Seven-Day Load Forecast by Model and Weather Zone (posted hourly; each posting
              carries every model's forecast for the current day and the next seven, with a
              flag on the model ERCOT is using)
  NP6-345-CD  Actual System Load by Weather Zone (posted daily for the previous operating day)
Columns are matched loosely by name (DeliveryDate / OperDay, HourEnding, SystemTotal / TOTAL,
Model, InUseFlag, DSTFlag); a file whose columns are not recognised is skipped with a warning
naming them.

For each operating day D the forecast kept is the in-use model's system total from the newest
posting at or before CUTOFF_HOUR Central on D - 1, as in pipeline/renew_forecast.py: what was
public when the day-ahead market for D cleared.  That posting's own first day is D - 1, which
is how a posting in a bulk download is matched to the day it was picked for.

Days from BACKFILL_FROM on with no forecast or no actual are filled from the archive in the
same run (bulk downloads, so the whole history comes in one update).  A day with no posting
before its cutoff is noted under "unavailable" and not asked for again.

Writes data/load.json.gz:
  {"days": {date: {"fc": [24] MW or null, "actual": [24] MW or null, "posted": ts}},
   "unavailable": [date, ...]}

  python -m pipeline.load --sample      # parse a few recent postings and print them (CI check)
"""
import argparse
import datetime as dt
import io

import pandas as pd

from .config import DATA_DIR
from .curves import to_iso_date
from .log import warn
from .renew_forecast import CUTOFF_HOUR, _cutoff, _find
from .store import iter_csvs, read_json_gz, write_json_gz

PATH = DATA_DIR / "load.json.gz"
EMIL_FC = "np3-565-cd"
EMIL_ACTUAL = "np6-345-cd"
LOOKBACK_DAYS = 3
BACKFILL_FROM = dt.date(2024, 1, 1)     # the first month of the thermal history (pipeline/history.py)


def _frame(f: pd.DataFrame, date_col, he_col, total_col) -> pd.DataFrame:
    flag = _find(f.columns, "dstflag") or _find(f.columns, "repeatedhourflag")
    g = pd.DataFrame({
        "date": to_iso_date(f[date_col].astype(str).str.strip()),
        "he": pd.to_numeric(f[he_col].astype(str).str.split(":").str[0], errors="coerce"),
        "flag": f[flag].astype(str).str.strip().str.upper() if flag else "N",
        "mw": pd.to_numeric(f[total_col], errors="coerce"),
    })
    return g[(g["flag"] != "Y") & g["he"].between(1, 24)]


def _days(g: pd.DataFrame) -> dict:
    out = {}
    for d, rows in g.groupby("date"):
        v = [None] * 24
        for h, mw in zip(rows["he"].astype(int), rows["mw"]):
            if pd.notna(mw):
                v[h - 1] = round(float(mw), 1)
        if any(x is not None for x in v):
            out[d] = v
    return out


def read_forecast(csvs) -> list:
    """CSVs of NP3-565-CD -> [{date: [24] in-use system total}], one dict per posting (its
    days in order, the first being the posting's own day)."""
    out = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        date = _find(f.columns, "deliverydate") or _find(f.columns, "date")
        he = _find(f.columns, "hourending") or _find(f.columns, "hour")
        tot = _find(f.columns, "systemtotal") or _find(f.columns, "total")
        use = _find(f.columns, "inuse")
        if not (date and he and tot):
            warn(f"load forecast file {n}: columns not recognised: {list(f.columns)}")
            continue
        if use:
            f = f[f[use].astype(str).str.strip().str.upper().isin(["Y", "TRUE", "1"])]
        got = _days(_frame(f, date, he, tot))
        if got:
            out.append(dict(sorted(got.items())))
    return out


def read_actual(csvs) -> dict:
    """CSVs of NP6-345-CD -> {date: [24] ERCOT total}."""
    out = {}
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        date = _find(f.columns, "operday") or _find(f.columns, "date")
        he = _find(f.columns, "hourending") or _find(f.columns, "hour")
        tot = _find(f.columns, "total")
        if not (date and he and tot):
            warn(f"actual load file {n}: columns not recognised: {list(f.columns)}")
            continue
        out.update(_days(_frame(f, date, he, tot)))
    return out


def _bulk(api, emil, docs):
    """All CSVs of `docs`, downloaded in bulk (1000 a request)."""
    csvs = []
    for blob in api.download_many(emil, [x["docId"] for x in docs]) if docs else []:
        csvs.extend(iter_csvs(blob, "x.zip"))
    return csvs


def fetch_load(api, index: dict = None, today: dt.date = None) -> None:
    today = today or dt.date.today()
    store = read_json_gz(PATH, default=None) or {"days": {}}
    days = store["days"]
    unavailable = set(store.get("unavailable", []))
    recent = {(today + dt.timedelta(days=k)).isoformat() for k in range(-LOOKBACK_DAYS, 2)}
    span = [(BACKFILL_FROM + dt.timedelta(days=k)).isoformat() for k in range((today - BACKFILL_FROM).days + 2)]
    want_fc = [d for d in span if d in recent or (not (days.get(d) or {}).get("fc") and d not in unavailable)]
    want_act = [d for d in span if d < today.isoformat() and (d in recent or not (days.get(d) or {}).get("actual"))]
    until = dt.datetime.combine(today + dt.timedelta(days=1), dt.time())

    if want_fc:
        since = dt.datetime.combine(dt.date.fromisoformat(want_fc[0]) - dt.timedelta(days=2), dt.time())
        try:
            docs = sorted(api.list_archives(EMIL_FC, since, until), key=lambda x: x.get("postDatetime", ""))
        except Exception as e:
            warn(f"load forecast: listing failed: {type(e).__name__}: {e}")
            docs = None
        if docs is not None:
            picks, no_post, j = {}, set(), 0
            posts = [x.get("postDatetime", "")[:19] for x in docs]
            for d in want_fc:          # want_fc and docs both ascending: walk them together
                cut = _cutoff(d)
                while j < len(docs) and posts[j] <= cut:
                    j += 1
                if j and posts[j - 1][:10] == (dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat():
                    picks[d] = docs[j - 1]
                elif d < today.isoformat():
                    no_post.add(d)
            by_doc = {x["docId"]: x for x in picks.values()}
            if picks:
                print(f"load forecast: {len(picks)} day(s) to fill, {min(picks)} to {max(picks)}")
            try:
                posted = read_forecast(_bulk(api, EMIL_FC, list(by_doc.values())))
            except Exception as e:
                warn(f"load forecast: download failed: {type(e).__name__}: {e}")
                posted, no_post = [], set()
            when = {d: x.get("postDatetime", "")[:19] for d, x in picks.items()}
            for p in posted:
                first = min(p)
                d = (dt.date.fromisoformat(first) + dt.timedelta(days=1)).isoformat()
                if d in picks and d in p:
                    e = days.setdefault(d, {})
                    e["fc"], e["posted"] = p[d], when[d]
            unavailable |= {d for d in no_post if d < (today - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()}

    if want_act:
        since = dt.datetime.combine(dt.date.fromisoformat(want_act[0]), dt.time())
        try:
            docs = api.list_archives(EMIL_ACTUAL, since, until)
            got = read_actual(_bulk(api, EMIL_ACTUAL, docs))
        except Exception as e:
            warn(f"actual load: failed: {type(e).__name__}: {e}")
            got = {}
        for d, v in got.items():
            if d >= BACKFILL_FROM.isoformat():
                days.setdefault(d, {})["actual"] = v

    store["days"] = dict(sorted(days.items()))
    store["unavailable"] = sorted(unavailable)
    write_json_gz(PATH, store)
    fc = [d for d, v in days.items() if v.get("fc")]
    act = [d for d, v in days.items() if v.get("actual")]
    print(f"load: forecast for {len(fc)} day(s)" + (f" ({min(fc)} to {max(fc)})" if fc else "")
          + f", actual for {len(act)}" + (f" ({min(act)} to {max(act)})" if act else "")
          + (f", {len(unavailable)} not in the archive" if unavailable else ""))


def sample(api, days=3):
    """Parse the last few days' postings of both reports and print what was read."""
    now = dt.datetime.now()
    docs = sorted(api.list_archives(EMIL_FC, now - dt.timedelta(days=days), now), key=lambda x: x.get("postDatetime", ""))
    print(f"{EMIL_FC}: {len(docs)} posting(s) in {days} days")
    if docs:
        csvs = list(iter_csvs(api.download(EMIL_FC, docs[-1]["docId"]), "x.zip"))
        f = pd.read_csv(io.BytesIO(csvs[0][1]))
        print("  columns:", list(f.columns))
        print(f.head(3).to_string())
        for p in read_forecast(csvs):
            for d, v in p.items():
                print(f"  {d}: {v[:6]} ...")
    docs = api.list_archives(EMIL_ACTUAL, now - dt.timedelta(days=days), now)
    print(f"{EMIL_ACTUAL}: {len(docs)} posting(s) in {days} days")
    if docs:
        csvs = _bulk(api, EMIL_ACTUAL, docs)
        f = pd.read_csv(io.BytesIO(csvs[0][1]))
        print("  columns:", list(f.columns))
        print(f.head(3).to_string())
        for d, v in sorted(read_actual(csvs).items()):
            print(f"  {d}: {v[:6]} ...")
    old = dt.datetime.combine(BACKFILL_FROM, dt.time())
    for emil in (EMIL_FC, EMIL_ACTUAL):
        n = len(api.list_archives(emil, old, old + dt.timedelta(days=2)))
        print(f"{emil}: {n} posting(s) in the first two days of {BACKFILL_FROM:%b %Y}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", action="store_true", help="parse a few recent postings and print them")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    if args.sample:
        sample(api)
    else:
        fetch_load(api)


if __name__ == "__main__":
    main()
