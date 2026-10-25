"""P(on at the start of the day) for CC trains and gas steam units, chained forward from the last
60-day day.

The anchor is the unit's true state at HE24 of the known 60-day day K (Context.known_date).  For
each day t from K + 1 to D - 1, a transition logistic gives P(on at HE24 of t) from the state at
HE24 of t - 1 (one fit from on, one from off) and day t's day-ahead prices at the unit's node
against its known minimum-energy cost (FEATURES), with one intercept per unit.  Day t's prices are
public by D - 1, so the chain uses nothing the live forecast lacks.  The probability is carried
forward, p_t = p x P(on | on) + (1 - p) x P(on | off).

The transitions are fitted at the asof point on the hourly states up to it (FIT_DAYS days).
Offline (Oct 2026, analysis/cheap-hour-awards.md): as a call of the start state the chain was
right on 88.8% of CC train-days against 86.1% for "on", and added to the commitment model it
recovered almost all of the accuracy of knowing the true start.
"""
import datetime as dt

import numpy as np

from ..forecast import context as C

TECHS = ("combined_cycle", "gas_steam")
FIT_DAYS = 365
FIT_MIN = 200     # transitions a side (from on, from off) needs for its fit
# day features: evening max margin, mean margin, min margin ($/MWh over the minimum-energy cost, /50),
# share of hours below cost, overnight (HE1-6) mean margin (/50)
FEATURES = ("evening max", "mean", "min", "hours below cost", "overnight")


def _end_on(st, dn):
    """1.0 / 0.0 for online / offline at HE24 of day number dn, None for outage or no data."""
    i = dn * 24 + 23
    if dn < 0 or i >= len(st) or st[i] in "-o":
        return None
    return float(st[i] in "ma")


def _feats(ctx, key, date):
    cache = ctx.__dict__.setdefault("_chain_feats", {})
    if (key, date) not in cache:
        u = ctx.units(date).get(key)
        f = None
        if u and u.get("sp") and u.get("mingen") is not None:
            pr = ctx.node_price(date, u["sp"], name=(u.get("configs") or [key])[0])
            if pr is not None:
                m = np.asarray(pr, float) - u["mingen"]
                f = np.array([m[16:22].max() / 50.0, m.mean() / 50.0, m.min() / 50.0, (m < 0).mean(), m[:6].mean() / 50.0])
        cache[(key, date)] = f
    return cache[(key, date)]


def _fit(ctx, point):
    """{0: (coef, intercepts by unit, default), 1: ...} or None, cached per asof point."""
    from sklearn.linear_model import LogisticRegression
    cache = ctx.__dict__.setdefault("_chain_fit", {})
    if point in cache:
        return cache[point]
    raw, day0 = ctx.raw_states(), ctx.stats["day0"]
    lo = (C._d(point) - dt.timedelta(days=FIT_DAYS)).isoformat()
    dates = [d for d in ctx.uh.get("dates", []) if lo < d <= point]
    keys = sorted(k for k, (t, _) in raw.items() if t in TECHS)
    ui = {k: i for i, k in enumerate(keys)}
    X, y = {0: [], 1: []}, {0: [], 1: []}
    for d in dates[1:]:
        dn = (C._d(d) - day0).days
        for k in keys:
            st = raw[k][1]
            s0, s1 = _end_on(st, dn - 1), _end_on(st, dn)
            f = _feats(ctx, k, d) if s0 is not None and s1 is not None else None
            if f is None:
                continue
            oh = np.zeros(len(keys))
            oh[ui[k]] = 1.0
            X[int(s0)].append(np.r_[f, oh])
            y[int(s0)].append(s1)
    out = {}
    for s in (0, 1):
        ys = np.array(y[s])
        if len(ys) < FIT_MIN or ys.min() == ys.max():
            cache[point] = None
            return None
        m = LogisticRegression(C=1.0, max_iter=2000).fit(np.array(X[s]), ys)
        b = m.coef_[0]
        out[s] = (b[:len(FEATURES)], {k: float(b[len(FEATURES) + i]) for k, i in ui.items()}, float(m.intercept_[0]))
    cache[point] = out
    return out


def p_start(ctx, date, key):
    """P(on at HE24 of D - 1) for a CC train or gas steam unit, or None (no fit, no anchor)."""
    cache = ctx.__dict__.setdefault("_chain_p", {})
    if (date, key) in cache:
        return cache[(date, key)]
    point, _ = ctx.asof(date)
    known, _ = ctx.known_date(date)
    fit = _fit(ctx, point) if point else None
    st = (ctx.raw_states().get(key) or (None, None))[1]
    p = None
    if fit and st is not None and known and known <= (C._d(date) - dt.timedelta(days=C.LAG)).isoformat():
        day0 = ctx.stats["day0"]
        p = _end_on(st, (C._d(known) - day0).days)
        t = C._d(known) + dt.timedelta(days=1)
        while p is not None and t < C._d(date):
            f = _feats(ctx, key, t.isoformat())
            if f is not None:
                a = [1.0 / (1.0 + np.exp(-(float(fit[s][0] @ f) + fit[s][1].get(key, 0.0) + fit[s][2]))) for s in (0, 1)]
                p = p * a[1] + (1.0 - p) * a[0]
            t += dt.timedelta(days=1)
    cache[(date, key)] = p
    return p
