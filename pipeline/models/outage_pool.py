"""Outages as a pooled deduction, v11 candidate (THERMAL_VARIANT=v11, part "pool"): the
outage the unit-level report does not name is taken off the zone's committed minimum and
expected output by hour, without placing it on any unit.

Units named in ERCOT's unplanned outage report keep their unit-level calls (thermal_cutoff:
"outage" when listed in full, out_share for a CC train's listed gas turbines).  Everything
else is judged on its economics alone, with no outage haircut, and the pool takes off what the
unnamed outages remove.

The deduction is fitted at the asof point on the days whose hourly states were public by then
(from the first unplanned report snapshot on).  Its target on a past day, for each zone and
hour, is what today's forecast holds (the dispatch rows' minimum and expected output, hour by
hour) on the units that were on outage that day and not named in that day's report: what the
forecast would have had to take back off had today's outages looked like that day's.  Units
out on most of their days in the year to the point (CHRONIC) are left out: they are
mothballed, and the commitment calls them off already.  Per zone and hour, the target
regresses on the zone's unexplained outage (Context.zone_remainder):

  deduction[z, h] = max(0, a_zh + b_zh x remainder_z)

and is split across technologies, and across technology and group pairs when the caller gives
the groups, by each one's part of the zone's target over the fitted days.
Without MIN_DAYS fitted days, ready() is false and v10's outage calls stand.
"""
import datetime as dt
from collections import defaultdict

import numpy as np

from ..forecast import context as C
from .outage_v11 import FIRST_SNAPSHOT, TECHS

MIN_DAYS = 20      # fitted days a point needs before the pool is used
CHRONIC = 0.6      # a unit out on more than this share of its days in the year to the point is left out


def _chronic(ctx, key, point):
    st = ctx.day_states(key, TECHS)
    lo = (C._d(point) - dt.timedelta(days=365)).isoformat()
    days = [s for d, s in st.items() if lo < d <= point]
    return bool(days) and np.mean([(s == "o").mean() >= 0.5 for s in days]) > CHRONIC


def _panel(ctx, date, units):
    """[(remainder by zone, [(key, zone, tech, out [24])])] for each fitted day, cached per asof
    point: the units on outage that day and not named in its report."""
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_pool_panel", {})
    if point not in cache:
        pool_units = []
        for key, u in units.items():
            if u["tech"] not in TECHS or _chronic(ctx, key, point):
                continue
            z = ctx.zone_of(u["sp"], key)
            if z:
                pool_units.append((key, z, u["tech"]))
        days = []
        for d in ctx.uh.get("dates", []):
            if d < FIRST_SNAPSHOT or d > (point or ""):
                continue
            listed, rem = ctx.listed_out(d), ctx.zone_remainder(d)
            if listed is None or rem is None:
                continue
            outs = []
            for key, z, tech in pool_units:
                if listed.get(key):
                    continue
                seg = ctx.day_states(key, TECHS).get(d)
                if seg is not None and (seg == "o").any():
                    outs.append((key, z, tech, (seg == "o").astype(float)))
            days.append((rem, outs))
        cache[point] = days
    return cache[point]


def ready(ctx, date, units):
    """Whether the pool has MIN_DAYS fitted days at asof(date)."""
    return len(_panel(ctx, date, units)) >= MIN_DAYS


def deduction(ctx, date, units, held, group_of=None):
    """{"min": {tech: [24]}, "exp": {tech: [24]}, "pair": {"min": {(tech, group): [24]}, "exp": {...}},
    "zones": {zone: [24] min}, "days": n} MW to take off the committed minimum and expected
    output, given `held` {key: (min [24], exp [24])} from today's dispatch and `group_of`
    {key: group}; None when not ready or the day has no zonal report."""
    days = _panel(ctx, date, units)
    rem = ctx.zone_remainder(date)
    if len(days) < MIN_DAYS or rem is None:
        return None
    zero = np.zeros(24)
    X, Ymin, Yexp = defaultdict(list), defaultdict(list), defaultdict(list)
    by_tech, by_pair = defaultdict(lambda: defaultdict(float)), defaultdict(lambda: defaultdict(float))
    group_of = group_of or {}
    for r, outs in days:
        tmin, texp = defaultdict(lambda: np.zeros(24)), defaultdict(lambda: np.zeros(24))
        for key, z, tech, out in outs:
            mn, ex = held.get(key, (zero, zero))
            tmin[z] += out * mn; texp[z] += out * ex
            by_tech[z][tech] += float((out * mn).sum())
            by_pair[z][(tech, group_of.get(key, "ungrouped"))] += float((out * mn).sum())
        for z, v in r.items():
            X[z].append(max(v, 0.0)); Ymin[z].append(tmin[z]); Yexp[z].append(texp[z])
    out = {"min": defaultdict(lambda: np.zeros(24)), "exp": defaultdict(lambda: np.zeros(24)), "zones": {}, "days": len(days),
           "pair": {"min": defaultdict(lambda: np.zeros(24)), "exp": defaultdict(lambda: np.zeros(24))}}
    for z, x in X.items():
        if z not in rem:
            continue
        A = np.column_stack([np.ones(len(x)), x])
        cmin, *_ = np.linalg.lstsq(A, np.vstack(Ymin[z]), rcond=None)    # [2, 24]: a and b by hour
        cexp, *_ = np.linalg.lstsq(A, np.vstack(Yexp[z]), rcond=None)
        xz = max(rem[z], 0.0)
        mn = np.maximum(0.0, cmin[0] + cmin[1] * xz)
        ex = np.maximum(0.0, cexp[0] + cexp[1] * xz)
        tot = sum(by_tech[z].values())
        out["zones"][z] = mn
        for t, v in by_tech[z].items():
            if tot > 0:
                out["min"][t] += v / tot * mn; out["exp"][t] += v / tot * ex
        for tg, v in by_pair[z].items():
            if tot > 0:
                out["pair"]["min"][tg] += v / tot * mn; out["pair"]["exp"][tg] += v / tot * ex
    out["min"], out["exp"] = dict(out["min"]), dict(out["exp"])
    out["pair"] = {k: dict(v) for k, v in out["pair"].items()}
    return out
