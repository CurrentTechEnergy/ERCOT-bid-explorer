"""Each thermal unit's Current Operating Plan (COP) status by hour, from ERCOT's 60-day COP All
Updates (NP3-991-EX), for the operator-informed model (pipeline/models/operator_informed.py).

NP3-991-EX carries every COP update a QSE made for one operating day, each with its update time,
and is posted about 60 days after the day (one zip a day, about 10 MB).  From it, for every
thermal resource and hour ending, the status the QSE had planned:

  da    as of DA_HOUR Central on the day before (after the day-ahead market clears)
  live  as of an hour before the hour starts ((h - 2):00 on the day for hour ending h)

"" where the resource had no plan for the hour by then; cancelled updates are dropped.

Downloads go through ErcotAPI.download, which reads the R2 raw store first and keeps every zip it
gets from ERCOT there, so a day is downloaded from ERCOT once.  Each run takes the 60-day DAM days
that have no COP file yet, newest first, at most PER_RUN of them, and the docs posted in the window
those days need (the doc for day D is posted about D + 60).  A doc's delivery date is read from the
file itself.  Docs already read are kept in index["docs"]["cop"] and not opened again.

Writes data/cop/<date>.json.gz: {"date", "format", "da_hour", "units": {resource: {"da": [24],
"live": [24]}}} for resources the day's DAM file lists as thermal, and index["days"]["cop"].
"""
import datetime as dt
import io

import pandas as pd

from .config import DATA_DIR, EMIL_COP
from .log import warn
from .store import iter_csvs, read_json_gz, write_json_gz

COP_DIR = DATA_DIR / "cop"
COP_FORMAT = 1
DA_HOUR = 14          # Central: the day-ahead market for D clears by about 13:30 on D - 1
PER_RUN = 40          # days a run fills; reads from the raw store are quick, ERCOT downloads take seconds each
LAG = 60              # days from the operating day to the posting
THERMAL = ("coal", "combined_cycle", "gas_steam", "combustion_turbine")


def plans(csv: bytes) -> tuple:
    """One NP3-991-EX file -> (delivery date, {resource: {"da": [24], "live": [24]}})."""
    f = pd.read_csv(io.BytesIO(csv), usecols=["Delivery Date", "Resource Name", "Hour Ending", "Status",
                                              "Cancel Flag", "Update Time"], dtype=str)
    f = f[f["Cancel Flag"].fillna("").str.strip().str.upper() != "Y"]
    day = pd.to_datetime(f["Delivery Date"].iloc[0], format="%m/%d/%Y").date()
    f = f.assign(t=pd.to_datetime(f["Update Time"], format="%m/%d/%Y %H:%M:%S", errors="coerce"),
                 he=pd.to_numeric(f["Hour Ending"].str.split(":").str[0], errors="coerce"),
                 s=f["Status"].fillna("").str.strip())
    f = f[f["he"].between(1, 24)].sort_values("t")
    d0 = pd.Timestamp(day)
    out = {}
    for kind, cut in (("da", f["t"] <= d0 - pd.Timedelta(days=1) + pd.Timedelta(hours=DA_HOUR)),
                      ("live", f["t"] <= d0 + pd.to_timedelta(f["he"] - 2, unit="h"))):
        last = f[cut].groupby(["Resource Name", "he"]).tail(1)
        for r, he, s in zip(last["Resource Name"], last["he"].astype(int), last["s"]):
            out.setdefault(r, {"da": [""] * 24, "live": [""] * 24})[kind][he - 1] = s
    return day.isoformat(), out


def _thermal(date: str) -> set:
    dd = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz", default=None) or {}
    return {n for n, u in dd.get("units", {}).items() if u.get("tech") in THERMAL}


def fetch_cop(api, index: dict) -> None:
    have = {p.name[:10] for p in COP_DIR.glob("*.json.gz")} if COP_DIR.exists() else set()
    want = sorted(set(index["days"].get("dam", [])) - have, reverse=True)[:PER_RUN]
    index["days"]["cop"] = sorted(set(index["days"].get("cop", [])) | have)
    if not want:
        return
    lo, hi = dt.date.fromisoformat(want[-1]), dt.date.fromisoformat(want[0])
    try:
        docs = api.list_archives(EMIL_COP, dt.datetime.combine(lo + dt.timedelta(days=LAG - 3), dt.time()),
                                 dt.datetime.combine(hi + dt.timedelta(days=LAG + 4), dt.time()))
    except Exception as e:
        warn(f"COP: listing failed: {type(e).__name__}: {e}")
        return
    seen = index.setdefault("docs", {}).setdefault("cop", [])
    wanted = set(want)
    done = set()
    for x in sorted(docs, key=lambda d: d.get("postDatetime", ""), reverse=True):
        posted = dt.date.fromisoformat(x.get("postDatetime", "")[:10])
        guess = {(posted - dt.timedelta(days=LAG + k)).isoformat() for k in (-2, -1, 0, 1, 2)}
        if x["docId"] in seen or not guess & (wanted - done):
            continue
        try:
            for _, b in iter_csvs(api.download(EMIL_COP, x["docId"]), "x.zip"):
                d, p = plans(b)
                keep = _thermal(d)
                write_json_gz(COP_DIR / f"{d}.json.gz", {"date": d, "format": COP_FORMAT, "da_hour": DA_HOUR,
                                                         "units": {r: v for r, v in p.items() if r in keep}})
                done.add(d)
                if d not in index["days"].setdefault("cop", []):
                    index["days"]["cop"].append(d)
            seen.append(x["docId"])
        except Exception as e:
            warn(f"COP: doc {x['docId']} ({x.get('postDatetime')}) not read: {type(e).__name__}: {e}")
    index["days"]["cop"] = sorted(index["days"].get("cop", []))
    print(f"COP: {len(done)} day(s) written of {len(want)} wanted ({want[-1]} to {want[0]})", flush=True)
