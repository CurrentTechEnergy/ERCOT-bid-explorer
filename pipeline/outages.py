"""ERCOT's resource outage reports, kept for the commitment forecast (pipeline/models/
thermal_cutoff.py).  The 60-day disclosure shows a unit's outage about sixty days late; these two
reports show outages within days, or ahead of time.  Collected only for now: no model reads them
yet.

Reports (ERCOT Public API):
  NP1-346-ER  Unplanned Resource Outages Report.  Posted daily (about 05:00 Central): every
              forced and maintenance outage or derate active in the Outage Scheduler at any
              time on the third day before the posting date, one row per unit (resource name,
              unit code, fuel, outage type, MW, actual start, planned end, actual end, nature of
              work).  Planned outages are not in it.  A spreadsheet (.xlsx) in a zip; the data
              sheet is the one whose header row starts "Resource Name".  Combined-cycle units
              are listed by physical turbine, not by the configurations the 60-day data names.
  NP3-233-CD  Hourly Resource Outage Capacity.  Posted hourly for the next 168 hours: MW on
              outage (planned, forced and maintenance) by load zone, with the intermittent
              renewable and new-equipment parts split out.  No unit names.

Writes:
  data/outages/unplanned/<snapshot date>.json.gz   one per NP1-346-ER posting
      {date (the day the snapshot covers), posted, as_of (the report's "Current as of"),
       columns, rows}
      columns: unit, resource, fuel, type, mw_max, mw_avail, mw_out, start, planned_end,
               actual_end, nature (times as ISO strings, Central, as ERCOT gives them)
  data/outages/capacity.json.gz
      {"days": {date: {"posted": ts, "zones": [...], "total": {zone: [24]}, "irr": {...},
                       "new": {...}}}}
      for each operating day D, the newest NP3-233-CD posting at or before CUTOFF_HOUR on D - 1
      (what was public when the day-ahead market for D cleared, as pipeline/renew_forecast.py
      does), so a day's outage MW does not drift as later postings arrive.
"""
import datetime as dt
import io
import zipfile
from pathlib import Path

import pandas as pd

from .config import DATA_DIR
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs, read_json_gz, write_json_gz

OUT_DIR = DATA_DIR / "outages"
UNPLANNED_DIR = OUT_DIR / "unplanned"
CAPACITY_PATH = OUT_DIR / "capacity.json.gz"
EMIL_UNPLANNED = "np1-346-er"
EMIL_CAPACITY = "np3-233-cd"
CUTOFF_HOUR = 14          # Central: the day-ahead market for D clears by about 13:30 on D - 1
LOOKBACK_DAYS = 7
SNAPSHOT_LAG = 3          # NP1-346-ER covers the third day before its posting date
UNPLANNED_COLS = ["unit", "resource", "fuel", "type", "mw_max", "mw_avail", "mw_out", "start", "planned_end",
                  "actual_end", "nature"]
HEADER = {"resourceunitcode": "unit", "resourcename": "resource", "fueltype": "fuel", "outagetype": "type",
          "availablemwmaximum": "mw_max", "availablemwduringoutage": "mw_avail",
          "effectivemwreductionduetooutage": "mw_out", "actualoutagestart": "start",
          "plannedenddate": "planned_end", "actualenddate": "actual_end", "natureofwork": "nature"}


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _files(blob: bytes, name: str = "x.zip"):
    """(name, bytes) of every .xlsx and .csv inside a zip, descending into nested zips."""
    if name.lower().endswith((".xlsx", ".csv")):
        yield name, blob
        return
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            inner = zf.read(info)
            fn = info.filename.lower()
            if fn.endswith(".zip"):
                yield from _files(inner, info.filename)
            elif fn.endswith((".xlsx", ".csv")):
                yield Path(info.filename).name, inner


