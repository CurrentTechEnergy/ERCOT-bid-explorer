"""Peakers on real-time prices: a fit of each combustion turbine's hours online against the
real-time price at its own node, for the Commitment page's per-unit start chart.  A fit of past decisions,
not a forecast: the real-time price is not known when a peaker decides, and peakers starting
move it.  The forecast keeps peaker_share (day-ahead hub price bands).

The fit, per unit and month: a logistic regression of online (SCED "m"/"a") on the hour's
real-time settlement point price at the unit's resource node (the mean of its four 15-minute
prices, UNIT_DATA_DIR/nodes; the node from unit_index.json.gz), through
asinh(price / SCALE) so a $5 move counts for more near $20 than near $500) and the hour of day
(two harmonics), over its available hours (outage hours left out) on every day before the month
with node prices (they start Dec 2025), each hour weighted by HALF_LIFE: a day HALF_LIFE days
before the month counts half as much as the day before it.  Ridge L2 on everything but the
intercept.  A unit needs MIN_FIT_DAYS days, MIN_AVAIL available hours and MIN_EACH hours both
online and offline; else no row.

What the days prove: a fit has a price limit when, at the lowest price in them, it calls the unit
off in every hour.  Without one it runs at any price it has seen (start null), but only when it was
online in ANY_SHARE or more of its available hours: a unit that sat off most hours yet shows no
price limit is not running on price.  Nor is one the fit never calls on at any price (it ran more
at low prices than high).  Both are listed under "unexplained" instead of getting rows.  With a limit, the start is held between the
lowest price at which the unit was online and the highest at which it sat off: the fit knows
nothing past them.

Why weighted, all days (v3), against v2's 90 days before the month (refitted on every day before
when those showed no limit), Mar-Aug 2026, 245 CTs, days right / starts caught / month-to-month
move in a unit's median start (median, 90th percentile): 90 days 79.6% / 39% / $10, $111; equal
weight on all days 80.1% / 31% / $6, $41; half-life 60 days 81.4% / 36% / $10, $78; 30 days 82.1% /
40% / $11, $152.  A half-life picked per unit from its earlier months, or two classes (30 days or
equal weight), did no better than 30 days for all.

The start point: every hour's real-time price shifted by the same $/MWh until the fit calls the
unit on (chance 0.5 or more) in some hour, found exactly from the fit (each hour's threshold price
less its price, the smallest of them), and reported as the day's highest hourly price at that
shift, so it reads against the circle at the day's actual highest price.  A diamond left of the
circle: the fit says it ran.

v1 backtest Mar-Aug 2026, 245 CTs, each month fitted on the three before, hours right / starts caught /
on-calls right: real-time node 91.1% / 39% / 90.8%; real-time hub 90.7% / 37% / 89.6%; day-ahead
hub price bands (the forecast's peaker_share inputs) 90.1% / 32% / 89.0%; every hour off 70.4%.

Writes data/peaker/rt_fit.json.gz:
  {"model", "version", "columns": [...], "half_life", "days": {date: [[unit, start, peak, ran,
   hours_on, hours_avail, window], ...]}, "unexplained": {month: [[unit, online share], ...]}}
start and peak in $/MWh (real-time at the unit's node, highest hour of the day), start null when
it runs at any price; ran 1 when online in any hour; window the days the fit used.
Units on outage all day, and days without the node's 24 prices, are left out.  Rebuilt in full each run (a few seconds).
"""

import numpy as np

from ..config import DATA_DIR, UNIT_DATA_DIR
from ..parse_prices import node_hourly
from ..store import read_json_gz, write_json_gz

NAME = "peaker_rt"
VERSION = "v3"   # v3: every day before the month, weighted by HALF_LIFE; any price only at ANY_SHARE online
PATH = DATA_DIR / "peaker" / "rt_fit.json.gz"
COLUMNS = ("unit", "start", "peak", "ran", "hours_on", "hours_avail", "window")
SCALE = 10.0         # $/MWh in asinh(price / SCALE)
HALF_LIFE = 30.0     # days: a day this far before the month weighs half the day before it
MIN_FIT_DAYS = 45    # fewest days with prices a fit may use
ANY_SHARE = 0.5      # share of available hours online a unit needs to run "at any price"
MIN_AVAIL = 200      # available hours a unit's fit needs
MIN_EACH = 10        # hours online and offline it needs
L2 = 1.0


def _design(f, h):
    a = 2 * np.pi * h / 24
    return np.c_[np.ones_like(f), f, np.sin(a), np.cos(a), np.sin(2 * a), np.cos(2 * a)]


def _fit(X, y, wt=None, it=30):
    """Ridge logistic regression by Newton steps, each row weighted by wt (mean 1)."""
    wt = np.ones(len(y)) if wt is None else wt
    b = np.zeros(X.shape[1])
    R = L2 * np.eye(len(b))
    R[0, 0] = 1e-6
    for _ in range(it):
        p = 1 / (1 + np.exp(-np.clip(X @ b, -30, 30)))
        b += np.linalg.solve((X.T * (wt * p * (1 - p) + 1e-9)) @ X + R, X.T @ (wt * (y - p)) - R @ b)
    return b


