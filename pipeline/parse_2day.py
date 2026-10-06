"""2-Day SCED Energy Curves (NP3-908-ER) -> hourly average curves per technology."""
import io

import numpy as np
import pandas as pd

from .config import PRICE_GRID, TWO_DAY_CURVES
from .curves import parse_sced_time
from .store import iter_csvs, thresholds_from_curves, _round


def _curve_file_to_hourly(df: pd.DataFrame, left_fill: str):
    """One aggregate-curve CSV -> (date, hourly (24, G) array, runs per hour)."""
    df.columns = [c.strip() for c in df.columns]
    price_col = "Price" if "Price" in df.columns else "PRICE"
    if df.empty:
        return None
    run = df["SCED Time Stamp"].astype(str) + "|" + df["Repeated Hour Flag"].astype(str)
    run_codes, run_keys = pd.factorize(run)
    first_rows = pd.Series(np.arange(len(df))).groupby(run_codes).first().values
    t = parse_sced_time(df["SCED Time Stamp"].iloc[first_rows])
    run_hour = t["hour"].values
    date = t["date"].mode().iloc[0]

    price = np.round(df[price_col].astype(float).values).astype(int)
    pmin, pmax = price.min(), price.max()
    dense = np.full((len(run_keys), pmax - pmin + 1), np.nan)
    dense[run_codes, price - pmin] = df["MW"].astype(float).values
    dense = pd.DataFrame(dense).ffill(axis=1).values          # hold MW until next price step
    if left_fill == "zero":
        dense = np.nan_to_num(dense, nan=0.0)                  # nothing offered below first price
    else:
        dense = pd.DataFrame(dense).bfill(axis=1).values       # first value holds below

    cols = np.clip(np.round(PRICE_GRID).astype(int) - pmin, 0, dense.shape[1] - 1)
    on_grid = dense[:, cols]
    below = PRICE_GRID < pmin
    if left_fill == "zero":
        on_grid[:, below] = 0.0

    hourly = np.full((24, PRICE_GRID.size), np.nan)
    runs = np.zeros(24, dtype=int)
    for h in range(24):
        m = run_hour == h
        runs[h] = m.sum()
        if m.any():
            hourly[h] = on_grid[m].mean(axis=0)
    return date, hourly, runs


def parse_2day_zip(blob: bytes):
    """Returns (date, day_payload, summary_payload)."""
    files = dict(iter_csvs(blob, "x.zip"))
    curves, dates, runs_out = {}, [], None
    for key, (prefix, _label, kind) in TWO_DAY_CURVES.items():
        match = [n for n in files if n.startswith(prefix)]
        if not match:
            continue
        df = pd.read_csv(io.BytesIO(files[match[0]]))
        left = "first" if key in ("storage", "clr") else "zero"
        res = _curve_file_to_hourly(df, left)
        if res is None:
            continue
        date, hourly, runs = res
        dates.append(date)
        curves[key] = hourly
        if runs_out is None or runs.sum() > runs_out.sum():
            runs_out = runs
    if not curves:
        raise ValueError("No system-wide curve files found in 2-day zip")
    date = max(set(dates), key=dates.count)

    day = {
        "date": date,
        "source": "2d",
        "runs": runs_out.tolist(),
        "curves": {k: [_round(row) for row in v] for k, v in curves.items()},
    }
    summary = {k: [_round(r) for r in thresholds_from_curves(v)] for k, v in curves.items()}
    return date, day, summary
