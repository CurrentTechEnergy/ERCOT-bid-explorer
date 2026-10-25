"""One-off (not for merge): each resource's COP plan from ERCOT's 60-day COP All Updates
(NP3-991-EX) for the 60-day operating days the operator-informed model is fitted on.

  python scratch_cop.py list    the archive docs for the window (no downloads)
  python scratch_cop.py fetch   each doc through ErcotAPI.download, which reads the R2 raw store
                                first and writes every zip it gets from ERCOT to it (the run stops
                                at once when R2 is not configured), and writes cop.json.gz

cop.json.gz: {delivery date: {resource: {"da": [24] status as of 14:00 Central on D - 1 (after
the DAM), "live": [24] status of hour ending h as of (h - 2):00 on D, an hour before the hour
starts}}}, "" where the resource had no plan for the hour by then.  Rewritten every 20 days, so
a run that times out keeps what it had.  Plans follow pipeline/cop_probe.py on cop-probe.
"""
import datetime as dt
import gzip
import io
import json
import sys

import pandas as pd

from pipeline.ercot_api import ErcotAPI
from pipeline.store import iter_csvs

EMIL = "np3-991-ex"
FIRST, LAST = dt.date(2025, 11, 30), dt.date(2026, 8, 25)
DA_HOUR = 14


def plans(csv: bytes):
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
    da = f[f["t"] <= d0 - pd.Timedelta(days=1) + pd.Timedelta(hours=DA_HOUR)].groupby(["Resource Name", "he"]).tail(1)
    for r, he, s in zip(da["Resource Name"], da["he"].astype(int), da["s"]):
        out.setdefault(r, {"da": [""] * 24, "live": [""] * 24})["da"][he - 1] = s
    live = f[f["t"] <= d0 + pd.to_timedelta(f["he"] - 2, unit="h")].groupby(["Resource Name", "he"]).tail(1)
    for r, he, s in zip(live["Resource Name"], live["he"].astype(int), live["s"]):
        out.setdefault(r, {"da": [""] * 24, "live": [""] * 24})["live"][he - 1] = s
    return day.isoformat(), out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "list"
    api = ErcotAPI()
    if mode == "fetch" and not api.raw.endpoint:
        sys.exit("R2 raw store is not configured: refusing to download")
    docs = api.list_archives(EMIL, dt.datetime.combine(FIRST + dt.timedelta(days=58), dt.time()),
                             dt.datetime.combine(LAST + dt.timedelta(days=63), dt.time()))
    docs = sorted(docs, key=lambda d: d.get("postDatetime", ""))
    print(f"{EMIL}: {len(docs)} docs posted {docs[0].get('postDatetime') if docs else '-'} to {docs[-1].get('postDatetime') if docs else '-'}")
    for x in docs[:2] + docs[-2:]:
        print("  ", {k: x.get(k) for k in ("postDatetime", "friendlyName", "docId")})
    print("R2 raw store configured:", bool(api.raw.endpoint))
    if mode != "fetch":
        return
    res = {}
    for i, x in enumerate(docs):
        try:
            for _, b in iter_csvs(api.download(EMIL, x["docId"]), "x.zip"):
                d, p = plans(b)
                if FIRST.isoformat() <= d <= LAST.isoformat():
                    res[d] = p
                    print(f"{d}: {len(p)} resources", flush=True)
        except Exception as e:
            print(f"{x.get('postDatetime')}: failed: {type(e).__name__}: {e}", flush=True)
        if i % 20 == 19 or i == len(docs) - 1:
            with gzip.open("cop.json.gz", "wt") as fh:
                json.dump(res, fh)
    print("wrote", len(res), "days")


if __name__ == "__main__":
    main()
