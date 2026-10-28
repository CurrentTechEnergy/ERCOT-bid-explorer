"""Peakers: combustion turbines start rather than stay on, so they are judged by hour: the
share of its available history a unit was online at this hour of day with the day-ahead hub
average in this price bin (pipeline.forecast.context.PRICE_BINS).  Hours on outage are left out
of that history (v2), so the share says how often the unit runs when it can; outage comes in
separately, as for other thermal units (thermal_cutoff: a long outage at the last known hour,
the unplanned outage report, and the zonal unseen outage share).

v3 also judges gas steam and CC units that run like peakers (peaker_like: online under
LIKE_SHARE of their available hours, at most LIKE_RUN_H online hours a day they run), which the
stay-on loss test asked the wrong question of, and stretches each block of their called hours
(p_on >= 0.5) to at least the unit's shortest usual run (_min_run).  Backtest #38/#40 (Oct 2026):
on those 21 units the day's on/off shape was right on 494 of 1,181 unit-days against 313, cheap-
hour shutdowns caught 94 of 100 against 89; all-hours committed-minimum MAE 1,627 against 1,601 MW.

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
import os

import numpy as np

from ..forecast import context as C

NAME = "peaker_share"
VERSION = "v3"    # v3: gas steam and CC units that run like peakers, their called hours in blocks of at least their shortest usual run; v2: share of available hours (outage hours left out), CALIB refit; v1: history share mapped through CALIB by hub price band
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
LIKE = os.environ.get("PEAKER_LIKE", "1") == "1"    # PEAKER_LIKE=0 judges combustion turbines alone (v2), for comparison
CT_LIKE = os.environ.get("PEAKER_CT_LIKE", "0") == "1"   # PEAKER_CT_LIKE=1: combustion turbines take the run test too; one that fails it is judged on its stay-on loss (thermal_cutoff)
LIKE_TECHS = ("gas_steam", "combined_cycle") + (("combustion_turbine",) if CT_LIKE else ())
LIKE_SHARE = float(os.environ.get("PEAKER_LIKE_SHARE", "0.25"))    # online share of available hours below this ...
LIKE_RUN_H = float(os.environ.get("PEAKER_LIKE_RUN_H", "16"))      # ... and online hours per day it ran at most this: started for the peak, not kept on
LIKE_MIN_H = 480      # available hours of record a unit needs to be judged so
MIN_RUN = os.environ.get("PEAKER_MIN_RUN", "1") == "1"   # a peaker-like unit's called hours form blocks of at least its shortest usual run (PEAKER_MIN_RUN=0: hour by hour)
MIN_RUN_Q = 10        # percentile of the unit's completed runs taken as its shortest usual run
MIN_RUN_N = 5         # completed runs a unit needs for its own; else MIN_RUN_DEFAULT
MIN_RUN_DEFAULT = 5


def _min_run(ctx, key, point):
    """Hours: the MIN_RUN_Q percentile of the unit's completed runs in the hourly states up to
    the end of `point`, cached per point."""
    cache = ctx.__dict__.setdefault("_peaker_min_run", {})
    if (key, point) not in cache:
        st = (ctx.raw_states().get(key) or (None, None))[1]
        runs = []
        if st is not None and point:
            n = min(len(st), ((C._d(point) - ctx.stats["day0"]).days + 1) * 24)
            on = np.isin(st[:n], ["m", "a"])
            i = 0
            while i < n:
                if on[i]:
                    j = i
                    while j < n and on[j]:
                        j += 1
                    if i > 0 and j < n:
                        runs.append(j - i)
                    i = j
                else:
                    i += 1
        cache[(key, point)] = float(np.percentile(runs, MIN_RUN_Q)) if len(runs) >= MIN_RUN_N else MIN_RUN_DEFAULT
    return cache[(key, point)]


def _block(p, n):
    """p with each run of hours at 0.5 or more stretched to at least n hours, one hour at a time
    toward the likelier neighbour, the added hours at the run's mean."""
    p = p.copy()
    on = p >= 0.5
    i = 0
    while i < 24:
        if not on[i]:
            i += 1
            continue
        j = i
        while j < 24 and on[j]:
            j += 1
        lo, hi, v = i, j, float(p[i:j].mean())
        while hi - lo < n and (lo > 0 or hi < 24):
            if hi >= 24 or (lo > 0 and p[lo - 1] >= p[hi]):
                lo -= 1
            else:
                hi += 1
        p[lo:hi] = np.maximum(p[lo:hi], v)
        on[lo:hi] = True
        i = hi
    return p


def peaker_like(stats) -> set:
    """Gas steam and CC units that run like peakers in the unit stats (empty when not LIKE)."""
    if not LIKE:
        return set()
    out = set()
    for key, s in stats["units"].items():
        av, on = s["avail"].sum(), s["on"].sum()
        if s["tech"] not in LIKE_TECHS:
            continue
        if av < LIKE_MIN_H or not s["on_days"]:
            if s["tech"] == "combustion_turbine":
                out.add(key)        # too little record to judge: a combustion turbine stays a peaker
            continue
        run_h = on / (s["on_days"] * s["tot"].sum() / 24.0)
        if on / av < LIKE_SHARE and run_h <= LIKE_RUN_H:
            out.add(key)
    return out


def judged_here(key, tech, like, stats) -> bool:
    """Whether this model judges the unit: a combustion turbine unless CT_LIKE and it has a record
    that fails the run test, else a unit in `like`."""
    if tech == "combustion_turbine":
        return not CT_LIKE or key in like or key not in stats["units"]
    return key in like


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    hub = ctx.hub(date)
    stats = ctx.stats_at(date)
    fleet = stats["fleet"].get("combustion_turbine")
    like = peaker_like(stats)
    rows = {}
    for key, u in units.items():
        if not judged_here(key, u["tech"], like, stats):
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
        if MIN_RUN and key in like and u["tech"] != "combustion_turbine":
            p = _block(p, int(round(_min_run(ctx, key, ctx.asof(date)[0]))))
        rows[key] = {"p_on": np.round(p, 3), "source": src, "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": {"hub": hub is not None}}
