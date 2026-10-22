"""Outages as a pooled deduction, v11 candidate (THERMAL_VARIANT=v11, part "pool"): the
outage the unit-level report does not name is taken off the zone's committed minimum and
expected output by hour, without placing it on any unit.

Units named in ERCOT's unplanned outage report keep their unit-level calls (thermal_cutoff:
"outage" when listed in full, out_share for a CC train's listed gas turbines).  Everything
else is judged on its economics alone, with no outage haircut, and the pool takes off what the
unnamed outages remove.

The deduction is fitted at the asof point on the days whose hourly states were public by then
(from the first unplanned report snapshot on).  Its target on a past day, for each zone and
hour, is what the units then on outage and not named in that day's report would have held had
they been available: for each such unit, its share of available hours online in that hub price
bin and hour (Context.stats_at on_bin, pulled toward its technology's fleet share by
SHRINK_H available hours) times its LSL (for the minimum) or its median output when running
(for the expected output).  Units out on most of their days in the year to the point
(CHRONIC) are left out: they are mothballed, and the commitment calls them off already.  Per
zone, the target regresses on the zone's unexplained outage (Context.zone_remainder) times the
same online share averaged over the zone's units (HSL-weighted) in that hour, so the deduction
is smaller in hours the fleet is mostly off:

  deduction[z, h] = max(0, a_z + b_z x remainder_z x share_z[h])

and is split across technologies by each one's part of the zone's target over the fitted days.
Without MIN_DAYS fitted days it returns None, and v10's outage calls stand.
"""
import datetime as dt
from collections import defaultdict

import numpy as np

from ..forecast import context as C
from .outage_v11 import FIRST_SNAPSHOT, TECHS

MIN_DAYS = 20      # fitted days a point needs before the pool is used
SHRINK_H = 48      # available hours at which a unit's own online share and its technology's weigh the same
CHRONIC = 0.6      # a unit out on more than this share of its days in the year to the point is left out


def _share(stats, key, tech, bins):
    """[24] the unit's share of available hours online, by the day's hub price bin and hour."""
    u = stats["units"].get(key)
    f = stats["fleet"].get(tech)
    if f is None or bins is None:
        return np.zeros(24)
    h = np.arange(24)
    fs = f["on"][bins, h] / np.maximum(f["avail"][bins, h], 1.0)
    if u is None:
        return fs
    on, av = u["on"][bins, h], u["avail"][bins, h]
    return (on + SHRINK_H * fs) / (av + SHRINK_H)


def _chronic(ctx, key, point):
    st = ctx.day_states(key, TECHS)
    lo = (C._d(point) - dt.timedelta(days=365)).isoformat()
    days = [s for d, s in st.items() if lo < d <= point]
    return bool(days) and np.mean([(s == "o").mean() >= 0.5 for s in days]) > CHRONIC


def _bins(ctx, d):
    h = ctx.hub(d)
    return None if h is None else np.array([C.price_bin(v) for v in h])


def _fleet_info(ctx, date, units):
    """[(key, tech, zone, hsl, lsl, out_med)] for the pool's units, cached per asof point."""
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_pool_units", {})
    if point not in cache:
        stats = ctx.stats_at(date)
        rows = []
        for key, u in units.items():
            if u["tech"] not in TECHS or _chronic(ctx, key, point):
                continue
            z = ctx.zone_of(u["sp"], key)
            if not z:
                continue
            s = stats["units"].get(key) or {}
            lsl = float(u["lsl"] or 0.0)
            rows.append((key, u["tech"], z, float(u["hsl"] or 0.0), lsl, float(s.get("out_med") or lsl)))
        cache[point] = rows
    return cache[point]


def _zone_share(ctx, stats, info, bins):
    """{zone: [24] HSL-weighted online share of the zone's pool units}."""
    num, den = defaultdict(lambda: np.zeros(24)), defaultdict(float)
    for key, tech, z, hsl, _, _ in info:
        num[z] += hsl * _share(stats, key, tech, bins)
        den[z] += hsl
    return {z: num[z] / den[z] for z in num if den[z] > 0}


def _fit(ctx, date, units):
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_pool_fit", {})
    if point in cache:
        return cache[point]
    stats = ctx.stats_at(date)
    info = _fleet_info(ctx, date, units)
    X, Y = defaultdict(list), defaultdict(list)          # zone -> rows of (x, min target, exp target)
    by_tech = defaultdict(lambda: defaultdict(float))     # zone -> tech -> summed min target
    n = 0
    for d in ctx.uh.get("dates", []):
        if d < FIRST_SNAPSHOT or d > (point or ""):
            continue
        listed = ctx.listed_out(d)
        rem = ctx.zone_remainder(d)
        bins = _bins(ctx, d)
        if listed is None or rem is None or bins is None:
            continue
        n += 1
        tmin, texp = defaultdict(lambda: np.zeros(24)), defaultdict(lambda: np.zeros(24))
        for key, tech, z, hsl, lsl, med in info:
            if listed.get(key):
                continue
            seg = ctx.day_states(key, TECHS).get(d)
            if seg is None:
                continue
            out = (seg == "o").astype(float)
            if not out.any():
                continue
            w = out * _share(stats, key, tech, bins)
            tmin[z] += w * lsl; texp[z] += w * med
            by_tech[z][tech] += float((w * lsl).sum())
        zs = _zone_share(ctx, stats, info, bins)
        for z, sh in zs.items():
            if z not in rem:
                continue
            X[z].append(max(rem[z], 0.0) * sh)
            Y[z].append(np.column_stack([tmin[z], texp[z]]))
    if n < MIN_DAYS:
        cache[point] = None
        return None
    lines = {}
    for z in X:
        x = np.concatenate(X[z]); y = np.vstack(Y[z])
        A = np.column_stack([np.ones_like(x), x])
        coef, *_ = np.linalg.lstsq(A, y, rcond=None)      # [2, 2]: (a, b) for min and exp
        tot = sum(by_tech[z].values())
        split = {t: v / tot for t, v in by_tech[z].items()} if tot > 0 else {}
        lines[z] = (coef, split)
    cache[point] = (lines, n)
    return cache[point]


def deduction(ctx, date, units):
    """{"min": {tech: [24]}, "exp": {tech: [24]}, "zones": {zone: [24] min}} MW to take off the
    committed minimum and expected output, or None when the fit is not ready."""
    fit = _fit(ctx, date, units)
    rem, bins = ctx.zone_remainder(date), _bins(ctx, date)
    if fit is None or rem is None or bins is None:
        return None
    lines, n = fit
    stats = ctx.stats_at(date)
    zs = _zone_share(ctx, stats, _fleet_info(ctx, date, units), bins)
    out = {"min": defaultdict(lambda: np.zeros(24)), "exp": defaultdict(lambda: np.zeros(24)), "zones": {}, "days": n}
    for z, (coef, split) in lines.items():
        if z not in rem or z not in zs:
            continue
        x = max(rem[z], 0.0) * zs[z]
        mn = np.maximum(0.0, coef[0, 0] + coef[1, 0] * x)
        ex = np.maximum(0.0, coef[0, 1] + coef[1, 1] * x)
        out["zones"][z] = mn
        for t, f in split.items():
            out["min"][t] += f * mn; out["exp"][t] += f * ex
    out["min"], out["exp"] = dict(out["min"]), dict(out["exp"])
    return out
