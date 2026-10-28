"""The minimum-energy cost of a combined-cycle train at its gas cost (thermal_cutoff v12), in place
of its own DAM minimum-energy offer or the generic $/MWh (config.GENERIC_COSTS), for the forecast
and for the decision history behind its cutoffs and stay-on rule.

Gas cost = HEAT_RATE[tech] x the train's own hub price (fuel_hubs.json.gz: Houston Ship Channel
or Waha) on the latest trading day before D - 1, so it is public when the forecast for D is
made.  Days before the gas series starts (the 2024-25 thermal history) keep the old cost.

Only TECHS take it.  Backtested against the old cost (Oct 2026): for combined cycles it lowers
the Brier score of P(on) from 0.188 to 0.170 and the cheap-hour floor error, mostly by catching
trains that ran through hours their own offer said were a loss; for gas steam it is slightly
worse, so gas steam keeps its own offer.  A train's own offer still carries intent (trains that
went on to run offered about $12-14/MWh, those that went off about $23, $6-8 over gas), which
this drops; the spring maintenance season is where that costs most.
"""
import bisect
import datetime as dt

from . import private
from .config import DATA_DIR
from .store import read_json_gz

VERSION = "v1"
TECHS = ("combined_cycle",)
HEAT_RATE = {"combined_cycle": 7.548, "gas_steam": 10.4, "combustion_turbine": 11.0}   # MMBtu/MWh
EST = 3     # the `est` code of a cost taken from gas (0 own offer, 1 carried offer, 2 generic)
_C = {}


def _load():
    if not _C:
        from .intraday import train_of
        h = (private.read("gas_hubs.json.gz", default={}) or {}).get("hubs", {})
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
    """(cost, est): the gas cost for a TECHS unit on a day with a gas price, else `mingen` and
    its `est` unchanged."""
    g = gas_cost(tech, key, date) if tech in TECHS else None
    return (mingen, est) if g is None else (g, EST)
