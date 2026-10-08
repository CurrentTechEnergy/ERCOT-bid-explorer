"""2-Day Aggregated Generation Summary (NP3-910-ER) -> hourly system-wide sums.

Per SCED run ERCOT sums base points and limits by resource group: Non-IRR, WGR (wind),
PVGR (solar), ESR and the rest, plus telemetered generation.  For wind and solar, HASL
(the MW the resource could produce) minus base point is the MW SCED held back:
curtailment.  Column names are normalised (upper case, single spaces) and every numeric
column is kept, keyed in snake case, e.g. "Sum Base Point WGR" -> "sum_base_point_wgr".

Only the system-wide file is read (the zip also carries per-area files and load and
output-schedule summaries).
"""
import io
import re

import numpy as np
import pandas as pd

from .curves import parse_sced_time
from .store import iter_csvs, _round

PREFIX = "2d_agg_gen_summary-"      # system-wide; area files are 2d_Agg_Gen_Summary_<Area>-


def _key(col: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", " ".join(col.replace("-", " ").split()).lower()).strip("_")


def is_gen_summary(names) -> bool:
    return any(n.lower().startswith(PREFIX) for n in names)


def find_col(cols, *parts):
    """First key containing every part, e.g. find_col(keys, "hasl", "wgr")."""
    return next((c for c in cols if all(p in c.split("_") for p in parts)), None)


def parse_2day_gen_zip(blob: bytes):
    """Returns (date, day_payload, summary_payload)."""
    files = dict(iter_csvs(blob, "x.zip"))
    match = [n for n in files if n.lower().startswith(PREFIX)]
    if not match:
        raise ValueError("No system-wide 2d_Agg_Gen_Summary file in the zip")
    df = pd.read_csv(io.BytesIO(files[match[0]]))
    df.columns = [_key(c) for c in df.columns]
    if "sced_time_stamp" not in df.columns:
        raise ValueError(f"2d_Agg_Gen_Summary has no SCED Time Stamp column ({list(df.columns)[:8]})")
    t = parse_sced_time(df["sced_time_stamp"])
    date = t["date"].mode().iloc[0]
    df = df[t["date"].values == date]
    hour = t["hour"].values[t["date"].values == date]
    num = [c for c in df.columns if c.startswith("sum_")]
    hourly = {}
    for c in num:
        v = pd.to_numeric(df[c], errors="coerce").groupby(hour).mean()
        hourly[c] = _round([float(v[h]) if h in v.index and not np.isnan(v[h]) else None for h in range(24)])
    runs = pd.Series(hour).value_counts().reindex(range(24), fill_value=0).astype(int).tolist()
    day = {"date": date, "source": "2dgen", "runs": runs, "hourly": hourly}
    print(f"  2d gen summary columns: {', '.join(num)}")
    return date, day, {"runs": runs, "hourly": hourly}
