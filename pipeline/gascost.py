"""Fuel cost at minimum for the turn-off decisions, the decision cost and the turn-off point
curve (pipeline/decisions.py, stayon.py, models/operator_cutoffs.py): the one basis every
displayed fuel cost on the site uses (Blair, Nov 5 2026).

  gas units  heat rate at minimum (pipeline/heat_rates: EPA hourly heat input over ERCOT net
             output, the unit's or CC train's own, else its technology's median) x its own hub's
             price (fuel_hubs.json.gz: Houston Ship Channel or Waha) on the latest trading day
             before D - 1, so it is public when the forecast for D is made.  A hub price carries
             GAP_DAYS days; past that Henry Hub stands in, plus Ship Channel's median basis for
             the calendar month for Ship Channel units (pipeline/gas.hub_with_basis's rule),
             marked estimated
  coal       heat rate at minimum x the plant's EIA-923 delivered price that month
             (heat_rates.coal_price; the Texas subbituminous average, marked estimated, for the
             plants that withhold theirs)

fuel_cost() gives ($/MWh, estimated) or None, and callers fall back to the unit's DAM
minimum-energy offer, else the generic cost, only then.

History.  v1 (Oct 2026): combined cycles at 7.548 in place of their own DAM minimum-energy offer,
Brier of P(on) 0.188 -> 0.170.  v2 (Nov 2026): each train at its own heat rate at minimum,
turn-off cutoffs 7,271 -> 7,302 of 7,800 days right, shutdowns caught 1,153 -> 1,181, false 208
-> 205.  v3 (Nov 5 2026): CTs and coal too, and gas_cost no longer carries a hub price
indefinitely.  Backtest of the cutoffs (analysis/backtest/run.py cuts measured, all 280 60-day
days): CTs 85.6% -> 88.8% of days right, shutdowns caught 83% -> 89%, false 273 -> 280; coal gets
no cutoff either way (too few shutdowns).  Gas steam measured: 83.9% -> 82.1% right, caught 45% ->
57%, false 50 -> 105, so its cutoffs keep the unit's own offer for now (CUT_TECHS; Blair to decide)
while every displayed gas steam cost uses fuel_cost.

The CT turn-on model and the operator-informed model read gas_price() with their own fixed
scaling (models/peaker_oi.GAS_HR, models/operator_informed.HEAT_RATE): per-unit heat rates
backtested worse there.
"""
import bisect
import datetime as dt

from . import heat_rates, private
from .config import DATA_DIR
from .store import read_json_gz

VERSION = "v3"   # v3: CTs and coal at measured cost, Henry Hub fallback (Nov 2026); v2: CC trains at their own heat rate
TECHS = ("combined_cycle", "gas_steam", "combustion_turbine", "coal")   # fuel_cost covers these
CUT_TECHS = ("combined_cycle", "combustion_turbine", "coal")   # turn-off cutoffs at fuel cost; gas steam keeps its offer (see above)
GAS_TECHS = ("combined_cycle", "gas_steam", "combustion_turbine")
GAP_DAYS = 7     # a hub price carries this many days before Henry Hub stands in (pipeline/gas.GAP_DAYS)
EST = 3          # the `est` code of a cost at fuel cost (0 own offer, 1 carried offer, 2 generic)
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
        hh = read_json_gz(DATA_DIR / "gas.json.gz", default={}) or {}
        _C["hh"] = (hh.get("dates") or [], hh.get("value") or [])
        hhd = dict(zip(*_C["hh"]))
        basis = {}
        if "hsc" in _C["gas"]:
            from .gas import monthly_basis
            basis = monthly_basis(dict(zip(*_C["gas"]["hsc"])), hhd)
        _C["basis"] = basis
    return _C


def hub_of(key):
    """The gas hub ("hsc" or "waha") of unit or train `key` (fuel_hubs.json.gz; "hsc" without one)."""
    return _load()["hub"].get(key, "hsc")


def _before(ds, vs, cut, gap=None):
    i = bisect.bisect_left(ds, cut) - 1
    while i >= 0 and vs[i] is None:
        i -= 1
    if i < 0:
        return None
    if gap is not None and (dt.date.fromisoformat(cut) - dt.date.fromisoformat(ds[i])).days > gap + 1:
        return None
    return vs[i]


def hub_price(key, date, gap=GAP_DAYS):
    """$/MMBtu at unit or train `key`'s own hub on the latest trading day before D - 1 with a price
    (within `gap` days; any age with gap None), or None."""
    c = _load()
    cut = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    return _before(*c["gas"].get(c["hub"].get(key, "hsc"), ([], [])), cut, gap)


def gas_price(key, date):
    """($/MMBtu, estimated) at unit or train `key`'s own hub on the latest trading day before
    D - 1, or Henry Hub (+ the month's Ship Channel basis for Ship Channel units, estimated) when
    the hub has no price within GAP_DAYS; None with neither."""
    c = _load()
    hub = c["hub"].get(key, "hsc")
    cut = (dt.date.fromisoformat(date) - dt.timedelta(days=1)).isoformat()
    p = hub_price(key, date)
    if p is not None:
        return p, False
    p = _before(*c["hh"], cut)
    if p is None:
        return None
    return p + (c["basis"].get(int(date[5:7]), 0.0) if hub == "hsc" else 0.0), True


def fuel_cost(tech, key, date):
    """($/MWh at minimum, estimated) for unit or CC train `key` on operating day `date`, or None
    (no technology entry, or no fuel price at all).  Estimated when the heat rate is the
    technology's median or the fuel price a stand-in."""
    hr = heat_rates.at_min(tech, key) if tech in TECHS else None
    if hr is None:
        return None
    if tech == "coal":
        p, own = heat_rates.coal_price(key, date)
        return hr[0] * p, not (own and hr[1])
    g = gas_price(key, date)
    if g is None:
        return None
    return hr[0] * g[0], g[1] or not hr[1]


def gas_cost(tech, key, date):
    """$/MWh at fuel cost for unit or train `key` on `date`, or None (fuel_cost without the flag)."""
    f = fuel_cost(tech, key, date)
    return None if f is None else f[0]


def cost(tech, key, date, mingen, est):
    """(cost, est) for the turn-off decisions: fuel cost for a CUT_TECHS unit on a day with a fuel
    price, else `mingen` and its `est` unchanged."""
    g = gas_cost(tech, key, date) if tech in CUT_TECHS else None
    return (mingen, est) if g is None else (g, EST)
