"""Hourly system context for the 60-day days: wind, solar and storage output and the hub
price, so the Commitment page can show what else was happening in any hour without loading the
full 60-day summary.  Built from data/summary_60d.json.gz and data/summary_prices.json.gz;
needs no downloads.  Read by commitment.html (the "Leanest thermal hours" table, which takes
thermal output and lambda from intraday_60d).

Writes data/hourly_context_60d.json.gz:
  dates            the 60-day dates (same list as intraday_60d)
  wind, solar      [day][24] telemetered output, MW (null where missing)
  storage          [day][24] net output, MW (negative while charging)
  hub              [day][24] hub average settlement point price (HB_HUBAVG), $/MWh
"""
import numpy as np

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

HUB = "HB_HUBAVG"
SERIES = ["wind", "solar", "storage"]


def _r(x, nd=0):
    if x is None or not np.isfinite(x):
        return None
    return round(float(x), nd) if nd else int(round(float(x)))


def _hours(v, nd=0):
    v = v or []
    return [_r(v[h], nd) if h < len(v) and v[h] is not None else None for h in range(24)]


def build_hourly_context(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    summ = read_json_gz(DATA_DIR / "summary_60d.json.gz", default={})
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    out = {"dates": dates, **{k: [] for k in SERIES}, "hub": []}
    for d in dates:
        day = summ.get(d) or {}
        names = day.get("stat_names") or []
        io = names.index("output") if "output" in names else None
        for k in SERIES:
            rows = (day.get("stats") or {}).get(k) or []
            out[k].append(_hours([r[io] if io is not None and r else None for r in rows]))
        out["hub"].append(_hours(((prices.get(d) or {}).get("spp") or {}).get(HUB), 2))
    write_json_gz(DATA_DIR / "hourly_context_60d.json.gz", out)
    print(f"hourly_context_60d: {len(dates)} days")