def _rest(b):
    a = 2 * np.pi * np.arange(24) / 24
    return b[0] + b[2] * np.sin(a) + b[3] * np.cos(a) + b[4] * np.sin(2 * a) + b[5] * np.cos(2 * a)


def limit(b, pmin):
    """"limit" when the fit calls the unit off in every hour at the window's lowest price pmin,
    "any" when it calls it on in some hour there and so at every lower price too (a non-positive
    price slope), "never" when it calls it on at no price."""
    on_low = bool((_rest(b) + b[1] * np.arcsinh(pmin / SCALE) >= 0).any())
    if on_low:
        return "any"
    return "limit" if b[1] > 0 else "never"


def start_point(b, prices):
    """The day's highest price at the smallest shift that calls the unit on in some hour."""
    rest = _rest(b)
    thr = SCALE * np.sinh(np.clip(-rest / b[1], -20, 20))    # price at which each hour turns on
    return float(prices.max() + (thr - prices).min())


def node_prices(dates, units) -> dict:
    """{unit: [len(dates), 24] hourly real-time price at its resource node, NaN for a day without
    all 24} for the units with a node (unit_index.json.gz) and at least one such day.  Also read
    by events.py (run_price)."""
    ui = read_json_gz(DATA_DIR / "unit_index.json.gz", default={}) or {}
    ic = ui.get("columns") or []
    sp = {r[ic.index("unit")]: r[ic.index("sp")] for r in ui.get("rows", [])} if "sp" in ic else {}
    node = {}
    for i, d in enumerate(dates):
        pts = node_hourly(read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz", default=None))
        for u in units:
            v = pts.get(sp.get(u))
            if v and len(v) == 24 and None not in v:
                node.setdefault(u, np.full((len(dates), 24), np.nan))[i] = v
    return node


def build_peaker_rt(index=None) -> int:
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    dates = uh.get("dates") or []
    cts = [u["unit"] for u in tr.get("units", []) if u["tech"] == "combustion_turbine" and u["unit"] in uh.get("units", {})]
    if not dates or not cts:
        return 0
    N = len(dates)
    node = node_prices(dates, cts)
    hh = np.broadcast_to(np.arange(24), (N, 24))
    months = sorted({d[:7] for d in dates})
    rows_of = {m: [i for i, d in enumerate(dates) if d[:7] == m] for m in months}
    out, unexplained = {}, {}
    n_fit = 0
    for u in cts:
        if u not in node:
            continue
        P = node[u]
        have = ~np.isnan(P).any(1)
        F = np.arcsinh(np.nan_to_num(P) / SCALE)
        st = np.array(list(uh["units"][u][:N * 24].ljust(N * 24, "-"))).reshape(N, 24)
        on, av = np.isin(st, ["m", "a"]), np.isin(st, ["m", "a", "0"])

        for m in months:
            rows = rows_of[m]
            win = have.copy()
            win[rows[0]:] = False
            if win.sum() < MIN_FIT_DAYS:
                continue
            mk = av & win[:, None]
            y = on[mk]
            if mk.sum() < MIN_AVAIL or y.sum() < MIN_EACH or (~y).sum() < MIN_EACH:
                continue
            age = (rows[0] - np.broadcast_to(np.arange(N)[:, None], (N, 24)))[mk]
            wt = 0.5 ** (age / HALF_LIFE)
            b = _fit(_design(F[mk], hh[mk]), y.astype(float), wt / wt.mean())
            p = P[mk]
            kind, lo_on, hi_off, nd = limit(b, float(p.min())), float(p[y].min()), float(p[~y].max()), int(win.sum())
            if kind == "never" or (kind == "any" and y.mean() < ANY_SHARE):
                unexplained.setdefault(m, []).append([u, round(float(y.mean()), 3)])
                continue
            n_fit += 1
            for i in rows:
                if not have[i] or not av[i].any():
                    continue
                s = None if kind == "any" else round(float(np.clip(start_point(b, P[i]), min(lo_on, hi_off), max(lo_on, hi_off))), 2)
                out.setdefault(dates[i], []).append([u, s, round(float(P[i].max()), 2),
                                                     int(on[i].any()), int(on[i].sum()), int(av[i].sum()), nd])
    write_json_gz(PATH, {"model": NAME, "version": VERSION, "columns": list(COLUMNS), "half_life": HALF_LIFE,
                         "days": dict(sorted(out.items())), "unexplained": dict(sorted(unexplained.items()))})
    print(f"{NAME} {VERSION}: {n_fit} unit-month fits, {len(out)} days", flush=True)
    return len(out)


if __name__ == "__main__":
    build_peaker_rt()
