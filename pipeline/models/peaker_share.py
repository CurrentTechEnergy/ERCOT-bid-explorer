"""Peakers: combustion turbines start rather than stay on, so they are judged by hour: the
share of its available history a unit was online at this hour of day with the day-ahead hub
average in this price bin (pipeline.forecast.context.PRICE_BINS).  Hours on outage are left out
of that history (v2), so the share says how often the unit runs when it can; outage comes in
separately, as for other thermal units (thermal_cutoff: a long outage at the last known hour,
the unplanned outage report, and the zonal unseen outage share).

  p_on[h]  the unit's own online share in the (bin, hour) cell when it has MIN_CELL available
           hours of history there; else its own share for the bin over all hours (MIN_BIN hours); else
           the combustion-turbine fleet's share for the cell.

The hub price for the day is the day-ahead HB_HUBAVG; without it, the unit's overall online
share applies to every hour.

v1 maps that share through CALIB, the online rate actually seen at each level of it in the
hour's hub price band.  The share comes from history at least sixty days old, and peakers ran
more than it says whenever the hub was above CHEAP_HUB (Mar-Aug 2026: a share of 0.15 ran 19% of
the time at a $10-20 hub, 40% above $45).  Fitted on the backtest's unit-hours; fitted on Mar-May
alone and tried on Jun-Aug, it cut the fleet's hourly committed-minimum error from 714 to about
450 MW with little bias.  At or below CHEAP_HUB the share stands: it is about right there, and
the few cheap hours give no stable map.  v2 refits CALIB on the available-hours share against
the online rate in hours the unit was not on outage (isotonic by band, the backtest's unit-hours
above CHEAP_HUB; bias 0.009 -> 0.001, in-sample).
"""
import numpy as np

from ..forecast import context as C

NAME = "peaker_share"
VERSION = "v2"    # v2: share of available hours (outage hours left out), CALIB refit; v1: history share mapped through CALIB by hub price band
BANDS = [20.0, 30.0, 45.0]   # hub $/MWh: bands (CHEAP_HUB, 20], (20, 30], (30, 45], above 45
_X = [0.0, 0.012, 0.034, 0.073, 0.15, 0.25, 0.35, 0.455, 0.557, 0.655, 0.752, 0.852, 0.983, 1.0]
CALIB = [   # online rate while available at each share in _X, by band (v2: isotonic fit, Mar-Aug 2026)
    [0.024, 0.029, 0.055, 0.1, 0.247, 0.247, 0.379, 0.549, 0.588, 0.621, 0.621, 0.621, 0.621, 0.926],
    [0.026, 0.054, 0.067, 0.132, 0.234, 0.276, 0.433, 0.549, 0.622, 0.743, 0.743, 0.743, 0.743, 0.924],
    [0.064, 0.075, 0.134, 0.233, 0.316, 0.394, 0.487, 0.53, 0.641, 0.753, 0.846, 0.909, 0.921, 0.972],
    [0.086, 0.133, 0.213, 0.278, 0.363, 0.497, 0.6, 0.666, 0.703, 0.779, 0.841, 0.936, 0.971, 0.988],
]
MIN_CELL = 10
MIN_BIN = 20


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    hub = ctx.hub(date)
    stats = ctx.stats_at(date)
    fleet = stats["fleet"].get("combustion_turbine")
    rows = {}
    for key, u in units.items():
        if u["tech"] != "combustion_turbine":
            continue
        s = stats["units"].get(key)
        p = np.zeros(24)
        src = "fleet"
        for h in range(24):
            b = C.price_bin(float(hub[h])) if hub is not None else None
            if s is None or b is None:
                if s is not None and s["avail"].sum():
                    p[h] = s["on"].sum() / s["avail"].sum(); src = "unit-all"
                elif fleet is not None and fleet["avail"].sum():
                    p[h] = fleet["on"].sum() / fleet["avail"].sum()
                continue
            if s["avail"][b, h] >= MIN_CELL:
                p[h] = s["on"][b, h] / s["avail"][b, h]; src = "unit-cell"
            elif s["avail"][b].sum() >= MIN_BIN:
                p[h] = s["on"][b].sum() / s["avail"][b].sum(); src = "unit-bin"
            elif fleet is not None and fleet["avail"][b, h]:
                p[h] = fleet["on"][b, h] / fleet["avail"][b, h]
        if hub is not None:
            for h in range(24):
                if float(hub[h]) > C.CHEAP_HUB:
                    p[h] = np.interp(p[h], _X, CALIB[int(np.searchsorted(BANDS, float(hub[h])))])
        rows[key] = {"p_on": np.round(p, 3), "source": src, "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": {"hub": hub is not None}}