def _iso(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v is pd.NaT:
        return None
    t = pd.to_datetime(v, errors="coerce")
    return None if pd.isna(t) else t.strftime("%Y-%m-%dT%H:%M")


def _num(v):
    x = pd.to_numeric(v, errors="coerce")
    return None if pd.isna(x) else round(float(x), 1)


def read_unplanned(blob: bytes) -> tuple:
    """One NP1-346-ER posting -> (as_of text or None, rows in UNPLANNED_COLS order)."""
    for name, b in _files(blob):
        if name.lower().endswith(".csv"):
            sheets = [pd.read_csv(io.BytesIO(b), header=None, dtype=object)]
        else:
            sheets = list(pd.read_excel(io.BytesIO(b), sheet_name=None, header=None, dtype=object).values())
        for f in sheets:
            first = f.iloc[:, 0].astype(str).map(_norm)
            hdr = first[first == "resourcename"].index
            if not len(hdr):
                continue
            h = hdr[0]
            cols = {i: HEADER.get(_norm(c)) for i, c in enumerate(f.iloc[h])}
            if "unit" not in cols.values() or "start" not in cols.values():
                continue        # the info sheet's column descriptions also start "Resource Name"
            as_of = next((str(v).split(":", 1)[1].strip() for v in f.iloc[:h, 0] if str(v).lower().startswith("current as of")), None)
            rows = []
            for _, r in f.iloc[h + 1:].iterrows():
                e = {k: r.iloc[i] for i, k in cols.items() if k}
                if not isinstance(e.get("unit"), str) or not e["unit"].strip():
                    continue
                rows.append([e["unit"].strip(), str(e.get("resource") or "").strip(), str(e.get("fuel") or "").strip(),
                             str(e.get("type") or "").strip(), _num(e.get("mw_max")), _num(e.get("mw_avail")),
                             _num(e.get("mw_out")), _iso(e.get("start")), _iso(e.get("planned_end")),
                             _iso(e.get("actual_end")), str(e.get("nature") or "").strip() or None])
            return as_of, rows
    warn("unplanned outages: no sheet with the expected column headers in the posting")
    return None, []


def read_capacity(csvs) -> dict:
    """CSVs of one NP3-233-CD posting -> {date: {"total"|"irr"|"new": {zone: [24]}}}."""
    out = {}
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        cols = {_norm(c): c for c in f.columns}
        date, he = cols.get("date") or cols.get("operatingdate"), cols.get("hourending")
        groups = {"total": "totalresourcemwzone", "irr": "totalirrmwzone", "new": "totalnewequipresourcemwzone"}
        zc = {g: {k[len(p):]: c for k, c in cols.items() if k.startswith(p)} for g, p in groups.items()}
        if not (date and he and zc["total"]):
            warn(f"outage capacity file {n}: columns not recognised: {list(f.columns)}")
            continue
        days = to_iso_date(f[date].astype(str).str.strip())
        hours = pd.to_numeric(f[he].astype(str).str.split(":").str[0], errors="coerce")
        for i in range(len(f)):
            h = hours.iloc[i]
            if pd.isna(h) or not 1 <= h <= 24:
                continue
            e = out.setdefault(days.iloc[i], {g: {z: [None] * 24 for z in zc[g]} for g in groups})
            for g in groups:
                for z, c in zc[g].items():
                    v = pd.to_numeric(f[c].iloc[i], errors="coerce")
                    if pd.notna(v):
                        e[g][z][int(h) - 1] = round(float(v), 1)
    return out


def _cutoff(date: str) -> str:
    d = dt.date.fromisoformat(date) - dt.timedelta(days=1)
    return f"{d.isoformat()}T{CUTOFF_HOUR:02d}:00:00"


def fetch_unplanned(api, today: dt.date) -> list:
    since = dt.datetime.combine(today - dt.timedelta(days=LOOKBACK_DAYS), dt.time())
    until = dt.datetime.combine(today + dt.timedelta(days=1), dt.time())
    try:
        docs = api.list_archives(EMIL_UNPLANNED, since, until)
    except Exception as e:
        warn(f"unplanned outages: listing failed: {type(e).__name__}: {e}")
        return []
    got = []
    for doc in sorted(docs, key=lambda d: d.get("postDatetime", "")):
        posted = doc.get("postDatetime", "")[:19]
        if not posted:
            continue
        date = (dt.date.fromisoformat(posted[:10]) - dt.timedelta(days=SNAPSHOT_LAG)).isoformat()
        path = UNPLANNED_DIR / f"{date}.json.gz"
        cur = read_json_gz(path, default=None) if path.exists() else None
        if cur and cur.get("posted", "") >= posted:
            continue
        try:
            as_of, rows = read_unplanned(api.download(EMIL_UNPLANNED, doc["docId"]))
        except Exception as e:
            warn(f"unplanned outages (doc {doc.get('docId')}): failed: {type(e).__name__}: {e}")
            continue
        if not rows:
            continue
        UNPLANNED_DIR.mkdir(parents=True, exist_ok=True)
        write_json_gz(path, {"date": date, "posted": posted, "as_of": as_of, "columns": UNPLANNED_COLS, "rows": rows})
        got.append(date)
    return got


def fetch_capacity(api, today: dt.date) -> list:
    store = read_json_gz(CAPACITY_PATH, default=None) or {"days": {}}
    days = store["days"]
    since = dt.datetime.combine(today - dt.timedelta(days=2), dt.time())
    until = dt.datetime.combine(today + dt.timedelta(days=1), dt.time())
    try:
        docs = api.list_archives(EMIL_CAPACITY, since, until)
    except Exception as e:
        warn(f"outage capacity: listing failed: {type(e).__name__}: {e}")
        return []
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    picks = {}
    for k in range(0, 2):
        d = (today + dt.timedelta(days=k)).isoformat()
        ok = [x for x in docs if x.get("postDatetime", "")[:19] <= _cutoff(d)]
        if ok and days.get(d, {}).get("posted", "") < ok[-1]["postDatetime"][:19]:
            picks.setdefault(ok[-1]["docId"], []).append(d)
    got = []
    for doc_id, for_days in picks.items():
        doc = next(x for x in docs if x["docId"] == doc_id)
        try:
            data = read_capacity(list(iter_csvs(api.download(EMIL_CAPACITY, doc_id), "x.zip")))
        except Exception as e:
            warn(f"outage capacity (doc {doc_id}): failed: {type(e).__name__}: {e}")
            continue
        for d in for_days:
            if d in data:
                days[d] = {"posted": doc["postDatetime"][:19], "zones": sorted(data[d]["total"]), **data[d]}
                got.append(d)
    store["days"] = dict(sorted(days.items()))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_json_gz(CAPACITY_PATH, store)
    return got


def fetch_outages(api, index: dict, today: dt.date = None) -> None:
    today = today or dt.date.today()
    un = fetch_unplanned(api, today)
    cap = fetch_capacity(api, today)
    have = sorted(p.name[:10] for p in UNPLANNED_DIR.glob("20*.json.gz")) if UNPLANNED_DIR.exists() else []
    print(f"outages: {len(un)} unplanned snapshot(s) added ({len(have)} kept"
          + (f", latest {have[-1]}" if have else "") + f"), outage capacity for {', '.join(cap) or 'no new day'}")
