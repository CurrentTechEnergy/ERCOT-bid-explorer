"""Probe ERCOT's 60-day COP reports (NP1-301 COP Adjustment Period Snapshot, NP3-991-EX COP
All Updates): list recent postings and print each file's name, size, columns and first rows.
Writes nothing.

  python -m pipeline.cop_probe
"""
import datetime as dt
import io

import pandas as pd

from .store import iter_csvs, zip_names

EMILS = ("np1-301", "np3-991-ex")


def main():
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
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


if __name__ == "__main__":
    main()
