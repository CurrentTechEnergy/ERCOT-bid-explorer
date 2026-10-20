"""Peakers: combustion turbines start rather than stay on, so they are judged by hour: the
share of its history a unit was online at this hour of day with the day-ahead hub average in
this price bin (pipeline.forecast.context.PRICE_BINS).

  p_on[h]  the unit's own online share in the (bin, hour) cell when it has MIN_CELL hours of
           history there; else its own share for the bin over all hours (MIN_BIN hours); else
           the combustion-turbine fleet's share for the cell.

The hub price for the day is the day-ahead HB_HUBAVG; without it, the unit's overall online
share applies to every hour.

v1 maps that share through CALIB, the online rate actually seen at each level of it in the
hour's hub price band.  The share comes from history at least sixty days old, and peakers ran
more than it says whenever the hub was above CHEAP_HUB (Mar-Aug 2026: a share of 0.15 ran 19% of
the time at a $10-20 hub, 40% above $45).  Fitted on the backtest's unit-hours; fitted on Mar-May
alone and tried on Jun-Aug, it cut the fleet's hourly committed-minimum error from 714 to about
450 MW with little bias.  At or below CHEAP_HUB the share stands: it is about right there, and
the few cheap hours give no stable map.
"""
import numpy as np

from ..forecast import context as C

NAME = "peaker_share"
VERSION = "v1"    # v1: history share mapped through CALIB by hub price band
BANDS = [20.0, 30.0, 45.0]   # hub $/MWh: bands (CHEAP_HUB, 20], (20, 30], (30, 45], above 45
_X = [0.0, 0.012, 0.034, 0.073, 0.15, 0.25, 0.35, 0.455, 0.557, 0.655, 0.752, 0.852, 0.983, 1.0]
CALIB = [   # online rate at each share in _X, by band
    [0.033, 0.033, 0.051, 0.099, 0.192, 0.277, 0.43, 0.53, 0.614, 0.686, 0.836, 0.893, 0.932, 0.932],
    [0.036, 0.048, 0.068, 0.139, 0.227, 0.306, 0.465, 0.62, 0.712, 0.765, 0.799, 0.868, 0.934, 0.934],
    [0.085, 0.085, 0.15, 0.253, 0.338, 0.399, 0.487, 0.571, 0.657, 0.778, 0.81, 0.853, 0.93, 0.93],
    [0.143, 0.145, 0.232, 0.296, 0.404, 0.53, 0.591, 0.669, 0.68, 0.777, 0.782, 0.856, 0.902, 0.902],
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
                if s is not None and s["tot"].sum():
                    p[h] = s["on"].sum() / s["tot"].sum(); src = "unit-all"
                elif fleet is not None and fleet["tot"].sum():
                    p[h] = fleet["on"].sum() / fleet["tot"].sum()
                continue
            if s["tot"][b, h] >= MIN_CELL:
                p[h] = s["on"][b, h] / s["tot"][b, h]; src = "unit-cell"
            elif s["tot"][b].sum() >= MIN_BIN:
                p[h] = s["on"][b].sum() / s["tot"][b].sum(); src = "unit-bin"
            elif fleet is not None and fleet["tot"][b, h]:
                p[h] = fleet["on"][b, h] / fleet["tot"][b, h]
        if hub is not None:
            for h in range(24):
                if float(hub[h]) > C.CHEAP_HUB:
                    p[h] = np.interp(p[h], _X, CALIB[int(np.searchsorted(BANDS, float(hub[h])))])
        rows[key] = {"p_on": np.round(p, 3), "source": src, "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": {"hub": hub is not None}}
