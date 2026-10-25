"""The day-ahead market's commitment call replayed for one unit: each configuration as a
price-taker at its node's day-ahead prices for the day, on its three-part offer as public when
the day cleared (the DAM disclosure of Context.known_dam_date, sixty days old): minimum-energy
cost at LSL, the offer curve above LSL, and its hot start cost per start.  The on/off path over
the 24 hours that earns most is found by dynamic programming from a given state going in; a CC
train is on in an hour when any of its configurations is.

With the day's own offer and its true state going in, this matched the DAM's award through the
cheap stretch on about 92% of CC train-days (Jan-Aug 2026, analysis/cheap-hour-awards.md); with
the sixty-day-old offer, 75%.  thermal_cutoff reads it as one input to the stay-on rule
(off_share), so the fit decides how far a stale offer carries.
"""
import datetime as dt

import numpy as np

from ..forecast import context as C


def _profit(u, prices, h):
    """$ earned in hour h on at least LSL, or None without the offer's parts."""
    p, lsl, mg = prices[h], u.get("lsl"), u.get("mingen")
    if p is None or not np.isfinite(p) or not lsl or mg is None:
        return None
    v = (p - mg) * lsl
    ci = (u.get("curve") or [None] * 24)[h] if len(u.get("curve") or []) > h else None
    if ci is not None and u.get("curves"):
        prev = lsl
        for a, m in zip(*u["curves"][ci]):
            if m > prev:
                v += max(0.0, p - a) * (m - prev)
                prev = m
    return v


def path(u, prices, on_in):
    """[24] bool: the most profitable on/off path for one configuration, or None."""
    pf = [_profit(u, prices, h) for h in range(24)]
    if any(x is None for x in pf):
        return None
    sc = (u.get("start") or [None])[0] or 0.0
    lo = -1e18
    val = {0: lo if on_in else 0.0, 1: 0.0 if on_in else lo}
    back = []
    for h in range(24):
        nv, bk = {}, {}
        for s in (0, 1):
            best, arg = lo, 0
            for q in (0, 1):
                if val[q] <= lo / 2:
                    continue
                c = val[q] + (pf[h] if s else 0.0) - (sc if s and not q else 0.0)
                if c > best:
                    best, arg = c, q
            nv[s], bk[s] = best, arg
        val = nv
        back.append(bk)
    s = int(val[1] > val[0])
    out = []
    for h in range(23, -1, -1):
        out.append(bool(s))
        s = back[h][s]
    return np.array(out[::-1])


def replay(ctx: C.Context, date, configs, on_in=True):
    """[24] bool for a unit or train (its configurations' resource names), or None when the
    known disclosure is not at least sixty days old or no configuration has an offer and
    prices."""
    cache = ctx.__dict__.setdefault("_dam_replay", {})
    key = (date, tuple(configs), on_in)
    if key not in cache:
        kdate = ctx.known_dam_date(date)
        res = None
        if kdate and kdate <= (C._d(date) - dt.timedelta(days=C.LAG)).isoformat():
            kd = (ctx.dam(kdate) or {}).get("units", {})
            for name in configs:
                u = kd.get(name)
                prices = ctx.node_price(date, u.get("sp"), name=name) if u and u.get("sp") else None
                r = path(u, list(prices), on_in) if prices is not None else None
                if r is not None:
                    res = r if res is None else (res | r)
        cache[key] = res
    return cache[key]


def off_share(ctx: C.Context, date, configs, bs, nh):
    """Share of the window's hours the replay has the unit off, from on going in; NaN without a
    replay."""
    r = replay(ctx, date, configs)
    return float(1.0 - r[bs:bs + nh].mean()) if r is not None and nh > 0 else np.nan
