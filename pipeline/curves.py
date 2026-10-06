"""Numerical helpers for offer curves."""
import numpy as np
import pandas as pd


def to_iso_date(s: pd.Series) -> pd.Series:
    """'MM/DD/YYYY...' or 'YYYY-MM-DD...' -> 'YYYY-MM-DD'."""
    s = s.astype(str).str.strip()
    us = s.str.match(r"^\d{2}/\d{2}/\d{4}")
    out = s.str.slice(0, 10)
    out[us] = s[us].str.slice(6, 10) + "-" + s[us].str.slice(0, 2) + "-" + s[us].str.slice(3, 5)
    return out


def parse_sced_time(s: pd.Series) -> pd.DataFrame:
    """SCED timestamp (Central prevailing time) -> date (ISO str) and hour (0-23, hour beginning).
    Accepts 'MM/DD/YYYY HH:MM:SS' (report files) and 'YYYY-MM-DDTHH:MM:SS'."""
    s = s.astype(str).str.strip()
    date = to_iso_date(s)
    hour = s.str.slice(11, 13).astype(int)
    return pd.DataFrame({"date": date.values, "hour": hour.values}, index=s.index)


def mw_at_prices(prices: np.ndarray, mws: np.ndarray, grid: np.ndarray,
                 left: str = "zero", chunk: int = 1500) -> np.ndarray:
    """Evaluate many piecewise-linear offer curves on a price grid.

    prices, mws: (n_curves, n_points) arrays, NaN-padded after the last point.
                 Prices are non-decreasing along each row.
    Returns (n_curves, len(grid)): MW offered at a price <= grid value.
      - Between two points the curve is interpolated linearly in price.
      - Where several points share a price, the largest-index point wins
        (so a vertical step is fully "on" at its price).
      - Above the last point the last MW holds.
      - Below the first point: 0 if left == "zero", else the first point's MW.
    """
    n, k = prices.shape
    out = np.zeros((n, grid.size), dtype=np.float64)
    valid = ~np.isnan(prices) & ~np.isnan(mws)
    npts = valid.sum(axis=1)
    P = np.where(valid, prices, np.inf)
    M = np.where(valid, mws, 0.0)
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        p, m, cnt_pts = P[a:b], M[a:b], npts[a:b]
        # j = index of the last point with price <= g  (-1 if none)
        j = (p[:, :, None] <= grid[None, None, :]).sum(axis=1) - 1          # (rows, G)
        jc = np.clip(j, 0, k - 1)
        jn = np.clip(j + 1, 0, k - 1)
        pj = np.take_along_axis(p, jc, axis=1)
        mj = np.take_along_axis(m, jc, axis=1)
        pn = np.take_along_axis(p, jn, axis=1)
        mn = np.take_along_axis(m, jn, axis=1)
        has_next = (j + 1) < cnt_pts[:, None]
        with np.errstate(invalid="ignore", divide="ignore"):
            frac = np.where(has_next & (pn > pj), (grid[None, :] - pj) / (pn - pj), 0.0)
        val = mj + frac * (mn - mj)
        if left == "zero":
            first = 0.0
        else:
            first = m[:, :1]
        val = np.where(j < 0, first, val)
        val = np.where(cnt_pts[:, None] == 0, 0.0, val)
        out[a:b] = val
    return out


def accumulate(out: np.ndarray, keys: np.ndarray, vals: np.ndarray) -> None:
    """out[keys[i]] += vals[i] for 2-D vals, done with a sort + reduceat (fast)."""
    if keys.size == 0:
        return
    order = np.argsort(keys, kind="stable")
    k = keys[order]
    v = vals[order]
    starts = np.flatnonzero(np.r_[True, k[1:] != k[:-1]])
    out[k[starts]] += np.add.reduceat(v, starts, axis=0)


def runs_per_hour(run_stamps: pd.Series, hours: np.ndarray) -> np.ndarray:
    """Number of distinct SCED runs in each hour (0-23)."""
    df = pd.DataFrame({"s": run_stamps.values, "h": hours})
    cnt = df.drop_duplicates("s")["h"].value_counts()
    out = np.zeros(24)
    out[cnt.index.values] = cnt.values
    return out
