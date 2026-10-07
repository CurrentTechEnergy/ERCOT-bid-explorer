"""Marginal supply by hour, for every loaded day: the MW each technology offers within
the hour's cleared system lambda range (widened to at least ±$1 around the average).

Built from the day files and price files already in data/, so it needs no downloads.
The dashboard's "Marginality by price" chart groups these hours by price.
"""
import numpy as np

from .config import DATA_DIR, PRICE_GRID, SIXTY_DAY_TECHS, TWO_DAY_CURVES
from .store import read_json_gz, write_json_gz

# technologies per report, in the order the rows store them (supply curves only)
TECHS = {
    "2d": [k for k, v in TWO_DAY_CURVES.items() if v[2] == "supply"],
    "60d": list(SIXTY_DAY_TECHS),
}
LEFT_HOLDS = {"storage"}   # storage curves start at their charging MW, not zero


def _mw_at(row, i, tech):
    """MW at or below grid point i (i < 0: below the grid)."""
    if i < 0:
        return (row[0] or 0.0) if tech in LEFT_HOLDS else 0.0
    return row[i] or 0.0


def hour_rows(day: dict, prices: dict, techs) -> list:
    lam = prices.get("lambda") or {}
    mean, lo_, hi_ = lam.get("hourly_mean"), lam.get("hourly_min"), lam.get("hourly_max")
    if not mean:
        return []
    out = []
    for h in range(24):
        m = mean[h]
        if m is None or not day["runs"][h]:
            continue
        lo = min(lo_[h] if lo_[h] is not None else m, m - 1)
        hi = max(hi_[h] if hi_[h] is not None else m, m + 1)
        i_hi = int(np.searchsorted(PRICE_GRID, hi, side="right")) - 1   # last point <= hi
        i_lo = int(np.searchsorted(PRICE_GRID, lo, side="left")) - 1    # last point < lo
        mw = []
        for t in techs:
            row = (day["curves"].get(t) or [None] * 24)[h]
            mw.append(0.0 if row is None else round(max(0.0, _mw_at(row, i_hi, t) - _mw_at(row, i_lo, t)), 1))
        out.append([day["date"], h, round(m, 2)] + mw)
    return out


def build_marginal(index: dict) -> None:
    have_prices = set(index["days"].get("prices", []))
    for source, techs in TECHS.items():
        rows = []
        for date in sorted(set(index["days"].get(source, [])) & have_prices):
            day = read_json_gz(DATA_DIR / source / f"{date}.json.gz")
            prices = read_json_gz(DATA_DIR / "prices" / f"{date}.json.gz")
            if day and prices:
                rows += hour_rows(day, prices, techs)
        write_json_gz(DATA_DIR / f"marginal_{source}.json.gz",
                      {"columns": ["date", "hour", "lambda"] + techs, "rows": rows})
        print(f"marginal_{source}: {len(rows)} hours")
