"""Branch-only (not for merge): look at the stored intra-hour forecast day zips."""
import io
import sys

import pandas as pd

from .raw_store import RawStore
from .store import iter_csvs

raw = RawStore()
for emil in ("np4-751-cd", "np4-752-cd", "np3-562-cd"):
    blob = raw.get(emil, "day-2026-04-15")
    files = list(iter_csvs(blob, "x.zip"))
    print(f"## {emil}: {len(files)} files; first {files[0][0]}, last {files[-1][0]}")
    for name, b in (files[0], files[-1]):
        f = pd.read_csv(io.BytesIO(b))
        print(name, f.shape, list(f.columns))
        print(f.head(3).to_string())
        print(f.tail(2).to_string())
sys.stdout.flush()
