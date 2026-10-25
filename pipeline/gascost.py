"""Experiment: the minimum-energy cost at each gas unit's gas cost instead of a fixed generic
$/MWh (config.GENERIC_COSTS), for the forecast and the decision history behind its cutoffs.

GAS_COST (environment):
  ""         off: the unit's own DAM minimum-energy offer where it filed one, else the generic cost
  "nooffer"  gas cost where the unit has no own offer (the generic cases); own offers kept
  "all"      gas cost for every gas unit
GAS_COST_TECH (environment): comma-separated techs the mode applies to (default all gas techs)

Gas cost = HEAT_RATE[tech] x the unit's own hub price (fuel_hubs.json.gz: Houston Ship Channel
or Waha) on the latest trading day before D - 1, so it is public when the forecast for D is
made.  Days before the gas series starts (the 2024-25 thermal history) keep the old cost.
"""
import bisect
import datetime as dt
import os

from .config import DATA_DIR
from .store import read_json_gz

MODE = os.environ.get("GAS_COST", "")
TECHS = {t for t in os.environ.get("GAS_COST_TECH", "").split(",") if t}
HEAT_RATE = {"combined_cycle": 7.548, "gas_steam": 10.4, "combustion_turbine": 11.0}   # MMBtu/MWh
_C = {}


def _load():
    if not _C:
        from .intraday import train_of
        h = (read_json_gz(DATA_DIR / "gas_hubs.json.gz", default={}) or {}).get("hubs", {})
        _C["gas"] = {k: (v.get("dates") or [], v.get("value") or []) for k, v in h.items()}
        hub = {}
        for name, u in ((read_json_gz(DATA_DIR / "fuel_hubs.json.gz", default={}) or {}).get("units") or {}).items():
            hub[name] = u.get("hub") or "hsc"
            if u.get("tech") == "combined_cycle":
                hub.setdefault(train_of(name), hub[name])
        _C["hub"] = hub
    return _C


def gas_cost(tech, key, date):
    """$/MWh at gas for unit or train `key` on operating day `date`, or None."""
    hr = HEAT_RATE.get(tech)
    if hr is None:
        return None
    c = _load()
    ds, vs = c["gas"].get(c["hub"].get(key, "hsc"), ([], []))
    cut = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    i = bisect.bisect_left(ds, cut) - 1
    while i >= 0 and vs[i] is None:
        i -= 1
    return hr * vs[i] if i >= 0 else None


def cost(tech, key, date, mingen, est):
    """The minimum-energy cost to use: `mingen` (est 0 own offer, 2 generic) or the gas cost."""
    if not MODE or (TECHS and tech not in TECHS) or (MODE == "nooffer" and est == 0 and mingen is not None):
        return mingen
    g = gas_cost(tech, key, date)
    return mingen if g is None else g
