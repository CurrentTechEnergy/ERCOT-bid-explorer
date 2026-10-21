"""Probe ERCOT's 60-day COP reports (NP1-301 COP Adjustment Period Snapshot, NP3-991-EX COP
All Updates): list recent postings and print each file's name, size, columns and first rows.
Writes nothing.

  python -m pipeline.cop_probe
  python -m pipeline.cop_probe --plans N OUT   # each resource's plan as of 14:00 Central the day
                                               # before, for the last N delivery days, to OUT
"""
import datetime as dt
import io

import pandas as pd

from .store import iter_csvs, zip_names

EMILS = ("np1-301", "np3-991-ex")


def probe(api):
    now = dt.datetime.now()
    for emil in EMILS:
        try:
            docs = sorted(api.list_archives(emil, now - dt.timedelta(days=5), now), key=lambda x: x.get("postDatetime", ""))
        except Exception as e:
            print(f"{emil}: listing failed: {type(e).__name__}: {e}")
            continue
        print(f"{emil}: {len(docs)} posting(s) in 5 days")
        for x in docs[-6:]:
            print("  ", {k: x.get(k) for k in ("postDatetime", "friendlyName", "docId")})
        if not docs:
            continue
        old = api.list_archives(emil, dt.datetime(2024, 1, 1), dt.datetime(2024, 1, 3))
        print(f"  {len(old)} posting(s) on 2024-01-01..02")
        blob = api.download(emil, docs[-1]["docId"])
        print(f"  newest: {len(blob) / 1e6:.1f} MB, files {zip_names(blob)}")
        for n, b in iter_csvs(blob, "x.zip"):
            f = pd.read_csv(io.BytesIO(b), low_memory=False)
            print(f"  {n}: {len(b) / 1e6:.1f} MB, {len(f)} rows, columns {list(f.columns)}")
            with pd.option_context("display.width", 250, "display.max_columns", 50):
                print(f.head(5).to_string())
            for c in f.columns:
                if f[c].dtype == object and f[c].nunique() < 40:
                    print(f"    {c}: {f[c].value_counts().head(15).to_dict()}")
                elif f[c].dtype == object:
                    print(f"    {c}: {f[c].nunique()} distinct, e.g. {list(f[c].dropna().unique()[:5])}")



CUTOFF_HOUR = 14


def plans(csv: bytes) -> dict:
    """One NP3-991-EX file -> (delivery date, {resource: [24] status as of CUTOFF_HOUR Central on
    the day before, "" where the resource had no plan for the hour by then}, {resource: [24] LSL})."""
    f = pd.read_csv(io.BytesIO(csv), usecols=["Delivery Date", "Resource Name", "Hour Ending", "Status",
                                              "Low Sustained Limit", "Cancel Flag", "Update Time"], dtype=str)
    f = f[f["Cancel Flag"].str.strip().str.upper() != "Y"]
    day = pd.to_datetime(f["Delivery Date"].iloc[0], format="%m/%d/%Y").date()
    cut = pd.Timestamp(day - dt.timedelta(days=1)) + pd.Timedelta(hours=CUTOFF_HOUR)
    f = f.assign(t=pd.to_datetime(f["Update Time"], format="%m/%d/%Y %H:%M:%S", errors="coerce"),
                 he=pd.to_numeric(f["Hour Ending"].str.split(":").str[0], errors="coerce"))
    f = f[(f["t"] <= cut) & f["he"].between(1, 24)].sort_values("t")
    last = f.groupby(["Resource Name", "he"]).tail(1)
    st, lsl = {}, {}
    for r, he, s, l in zip(last["Resource Name"], last["he"].astype(int), last["Status"], last["Low Sustained Limit"]):
        st.setdefault(r, [""] * 24)[he - 1] = str(s).strip()
        lsl.setdefault(r, [None] * 24)[he - 1] = float(l) if l == l else None
    return day.isoformat(), st, lsl


def collect(api, n, out):
    import gzip, json
    now = dt.datetime.now()
    docs = sorted(api.list_archives("np3-991-ex", now - dt.timedelta(days=n + 2), now), key=lambda x: x.get("postDatetime", ""))[-n:]
    res = {}
    for x in docs:
        try:
            for name, b in iter_csvs(api.download("np3-991-ex", x["docId"]), "x.zip"):
                d, st, lsl = plans(b)
                res[d] = {"status": st, "lsl": lsl}
                print(f"{d}: {len(st)} resources, {sum(v.count('ON') for v in st.values())} ON resource-hours", flush=True)
        except Exception as e:
            print(f"{x.get('postDatetime')}: failed: {type(e).__name__}: {e}", flush=True)
    with gzip.open(out, "wt") as fh:
        json.dump(res, fh)


def main(argv=None):
    import argparse
    from pathlib import Path
    from .ercot_api import ErcotAPI
    ap = argparse.ArgumentParser()
    ap.add_argument("--plans", nargs=2, metavar=("N", "OUT"))
    a = ap.parse_args(argv)
    api = ErcotAPI()
    if a.plans:
        collect(api, int(a.plans[0]), Path(a.plans[1]))
    else:
        probe(api)


if __name__ == "__main__":
    main()
