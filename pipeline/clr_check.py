"""Can the 60-day SCED disclosure tell controllable Load Resources (CLR) from non-controllable
ones (NCLR)?  A CLR is dispatched by SCED and submits a bid to buy; an NCLR does not.  For a few
sample days this opens the SCED zip from the raw store only (never downloads from ERCOT), prints
the Load Resource file's columns, and per unit counts the intervals with a bid curve.  Writes
nothing but the run summary and a CSV per day under clr-check/.

  python -m pipeline.clr_check 2019-06-15 2022-06-15 2024-06-15 2026-08-15
"""
import argparse
import datetime as dt
import io
import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from .config import EMIL_60DAY
from .history import LAG, SLACK, _t
from .store import iter_csvs

OUT = Path("clr-check")


def _norm(c: str) -> str:
    return re.sub(r"[^a-z0-9]", "", c.lower())


def summary(L: pd.DataFrame) -> pd.DataFrame:
    """Per unit: intervals, intervals with any bid-curve MW, resource type and status values."""
    name = next(c for c in L.columns if _norm(c) == "resourcename")
    curve = [c for c in L.columns if re.search(r"(mw|price)\d+$", _norm(c))]
    has = L[curve].apply(pd.to_numeric, errors="coerce").notna().any(axis=1) if curve else pd.Series(False, index=L.index)
    g = L.assign(_bid=has).groupby(name)
    out = pd.DataFrame({"intervals": g.size(), "with_bid": g["_bid"].sum()})
    for want in ("resourcetype", "telemeteredresourcestatus"):
        c = next((c for c in L.columns if _norm(c) == want), None)
        if c:
            out[want] = g[c].agg(lambda v: "/".join(sorted(map(str, v.dropna().unique()))[:4]))
    mx = next((c for c in L.columns if _norm(c).startswith("maxpowerconsumption")), None)
    if mx:
        out["max_mw"] = g[mx].apply(lambda v: pd.to_numeric(v, errors="coerce").max())
    out["share_with_bid"] = (out.with_bid / out.intervals).round(3)
    return out


def check_day(api, day: dt.date, md) -> None:
    docs = api.list_archives(EMIL_60DAY, _t(day + dt.timedelta(days=LAG - SLACK)), _t(day + dt.timedelta(days=LAG + SLACK + 1)))
    for doc in sorted(docs, key=lambda d: d.get("postDatetime", "")):
        try:
            blob = api.download(EMIL_60DAY, doc["docId"])
        except RuntimeError as e:          # not in the raw store: skipped, never fetched
            print(f"  {doc['docId']}: {e}")
            continue
        if not blob or blob[:2] != b"PK":
            continue
        files = {n.lower().rsplit("/", 1)[-1]: d for n, d in iter_csvs(blob, "x.zip")}
        lr = next((d for n, d in files.items() if _norm(n).startswith("60dloadresourcedatainsced")), None)
        if lr is None:
            continue
        L = pd.read_csv(io.BytesIO(lr), dtype=str)
        dc = next((c for c in L.columns if _norm(c) == "scedtimestamp"), None)
        got = pd.to_datetime(L[dc], errors="coerce").dt.date.mode()[0] if dc else None
        if got != day:
            continue
        S = summary(L)
        OUT.mkdir(exist_ok=True)
        S.to_csv(OUT / f"lr-sced-{day}.csv")
        n = len(S); bid = (S.with_bid > 0).sum(); full = (S.share_with_bid >= 0.95).sum()
        print(f"{day}: {doc.get('friendlyName', doc['docId'])}, {n} Load Resources, {bid} with any bid curve, {full} with one in 95%+ of intervals")
        md.append(f"### {day}\n\nFile columns: {', '.join(L.columns)}\n\n"
                  f"{n} Load Resources. {bid} have a bid curve in some interval; {full} in 95% or more; "
                  f"{(S.with_bid == 0).sum()} never.\n\nShare of intervals with a bid curve, units per band:\n\n"
                  + pd.cut(S.share_with_bid, [-0.01, 0, 0.05, 0.5, 0.95, 1]).value_counts().sort_index().to_string() + "\n")
        for col in ("resourcetype", "telemeteredresourcestatus"):
            if col in S:
                md.append(f"\nBy {col} (units, units with a bid):\n\n"
                          + S.groupby(col).agg(units=("intervals", "size"), with_bid=("with_bid", lambda v: (v > 0).sum())).to_string() + "\n")
        md.append("\nLargest units:\n\n" + S.sort_values("max_mw", ascending=False).head(15).to_string() + "\n" if "max_mw" in S else "")
        return
    md.append(f"### {day}\n\nNo SCED Load Resource file for this day in the raw store.\n")
    print(f"{day}: not found in the raw store")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("days", nargs="+", help="YYYY-MM-DD operating days")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    api.store_only = True
    md = ["## CLR check: SCED Load Resource bid curves\n"]
    for d in args.days:
        try:
            check_day(api, dt.date.fromisoformat(d), md)
        except Exception as e:
            md.append(f"### {d}\n\nFailed: {type(e).__name__}: {e}\n")
            print(f"{d}: failed: {type(e).__name__}: {e}")
    text = "\n".join(md)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text)
    if api.raw.enabled:
        print(api.raw.summary())


if __name__ == "__main__":
    sys.exit(main())
