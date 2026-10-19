"""Dispatch: the shape within the day for the committed set.  The committed set is fixed for
the day by the commitment model; this model only says where each committed unit sits between
its minimum and maximum in each hour.

For a unit with weight p_on (from thermal_cutoff, or by hour from peaker_share):

  mw[h]   = p_on x clamp(curve(price[h]), LSL, HSL)
            curve: the unit's SCED2 offer curve from the latest monthly snapshot public before
            the day cleared (pipeline.forecast.context, UNIT_DATA_DIR/forecast/curves/), met by
            the day-ahead price at the unit's node (the hub average when the node has none);
            a combined-cycle train uses its most recently seen configuration's curve with the
            MW scaled to the train's HSL, since the snapshot may hold a smaller configuration;
            a unit without a curve runs at its median output when running, else at HSL
            (nuclear) or LSL
  min[h]  = p_on x floor        the committed minimum (floor = the snapshot configuration LSL the
                                curve is clamped to, else the day-ahead LSL)
  off window: a unit judged "off" or "maybe" for a window is at 0 inside it (its p_on applies
            outside), since the verdict says it shuts for those hours; a whole-day "off" is 0
            throughout; nuclear runs at HSL.  A unit whose commitment row carries an hourly
            probability of being online (p_hours, thermal_cutoff v1) uses it instead.
"""
import numpy as np

from ..forecast import context as C

NAME = "thermal_dispatch"
VERSION = "v2"    # v2: hourly p_hours rows from thermal_cutoff v1; v1: committed minimum uses the configuration floor; breakpoint interpolation fix


def _config_curve(ctx, month, u):
    """Curve, HSL and LSL for a train: its configuration with the most recent snapshot (ties:
    most online runs that day)."""
    best = None
    for name in u["configs"]:
        c = ctx.curves(month).get(name) if month else None
        if c and c.get("p") and (best is None or (c["date"], c["n_on"]) > (best["date"], best["n_on"])):
            best = c
    return best


def forecast(date, ctx: C.Context, commit: dict, peakers: dict) -> dict:
    units = ctx.units(date)
    hub = ctx.hub(date)
    month, hindsight = ctx.curve_month(date)
    stats = ctx.stats_at(date)
    rows = {}
    n_curve = 0
    for key, row in commit["rows"].items():
        u = units[key]
        hsl, lsl = float(u["hsl"] or 0.0), float(u["lsl"] or 0.0)
        if row["tech"] == "combustion_turbine" and key in peakers["rows"]:
            p = peakers["rows"][key]["p_on"]
        else:
            p = np.full(24, float(row["p_on"]))
        if row.get("p_hours") is not None:
            p = np.asarray(row["p_hours"], float)
        elif row["off_from"]:
            a = row["off_from"] - 1
            p = p.copy(); p[a:a + row["off_hours"]] = 0.0
        prices = ctx.node_price(date, u["sp"], name=u["configs"][0]) if u["sp"] else None
        if prices is None:
            prices = hub
        c = _config_curve(ctx, month, u)
        s = stats["units"].get(key)
        mw = np.zeros(24)
        floor = lsl    # the minimum the model holds the unit at when on: the snapshot configuration's LSL
        if row["tech"] == "nuclear":
            mw[:] = hsl
        elif c and prices is not None:
            n_curve += 1
            chsl = c["hsl"] if c.get("hsl") else hsl
            clsl = c["lsl"] if c.get("lsl") is not None else lsl
            scale = hsl / chsl if (len(u["configs"]) > 1 and chsl and hsl and abs(hsl - chsl) > 1) else 1.0
            cmw = (np.asarray(c["mw"], float) * scale).tolist()
            floor = min(clsl * scale, chsl * scale)
            for h in range(24):
                mw[h] = C.curve_mw(c["p"], cmw, float(prices[h]), floor, chsl * scale)
            # the snapshot's limits can differ from the DAM's; keep the DAM's as the envelope
            if hsl > 0:
                mw = np.clip(mw, lsl, hsl)
                floor = float(min(max(floor, lsl), hsl))
        elif s and s["out_med"] is not None:
            mw[:] = min(max(s["out_med"], lsl), hsl) if hsl > 0 else s["out_med"]
        else:
            mw[:] = hsl if row["tech"] == "nuclear" else lsl
        rows[key] = {"exp": np.round(p * mw, 1), "min": np.round(p * floor, 1), "hsl": hsl, "p": np.round(p, 3),
                     "floor": round(floor, 1), "curve": bool(c), "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": {"curve_month": month, "curve_hindsight": hindsight, "with_curve": n_curve}}
