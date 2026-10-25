"""One-off probe for the load-weighted "who is marginal" analysis (the "dart").  Reads only; writes
to out/dart/ for a workflow artifact, never to site/data.

For each operating day given:
  NP6-787-CD  LMPs by electrical bus, every SCED run, reduced to the mean LMP at each substation
              (electrical bus -> substation from the settlement point list, NP4-160-SG)
              -> out/dart/lmp_sub_YYYY-MM-DD.parquet  [sced (str), rhf, sub, lmp]
Once:
  NP4-159-CD  load distribution factors: every posting in the window, reduced to the mean MW at
              each substation by hour (over the 7 days each posting covers)
              -> out/dart/ldf.parquet  [posted (str), hour (1..24), sub, mw]

  python -m tools.dart_probe SP_LIST_CSV 2026-04-08 2026-04-20 ...
"""
import datetime as dt
import io
import os
import sys
import time
from pathlib import Path

import pandas as pd

from pipeline.ercot_api import ErcotAPI
from pipeline.store import iter_csvs

EMIL_BUS = "np6-787-cd"
EMIL_LDF = "np4-159-cd"
OUT = Path("out/dart")


def fetch_docs(api, emil, docs):
    """Every document's zip, raw store first (Blair's rule through Oct 31: a workflow fetch reads
    the R2 raw store first and keeps what it fetches).  Misses come from ERCOT one by one through
    ErcotAPI.download, which stores each.  (The bulk endpoint's inner file names did not match the
    listing's constructedName for NP6-787 on Oct 24, so a bulk fetch could not be stored per
    document and only doubled the downloads.)"""
    blobs, miss = {}, []
    for x in docs:
        b = api.raw.get(emil, x["docId"])
        if b is not None:
            blobs[x["docId"]] = b
        else:
            miss.append(x)
    for x in miss:
        blobs[x["docId"]] = api.download(emil, x["docId"])
    print(f"  {len(docs) - len(miss)} from the raw store, {len(miss)} from ERCOT", flush=True)
    return blobs


def _csvs(api, emil, docs):
    for blob in fetch_docs(api, emil, docs).values():
        for _, b in iter_csvs(blob, "x.zip"):
            yield b


def reduce_bus(b: bytes, bus_sub: dict) -> pd.DataFrame:
    """One posting's CSV (SCEDTimestamp, RepeatedHourFlag, ElectricalBus, CappedLMP, UncappedLMP)
    -> mean capped LMP at each substation."""
    f = pd.read_csv(io.BytesIO(b))
    f.columns = [c.lower() for c in f.columns]
    lmp = "cappedlmp" if "cappedlmp" in f.columns else next(c for c in f.columns if "lmp" in c)
    rhf = next((c for c in f.columns if "repeat" in c), None)
    f = pd.DataFrame({"sced": f["scedtimestamp"].astype(str), "rhf": f[rhf].astype(str) if rhf else "N",
                      "sub": f["electricalbus"].astype(str).map(bus_sub), "lmp": pd.to_numeric(f[lmp], errors="coerce")})
    return f.dropna(subset=["sub", "lmp"]).groupby(["sced", "rhf", "sub"], as_index=False)["lmp"].mean()


def bus_day(api, day: dt.date, bus_sub: dict) -> None:
    since = dt.datetime.combine(day, dt.time())
    until = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(1))
    docs = [x for x in api.list_archives(EMIL_BUS, since, until) if "xml" not in str(x.get("friendlyName", "")).lower()]
    frames = [reduce_bus(b, bus_sub) for b in _csvs(api, EMIL_BUS, docs)]
    d = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=["sced", "rhf", "sub", "lmp"])
    d = d[pd.to_datetime(d["sced"], format="%m/%d/%Y %H:%M:%S", errors="coerce").dt.date == day].drop_duplicates(["sced", "rhf", "sub"])
    d["lmp"] = d["lmp"].astype("float32")
    d.to_parquet(OUT / f"lmp_sub_{day}.parquet", index=False)
    print(f"{day}: {len(docs)} postings, {d['sced'].nunique()} runs, {d['sub'].nunique()} substations", flush=True)


def ldf_frame(b: bytes) -> pd.DataFrame:
    """One posting's CSV -> mean MW at each substation by hour ending over the days it covers."""
    f = pd.read_csv(io.BytesIO(b), usecols=lambda c: c.lower() in ("ldfdate", "ldfhour", "substation", "distributionfactor"))
    f.columns = [c.lower() for c in f.columns]
    f["hour"] = f["ldfhour"].astype(str).str.slice(0, 2).astype(int)
    g = f.groupby(["ldfdate", "hour", "substation"], as_index=False)["distributionfactor"].sum()
    g = g.groupby(["hour", "substation"], as_index=False)["distributionfactor"].mean()
    return g.rename(columns={"substation": "sub", "distributionfactor": "mw"})


def ldf(api, since: dt.datetime, until: dt.datetime) -> None:
    docs = [x for x in api.list_archives(EMIL_LDF, since, until) if "xml" not in str(x.get("friendlyName", "")).lower()]
    frames = []
    for x in docs:
        for _, b in iter_csvs(api.download(EMIL_LDF, x["docId"]), "x.zip"):
            g = ldf_frame(b)
            g.insert(0, "posted", str(x.get("postDatetime", "")))
            frames.append(g)
        print(f"LDF posting {x.get('postDatetime')}: read", flush=True)
    if frames:
        pd.concat(frames, ignore_index=True).to_parquet(OUT / "ldf.parquet", index=False)


def main(argv):
    OUT.mkdir(parents=True, exist_ok=True)
    sp = pd.read_csv(argv[0], dtype=str)
    bus_sub = dict(zip(sp["ELECTRICAL_BUS"], sp["SUBSTATION"]))
    days = [dt.date.fromisoformat(d) for d in argv[1:]]
    api = ErcotAPI()
    # stop starting new days after this long, so the artifact uploads before the job timeout; a
    # second run with the same days reads the finished ones back from the raw store
    stop = time.time() + float(os.environ.get("DART_MINUTES") or 1e9) * 60
    ldf(api, dt.datetime.combine(min(days) - dt.timedelta(days=120), dt.time()), dt.datetime.combine(max(days) + dt.timedelta(days=60), dt.time()))
    for d in days:
        if time.time() > stop:
            print(f"{d}: not started, out of time", flush=True)
            continue
        try:
            bus_day(api, d, bus_sub)
        except Exception as e:
            print(f"{d}: failed: {type(e).__name__}: {e}", flush=True)
    print(api.raw.summary(), flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
