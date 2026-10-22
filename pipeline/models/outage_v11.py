"""Outages, v11 candidate (THERMAL_VARIANT=v11, part "out"): how much of each coal, CC, gas
steam and combustion turbine unit is out on the day, in place of v10's long-outage carry-over,
listed-out verdicts and zonal unseen allocation (analysis/outage-component in the project
files, out of sample Mar-Aug 2026: fleet bias -0.3 GW against v10's +2.0 GW).

Two stages, both fitted at the asof point on the days whose outcome was public by then (on or
before the point, and on or after the first unplanned outage report snapshot):

  zone total  per outage-capacity zone, a line of the actual outage MW of these units (HSL x
              share of the day in the outage state) on the zonal report's mean total for the
              day (Context._cap "total"), from MIN_ZONE_DAYS days or more
  which units a logistic on the share of the day each unit was out (targets fractional, as
              weights), from
                - its listed share in ERCOT's unplanned outage report public before the day
                  cleared (Context.listed_out) and whether that share is whole
                - whether it was out at the last hour of the day LAG days before (the 60-day
                  lag), and log(1 + the days that outage had run), by technology
                - its seasonal outage prior (outage_prior), log(1 + HSL), the technology
  The zone's units then have their odds scaled by one factor so their HSL x share adds up to
  the zone total.  A unit with no zone keeps its logistic share.

Each unit's share goes to out_share, which the dispatch model takes off its weight; no unit is
called "outage" for the day here (nuclear keeps its own calls).  Without MIN_DAYS fitted days
(the first two months or so after the report snapshots begin) it returns None and v10's
outage calls stand.
"""
import datetime as dt
from collections import defaultdict

import numpy as np

from ..forecast import context as C

TECHS = ("coal", "combined_cycle", "gas_steam", "combustion_turbine")
MIN_DAYS = 20          # fitted days a point needs before the component is used
MIN_ZONE_DAYS = 10     # days with a zonal total a zone's line needs
MAX_SPELL = 400        # days an outage spell is counted back at most
FIRST_SNAPSHOT = "2025-11-30"   # first unplanned outage report snapshot (pipeline/outages.py)


def _last(ctx, key, d):
    """(out at the last hour of the day LAG days before d, days the outage had run by then):
    a day counts toward the spell when it is at least half outage."""
    st = ctx.day_states(key, TECHS)
    k = (C._d(d) - dt.timedelta(days=C.LAG))
    seg = st.get(k.isoformat())
    if seg is None:
        return 0.0, 0.0
    hrs = np.nonzero(seg != "-")[0]
    last_o = float(hrs.size and seg[hrs[-1]] == "o")
    n = 0
    while n < MAX_SPELL:
        s = st.get((k - dt.timedelta(days=n)).isoformat())
        if s is None or (s == "o").mean() < 0.5:
            break
        n += 1
    return last_o, float(n)


def _actual(ctx, key, d):
    """Share of day d the unit was in the outage state, or None with half the day or more
    without data."""
    seg = ctx.day_states(key, TECHS).get(d)
    if seg is None or (seg == "-").mean() >= 0.5:
        return None
    return float((seg == "o").mean())


def _x(tech, hsl, listed, last_o, spell, prior):
    log_spell = np.log1p(spell) * last_o
    f = [listed, float(listed >= 1.0), last_o, log_spell, prior, np.log1p(hsl or 0.0)]
    for t in TECHS:
        on = float(tech == t)
        f += [on, on * log_spell, on * listed]
    return f


def _day_rows(ctx, units, d):
    """[(key, zone, hsl, features)] for the units on day d, cached per day."""
    cache = ctx.__dict__.setdefault("_out_rows", {})
    if d not in cache:
        listed = ctx.listed_out(d) or {}
        prior = C.outage_prior(TECHS, d)
        rows = []
        for key, u in units.items():
            if u["tech"] not in TECHS:
                continue
            last_o, spell = _last(ctx, key, d)
            rows.append((key, ctx.zone_of(u["sp"], key), float(u["hsl"] or 0.0),
                         _x(u["tech"], u["hsl"], listed.get(key, 0.0), last_o, spell, prior.get(key, 0.0))))
        cache[d] = rows
    return cache[d]


def _zone_total(ctx, d):
    ctx._load_zones()
    c = ctx._cap.get(d)
    return {z: float(np.mean([a or 0 for a in v])) for z, v in c["total"].items()} if c and c.get("total") else {}


def _fit(ctx, date, units):
    """(logistic, {zone: (intercept, slope)}) at asof(date), or None without MIN_DAYS days."""
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_out_fit", {})
    if point in cache:
        return cache[point]
    from sklearn.linear_model import LinearRegression, LogisticRegression
    X, y, zd = [], [], defaultdict(list)
    days = [d for d in ctx.uh.get("dates", []) if FIRST_SNAPSHOT <= d <= (point or "")]
    n = 0
    for d in days:
        if ctx.listed_out(d) is None:
            continue
        n += 1
        ztot = _zone_total(ctx, d)
        act = defaultdict(float)
        for key, z, hsl, f in _day_rows(ctx, units, d):
            a = _actual(ctx, key, d)
            if a is None:
                continue
            X.append(f); y.append(a)
            if z:
                act[z] += a * hsl
        for z, mw in act.items():
            if z in ztot:
                zd[z].append((ztot[z], mw))
    if n < MIN_DAYS:
        cache[point] = None
        return None
    X, y = np.array(X), np.clip(np.array(y), 0, 1)
    m = LogisticRegression(C=1.0, max_iter=3000).fit(np.vstack([X, X]), np.r_[np.ones(len(y)), np.zeros(len(y))],
                                                      sample_weight=np.r_[y, 1 - y])
    lines = {}
    for z, v in zd.items():
        if len(v) >= MIN_ZONE_DAYS:
            a = np.array(v)
            lr = LinearRegression().fit(a[:, :1], a[:, 1])
            lines[z] = (float(lr.intercept_), float(lr.coef_[0]))
    cache[point] = (m, lines)
    return cache[point]


def _scale(p, hsl, target):
    """p with its odds scaled by one factor k so that sum(hsl x p) = target (k in 0 to 50)."""
    lo, hi = 0.0, 50.0
    for _ in range(50):
        k = (lo + hi) / 2
        if (hsl * k * p / (1 - p + k * p)).sum() > target:
            hi = k
        else:
            lo = k
    return k * p / (1 - p + k * p)


def shares(ctx, date, units):
    """{key: share of the day out} for the units of TECHS, or None when the fit is not ready."""
    fit = _fit(ctx, date, units)
    if fit is None:
        return None
    m, lines = fit
    rows = _day_rows(ctx, units, date)
    p = m.predict_proba(np.array([r[3] for r in rows]))[:, 1]
    out = {r[0]: float(v) for r, v in zip(rows, p)}
    ztot = _zone_total(ctx, date)
    by = defaultdict(list)
    for i, r in enumerate(rows):
        if r[1] in lines and r[1] in ztot:
            by[r[1]].append(i)
    for z, ix in by.items():
        a, b = lines[z]
        target = max(0.0, a + b * ztot[z])
        sc = _scale(p[ix], np.array([rows[i][2] for i in ix]), target)
        for i, v in zip(ix, sc):
            out[rows[i][0]] = float(v)
    return out
