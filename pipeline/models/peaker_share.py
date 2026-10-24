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

v3 adds what turns a peaker on: its own run margin.  For each hour, the best contiguous run
through it of (day-ahead node price - minimum-energy cost) x LSL, less one hot start, and the
hour's own margin, both from the unit's costs in the DAM disclosure (generic combustion turbine
costs without a three-part offer, flagged).  A logistic (_fit) turns the share (as a logit), the
hub price and those margins into p_on in place of CALIB; it is fitted per history point on the
TRAIN_DAYS days of the 60-day record up to the point, on the hours each unit was available, with
the share as of each training day, so it knows only what the forecast of that day knew.  Without a
fit (too few rows), CALIB stands.  Offline (Apr-Aug 2026, each month fitted on the 90 days ending
60 days before it) it cut the fleet's hourly combustion-turbine minimum-output error from 550 to
507 MW, and from 1,026 to 811 MW in hours with the hub above $45.
"""
import os

import numpy as np

from ..forecast import context as C

NAME = "peaker_share"
VERSION = "v3b"   # v3b: v3 with an intercept per upper hub band (v3 under-called 30-45); v3: logistic on the share, the hub and the unit's own run margin in place of CALIB; v2: share of available hours (outage hours left out), CALIB refit; v1: history share mapped through CALIB by hub price band
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
TRAIN_DAYS = 90     # days of the 60-day record up to the history point the v3 logistic is fitted on
TRAIN_MIN = 20000
LIVE_COSTS = os.environ.get("PEAKER_COSTS") == "lagged"   # backtest check: costs as the live forecast has them
FREQ_ONLY = os.environ.get("PEAKER_VARIANT") == "freq"   # backtest control: the same as-of fit without the cost features   # available unit-hours it needs
FEATURES = ["share", "hub", "run", "run_pos", "hour_margin", "offer", "run_o", "run_pos_o", "hour_margin_o", "hub_30", "hub_45"]


def _share(s, fleet, hub):
    """[24] online share while available, by the hour's hub bin (unit cell, unit bin, fleet cell),
    and where it came from."""
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
    return p, src


def _best_run(m):
    """[24]: the best sum of m over a contiguous run of hours containing each hour."""
    out = np.full(len(m), -np.inf)
    for i in range(len(m)):
        run = 0.0
        for j in range(i, len(m)):
            run += m[j]
            out[i:j + 1] = np.maximum(out[i:j + 1], run)
    return out


def _x(p, hub, prices, u):
    """[24, FEATURES] for one unit-day: the share as a logit, the hub, the run margin through each
    hour per MW of LSL (less one hot start; compressed) and whether it is positive, the hour's own
    margin, whether the costs are the unit's own offer, and the margins again for own offers."""
    lsl = u["lsl"] or u["hsl"] or 0.0
    if prices is None or not lsl or u["mingen"] is None:
        return None
    q = np.clip(p, 1e-3, 1 - 1e-3)
    margin = prices - u["mingen"]
    run = (_best_run(margin * lsl) - (u["hot"] or 0.0)) / lsl
    own = float(u["est"] == 0)
    x = np.column_stack([np.log(q / (1 - q)), np.clip(hub, -20, 200) / 50, np.arcsinh(run / 10), (run > 0).astype(float),
                         np.clip(margin, -100, 300) / 50, np.full(24, own)])
    bands = np.column_stack([hub > b for b in BANDS[1:]]).astype(float)    # an intercept for each of CALIB's upper hub bands
    out = np.column_stack([x, x[:, 2:5] * own, bands])
    if FREQ_ONLY:
        out[:, 2:9] = 0.0
    return out


def _costs(ctx, date, units):
    """units with the costs (mingen, hot, est) the live forecast would have for `date`: from the
    latest disclosure at least LAG days before it, not the day's own offer (LIVE_COSTS)."""
    if not LIVE_COSTS:
        return units
    cut = (C._d(date) - C.dt.timedelta(days=C.LAG)).isoformat()
    ok = [d for d in ctx.dam_days if d <= cut]
    old = ctx.units(ok[-1]) if ok else {}
    out = {}
    for key, u in units.items():
        o = old.get(key)
        g = C.GENERIC_COSTS.get(u["tech"])
        if o is not None and o["est"] == 0:
            out[key] = dict(u, mingen=o["mingen"], hot=o["hot"], est=0)
        elif g is not None:
            out[key] = dict(u, mingen=g[3], hot=g[0], est=2)
        else:
            out[key] = u
    return out


def _fit(ctx, date):
    """The v3 logistic as of asof(date): (coef, intercept), or None.  Cached per history point."""
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_peaker_fit", {})
    if point in cache:
        return cache[point]
    from sklearn.linear_model import LogisticRegression
    raw, day0 = ctx.raw_states(), ctx.stats["day0"]
    days = [d for d in ctx.uh.get("dates", []) if point is not None and d <= point][-TRAIN_DAYS:]
    X, y = [], []
    for d in days:
        hub = ctx.hub(d)
        if hub is None:
            continue
        stats = ctx.stats_at(d)
        fleet = stats["fleet"].get("combustion_turbine")
        dn = (C._d(d) - day0).days
        for key, u in _costs(ctx, d, ctx.units(d)).items():
            st = raw.get(key)
            if u["tech"] != "combustion_turbine" or st is None or (dn + 1) * 24 > len(st[1]):
                continue
            seg = st[1][dn * 24:(dn + 1) * 24]
            up = np.isin(seg, ["0", "m", "a"])
            if not up.any():
                continue
            x = _x(_share(stats["units"].get(key), fleet, hub)[0], hub,
                   ctx.node_price(d, u["sp"], name=u["configs"][0]) if u["sp"] else None, u)
            if x is None:
                continue
            X.append(x[up]); y.append(np.isin(seg[up], ["m", "a"]).astype(float))
    fit = None
    if X and sum(len(v) for v in y) >= TRAIN_MIN:
        Y = np.concatenate(y)
        if 0 < Y.mean() < 1:
            m = LogisticRegression(C=1.0, max_iter=3000).fit(np.vstack(X), Y)
            fit = (m.coef_[0], float(m.intercept_[0]))
    cache[point] = fit
    return fit


def forecast(date, ctx: C.Context) -> dict:
    units = _costs(ctx, date, ctx.units(date))
    hub = ctx.hub(date)
    stats = ctx.stats_at(date)
    fleet = stats["fleet"].get("combustion_turbine")
    fit = _fit(ctx, date) if hub is not None else None
    rows = {}
    for key, u in units.items():
        if u["tech"] != "combustion_turbine":
            continue
        p, src = _share(stats["units"].get(key), fleet, hub)
        x = _x(p, hub, ctx.node_price(date, u["sp"], name=u["configs"][0]) if u["sp"] else None, u) if fit else None
        if x is not None:
            p = 1.0 / (1.0 + np.exp(-(x @ fit[0] + fit[1])))
            version = VERSION
        else:
            if hub is not None:
                for h in range(24):
                    if float(hub[h]) > C.CHEAP_HUB:
                        p[h] = np.interp(p[h], _X, CALIB[int(np.searchsorted(BANDS, float(hub[h])))])
            version = VERSION + "-calib"
        rows[key] = {"p_on": np.round(p, 3), "source": src, "model": NAME, "version": version}
    return {"rows": rows, "inputs": {"hub": hub is not None, "fit": fit is not None}}
