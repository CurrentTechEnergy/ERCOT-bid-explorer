"""Peakers on real-time prices: a fit of each combustion turbine's hours online against the
real-time price at its own node, for the Commitment page's per-unit start chart.  A fit of past decisions,
not a forecast: the real-time price is not known when a peaker decides, and peakers starting
move it.  The forecast keeps peaker_share (day-ahead hub price bands).

The fit, per unit and month: a logistic regression of online (SCED "m"/"a") on the hour's
real-time settlement point price at the unit's resource node (the mean of its four 15-minute
prices, UNIT_DATA_DIR/nodes; the node from unit_index.json.gz), through
asinh(price / SCALE) so a $5 move counts for more near $20 than near $500) and the hour of day
(two harmonics), over its available hours (outage hours left out) in the FIT_DAYS days before the
month.  Ridge L2 on everything but the intercept.  A unit needs MIN_AVAIL available hours and
MIN_EACH hours both online and offline in the window; else no row.

What the window proves: a fit has a price limit when, at the lowest price in its window, it calls
the unit off in every hour.  When the FIT_DAYS fit has none (PB2SES_CT5 ran round the clock in
April 2026, at -$30 too, so its July fit on April to June put the start at -$2.4 billion), the
unit is fitted again on every day before the month (real-time node prices start Dec 2025).  Still
none: it runs at any price it has seen, start null.  A fit that never calls it on at any price in
its window has no row.  With a limit, the start is held between the lowest price at which the unit
was online in the window and the highest at which it sat off: the fit knows nothing past them.
Oct 2026 against v1, Feb-Aug 2026: 80% of unit-days right either way; the 22 unit-months whose start
ran off the scale (v1) refit on the longer window or run at any price (30 unit-months in all).

The start point: every hour's real-time price shifted by the same $/MWh until the fit calls the
unit on (chance 0.5 or more) in some hour, found exactly from the fit (each hour's threshold price
less its price, the smallest of them), and reported as the day's highest hourly price at that
shift, so it reads against the circle at the day's actual highest price.  A diamond left of the
circle: the fit says it ran.

Backtest Mar-Aug 2026, 245 CTs, each month fitted on the three before, hours right / starts caught /
on-calls right: real-time node 91.1% / 39% / 90.8%; real-time hub 90.7% / 37% / 89.6%; day-ahead
hub price bands (the forecast's peaker_share inputs) 90.1% / 32% / 89.0%; every hour off 70.4%.

Writes data/peaker/rt_fit.json.gz:
  {"model", "version", "columns": [...], "fit_days", "days": {date: [[unit, start, peak, ran,
   hours_on, hours_avail, window], ...]}}
start and peak in $/MWh (real-time at the unit's node, highest hour of the day), start null when
it runs at any price; ran 1 when online in any hour; window the days the fit used (FIT_DAYS, or
more when it was fitted again on every day before the month).
Units on outage all day, and days without the node's 24 prices, are left out.  Rebuilt in full each run (a few seconds).
"""

import numpy as np

from ..config import DATA_DIR, UNIT_DATA_DIR
from ..parse_prices import node_hourly
from ..store import read_json_gz, write_json_gz

NAME = "peaker_rt"
VERSION = "v2"   # v2: the fit window proves a price limit, else the longer window, else any price
PATH = DATA_DIR / "peaker" / "rt_fit.json.gz"
COLUMNS = ("unit", "start", "peak", "ran", "hours_on", "hours_avail", "window")
SCALE = 10.0         # $/MWh in asinh(price / SCALE)
FIT_DAYS = 90        # days before the month the fit uses ...
MIN_FIT_DAYS = 45    # ... and the fewest with prices it may use
MIN_AVAIL = 200      # available hours a unit's fit needs
MIN_EACH = 10        # hours online and offline it needs
L2 = 1.0


def _design(f, h):
    a = 2 * np.pi * h / 24
    return np.c_[np.ones_like(f), f, np.sin(a), np.cos(a), np.sin(2 * a), np.cos(2 * a)]


def _fit(X, y, it=30):
    b = np.zeros(X.shape[1])
    R = L2 * np.eye(len(b))
    R[0, 0] = 1e-6
    for _ in range(it):
        p = 1 / (1 + np.exp(-np.clip(X @ b, -30, 30)))
        b += np.linalg.solve((X.T * (p * (1 - p) + 1e-9)) @ X + R, X.T @ (y - p) - R @ b)
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
    out = {}
    n_fit = 0
    for u in cts:
        if u not in node:
            continue
        P = node[u]
        have = ~np.isnan(P).any(1)
        F = np.arcsinh(np.nan_to_num(P) / SCALE)
        st = np.array(list(uh["units"][u][:N * 24].ljust(N * 24, "-"))).reshape(N, 24)
        on, av = np.isin(st, ["m", "a"]), np.isin(st, ["m", "a", "0"])

        def fit_window(win):
            """(b, limit kind, lowest price online, highest price off, days) over the days in win, or None."""
            if win.sum() < MIN_FIT_DAYS:
                return None
            mk = av & win[:, None]
            y = on[mk]
            if mk.sum() < MIN_AVAIL or y.sum() < MIN_EACH or (~y).sum() < MIN_EACH:
                return None
            b = _fit(_design(F[mk], hh[mk]), y.astype(float))
            p = P[mk]
            return b, limit(b, float(p.min())), float(p[y].min()), float(p[~y].max()), int(win.sum())
        for m in months:
            rows = rows_of[m]
            win = np.zeros(N, bool)
            win[max(0, rows[0] - FIT_DAYS):rows[0]] = True
            win &= have
            fit = fit_window(win)
            if fit is not None and fit[1] == "any":
                longer = have.copy()
                longer[rows[0]:] = False
                fit = (fit_window(longer) or fit) if longer.sum() > win.sum() else fit
            if fit is None or fit[1] == "never":
                continue
            b, kind, lo_on, hi_off, nd = fit
            n_fit += 1
            for i in rows:
                if not have[i] or not av[i].any():
                    continue
                s = None if kind == "any" else round(float(np.clip(start_point(b, P[i]), min(lo_on, hi_off), max(lo_on, hi_off))), 2)
                out.setdefault(dates[i], []).append([u, s, round(float(P[i].max()), 2),
                                                     int(on[i].any()), int(on[i].sum()), int(av[i].sum()), nd])
    write_json_gz(PATH, {"model": NAME, "version": VERSION, "columns": list(COLUMNS), "fit_days": FIT_DAYS,
                         "days": dict(sorted(out.items()))})
    print(f"{NAME} {VERSION}: {n_fit} unit-month fits, {len(out)} days", flush=True)
    return len(out)


if __name__ == "__main__":
    build_peaker_rt()
