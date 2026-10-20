"""Day-ahead system lambda (NP4-523-CD, "DAM System Lambda"), hourly, for the Overview's hub
price chart, where it sits beside the real-time system lambda (NP6-322-CD) as a like-for-like
pair.  ERCOT's prices carry no loss component, so the hub average is this lambda plus the hubs'
congestion.

The report for operating day D is posted with the DAM results around 13:30 Central on D - 1.
Writes data/dam_lambda.json.gz:
  {"days": {date: [24 x $/MWh or null]}}
Hours are hour ending 1..24 stored at index 0..23; on the fall-back day the repeated hour is
dropped, as in pipeline/dam_prices.py.
"""
import datetime as dt
import io
from typing import Iterable, Tuple

import pandas as pd

from .config import DATA_DIR, EMIL_DAM_LAMBDA
from .curves import to_iso_date
from .dam_prices import _norm
from .log import warn
from .store import iter_csvs, read_json_gz, write_json_gz

PATH = DATA_DIR / "dam_lambda.json.gz"
DAYS = 400      # days kept, newest first; a run fetches the missing ones in this span
LIMIT = 60      # days fetched a run, newest first, so a backfill spreads over runs


def read_dam_lambda(csvs: Iterable[Tuple[str, bytes]]) -> dict:
    """NP4-523-CD CSVs -> {date: [24]}."""
    out = {}
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        c = {_norm(k): k for k in f.columns}
        if any(k not in c for k in ("deliverydate", "hourending", "systemlambda")):
            warn(f"Unrecognised DAM system lambda columns in {n}: {list(f.columns)}")
            continue
        flag = c.get("dstflag") or c.get("repeatedhourflag")
        if flag:
            f = f[f[flag].astype(str).str.strip().str.upper() != "Y"]
        dates = to_iso_date(f[c["deliverydate"]].astype(str).str.strip())
        hes = pd.to_numeric(f[c["hourending"]].astype(str).str.split(":").str[0], errors="coerce")
        for d, he, v in zip(dates, hes, pd.to_numeric(f[c["systemlambda"]], errors="coerce")):
            if pd.notna(he) and 1 <= he <= 24 and pd.notna(v):
                out.setdefault(d, [None] * 24)[int(he) - 1] = round(float(v), 2)
    return out


def fetch_dam_lambda(api, today: dt.date = None) -> None:
    """DA system lambda for the last DAYS days up to tomorrow, those not yet stored."""
    today = today or dt.date.today()
    store = read_json_gz(PATH, default=None) or {"days": {}}
    want = [(today + dt.timedelta(days=k)).isoformat() for k in range(1, 1 - DAYS, -1)]
    todo = [d for d in want if d not in store["days"]][:LIMIT]
    if not todo:
        return
    print(f"DA system lambda: fetching {len(todo)} day(s), {todo[-1]} to {todo[0]}")
    since = dt.datetime.combine(dt.date.fromisoformat(todo[-1]) - dt.timedelta(days=2), dt.time())
    until = dt.datetime.combine(dt.date.fromisoformat(todo[0]) + dt.timedelta(days=1), dt.time())
    try:
        docs = api.list_archives(EMIL_DAM_LAMBDA, since, until)
        blobs = api.download_many(EMIL_DAM_LAMBDA, [x["docId"] for x in docs]) if docs else []
        got = read_dam_lambda([c for b in blobs for c in iter_csvs(b, "x.zip")])
    except Exception as e:   # a lambda problem must not lose the rest of the run
        warn(f"DA system lambda: failed: {type(e).__name__}: {e}")
        return
    store["days"].update({d: v for d, v in got.items() if d >= want[-1]})
    store["days"] = dict(sorted((d, v) for d, v in store["days"].items() if d >= want[-1]))
    write_json_gz(PATH, store)
