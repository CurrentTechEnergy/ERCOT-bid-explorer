"""Peakers: combustion turbines start rather than stay on, so they are judged by hour: the
share of its history a unit was online at this hour of day with the day-ahead hub average in
this price bin (pipeline.forecast.context.PRICE_BINS).

  p_on[h]  the unit's own online share in the (bin, hour) cell when it has MIN_CELL hours of
           history there; else its own share for the bin over all hours (MIN_BIN hours); else
           the combustion-turbine fleet's share for the cell.

The hub price for the day is the day-ahead HB_HUBAVG; without it, the unit's overall online
share applies to every hour.
"""
import numpy as np

from ..forecast import context as C

NAME = "peaker_share"
VERSION = "v0"
MIN_CELL = 10
MIN_BIN = 20


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    hub = ctx.hub(date)
    fleet = ctx.stats["fleet"].get("combustion_turbine")
    rows = {}
    for key, u in units.items():
        if u["tech"] != "combustion_turbine":
            continue
        s = ctx.stats["units"].get(key)
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
        rows[key] = {"p_on": np.round(p, 3), "source": src, "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": {"hub": hub is not None}}
