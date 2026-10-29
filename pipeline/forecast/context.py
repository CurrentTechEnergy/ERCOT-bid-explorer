"""Shared inputs for the operator-informed model (pipeline/models/operator_*.py), loaded once per
build: the hourly states of every thermal unit, merged into trains, on one calendar.

  Context.raw_states()   {train: (tech, state array)}: one char per hour (RANK), days in calendar
                         order from stats["day0"] with gaps as "-", combined-cycle configurations
                         merged (the "best" state of any configuration in the hour)
  Context.dam(D)         the 60-day DAM disclosure for D (data/dam/D), None when it is not in
  Context.hub(D)         HB_HUBAVG day-ahead hourly prices for D (data/dam_hubs.json.gz)

PRICE_BINS and BIN_LABELS are the day-ahead price bands the events list reports in.

The rest of pipeline/forecast (the daily forecast, its models and backtest) was retired in Oct 2026.
"""
import datetime as dt

import numpy as np

from ..config import DATA_DIR
from ..intraday import train_of
from ..store import read_json_gz
from ..trends import UNIT_TECHS, unit_techs

HUB = "HB_HUBAVG"
PRICE_BINS = [-1e9, 0.0, 15.0, 25.0, 35.0, 50.0, 100.0, 1e9]   # $/MWh
BIN_LABELS = ["<0", "0-15", "15-25", "25-35", "35-50", "50-100", "100+"]
RANK = {"a": 4, "m": 3, "0": 2, "o": 1, "-": 0}


def _d(s):
    return dt.date.fromisoformat(s)


def merged_states(uh: dict, techs: dict):
    """({train: (tech, state array over the whole period)}, period length in hours, first date)
    for the thermal units in `uh` (data/unit_hours_60d.json.gz), nuclear left out."""
    dates = uh.get("dates", [])
    if not dates:
        return {}, 0, None
    day0 = _d(dates[0])
    day_no = [(_d(d) - day0).days for d in dates]
    N = (day_no[-1] + 1) * 24
    rank = np.vectorize(RANK.get)
    by = {}
    for name, s in uh.get("units", {}).items():
        t = techs.get(name)
        if t not in UNIT_TECHS or t == "nuclear":
            continue
        key = train_of(name) if t == "combined_cycle" else name
        a = np.frombuffer(s.encode(), dtype="S1").astype(str)
        e = by.get(key)
        if e is None:
            e = by[key] = (t, np.full(N, "-"))
        st = e[1]
        for i, dn in enumerate(day_no):
            seg = a[i * 24:(i + 1) * 24]
            if seg.size < 24:
                seg = np.concatenate([seg, np.full(24 - seg.size, "-")])
            cur = st[dn * 24:(dn + 1) * 24]
            pick = rank(seg) > rank(cur)
            cur[pick] = seg[pick]
    return by, N, day0


class Context:
    def __init__(self, index: dict):
        self.index = index
        self.dam_days = sorted(d for d in index["days"].get("dam", []) if (DATA_DIR / "dam" / f"{d}.json.gz").exists())
        self.uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {"dates": [], "units": {}, "hsl": {}}
        self.techs = unit_techs(read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {})
        self.dam_hubs = (read_json_gz(DATA_DIR / "dam_hubs.json.gz", default=None) or {"days": {}})["days"]
        dates = self.uh.get("dates") or []
        self.stats = {"day0": _d(dates[0]) if dates else None}
        self._dam = {}
        self._raw = None

    def hub(self, date):
        v = (self.dam_hubs.get(date) or {}).get(HUB)
        return np.array(v, float) if v and len(v) >= 24 and all(x is not None for x in v[:24]) else None

    def dam(self, date):
        if date not in self._dam:
            self._dam[date] = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz") if date in self.dam_days else None
        return self._dam[date]

    def raw_states(self):
        if self._raw is None:
            self._raw = merged_states(self.uh, self.techs)[0]
        return self._raw
