"""Operator-informed on/off model: each CC train's and gas steam unit's hourly on/off call judged
with what its operator knew, scored only on days whose 60-day disclosures are in (D + LAG).
Not a forecast: the forecast (thermal_cutoff, peaker_share) keeps to what is public by D - 1.
Proposal: "Operator-informed unit predictor" (Oct 2026).

Two hourly transitions, each a logistic with one intercept per unit, fitted on the 60-day hourly
states:
  from on   P(offline in hour h | online in h - 1)
  from off  P(online in hour h | offline in h - 1)
from what the operator had before hour h (FEATURES): the unit's own day-ahead node price against
its minimum-energy cost, the loss (or profit) of running from h through the rest of the cheap
(or dear) stretch, that loss against its own hot start cost, its DAM award at h, over the next
AHEAD hours and later in the day, the DAM profit of delivering its award from h on at gas cost (award MW x
(node price - HEAT_RATE x the day-before Houston Ship Channel gas price)) and that against its hot
start cost, its DAM resource status at h, whether the costs are its own
three-part offer, the hour, the season, how long it has been in its current state, and (from on)
the share of the last three hours it sat at minimum.  Nothing from hour h on is used.

Costs: the unit's own minimum-energy cost, LSL and hot start from its most recent three-part
offer within COST_DAYS days (pipeline.decisions), else the technology's generic costs.

Day mode (p_day): P(online) by hour for day D from the true state at HE24 of D - 1, chained
through the transitions over (state, hours in it), exactly.  The at-minimum share, unknown along
a chained path, is taken as the share of the last three hours whose award was at most
MIN_AWARD x LSL.  Step mode (p_step): the transition at each hour from the true state before
it, the probability of the decision the operator faced in that hour.

Fits are monthly and expanding: a month is judged by transitions fitted on the days before it
(at least FIT_MIN_DAYS), so no day is judged by a fit that saw it.

python -m pipeline.models.operator_informed BUNDLE [SIDE]   scores day mode against the
forecast in a backtest bundle's seed files (BUNDLE/seed/SIDE, default ref) on the days both have.
"""
import datetime as dt
import gzip
import json
import os
import sys
from collections import Counter, defaultdict

import numpy as np

from ..config import DATA_DIR, GENERIC_COSTS
from ..decisions import AWARD_LSL, COST_DAYS, _dam_trains
from ..forecast import context as C
from ..guide import EIA_HR
from ..store import read_json_gz

NAME = "operator_informed"
VERSION = "v1"
TECHS = ("combined_cycle", "gas_steam")
AHEAD = 6            # hours of award looked at ahead of h
MIN_AWARD = 1.1      # an award at most this x LSL counts as holding at minimum (day mode)
RUN_CAP = 48         # hours in the current state are counted up to this
FIT_MIN_DAYS = 60    # days of transitions a monthly fit needs
ON_STATUS = ("ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR")
FEATURES = ("margin", "loss ahead", "loss ahead against its start cost", "profit ahead",
            "best margin later", "award", "award ahead", "award later", "DAM status on",
            "own offer", "overnight", "hours in its state", "short run", "hours at minimum",
            "spring", "summer", "autumn", "award profit ahead", "award profit against its start cost")
DRIVERS = [("price against its cost", (0, 1, 3, 4)), ("loss against its start cost", (2,)),
           ("DAM award", (5, 6, 7, 17, 18)), ("DAM status", (8,)), ("time in its state", (11, 12)),
           ("sitting at minimum", (13,)), ("hour and season", (10, 14, 15, 16))]
HEAT_RATE = {"combined_cycle": EIA_HR["combined_cycle"], "gas_steam": 10.4}   # MMBtu/MWh; gas steam: EIA Electric Power Annual table 8.2, approximate
SEASON = {12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3}


def _on(c):
    return c in "ma"


# ------------------------------------------------------------------ data --
def _states(ctx):
    """{train: state array} on the stats' calendar, a CC train's single offline hour between
    online hours read as a configuration change (pipeline.decisions)."""
    cache = ctx.__dict__.setdefault("_oi_states", {})
    if not cache:
        for key, (t, st) in ctx.raw_states().items():
            if t not in TECHS:
                continue
            st = st.copy()
            if t == "combined_cycle":
                run = np.isin(st, ["m", "a"])
                gap = (~run[1:-1]) & run[:-2] & run[2:] & (st[1:-1] == "0")
                st[1:-1][gap] = "m"
            cache[key] = (t, st)
    return cache


def _status(dd):
    """{train: [24] 1.0 when any configuration's DAM resource status is on}."""
    from ..intraday import train_of
    out = {}
    for name, u in dd.get("units", {}).items():
        t = u.get("tech")
        if t not in TECHS:
            continue
        key = train_of(name) if t == "combined_cycle" else name
        sh = u.get("status_h") or [u.get("status") or ""] * 24
        on = np.array([float(str(s).upper() in ON_STATUS) for s in (list(sh) + [""] * 24)[:24]])
        out[key] = np.maximum(out.get(key, np.zeros(24)), on)
    return out


def _gas(ctx):
    """(dates, $/MMBtu) of the Houston Ship Channel daily gas price."""
    if "_oi_gas" not in ctx.__dict__:
        h = (read_json_gz(DATA_DIR / "gas_hubs.json.gz", default={}) or {}).get("hubs", {}).get("hsc") or {}
        ctx._oi_gas = (h.get("dates") or [], h.get("value") or [])
    return ctx._oi_gas


def _gas_before(ctx, d):
    """The latest gas price strictly before `d` (public when the DAM for d clears), or None."""
    import bisect
    gd, gv = _gas(ctx)
    i = bisect.bisect_left(gd, d) - 1
    return gv[i] if i >= 0 else None


def _days(ctx):
    """{date: {train: day record}} for every 60-day day with a DAM file: price, costs, award,
    status.  Costs carried forward as pipeline.decisions does."""
    cache = ctx.__dict__.setdefault("_oi_days", {})
    if cache:
        return cache
    carried = {}
    for i, d in enumerate(ctx.uh.get("dates", [])):
        dd = ctx.dam(d)
        if not dd:
            continue
        tr, stat = _dam_trains(dd), _status(dd)
        g = _gas_before(ctx, d)
        rec = {}
        for key, e in tr.items():
            if e["tech"] not in TECHS:
                continue
            if e["mingen"] is not None and e["lsl"]:
                carried[key] = (i, e["mingen"], e["lsl"], e["hot"])
            if e["spp"] is None or not e["lsl"]:
                continue
            c = carried.get(key)
            gc = GENERIC_COSTS[e["tech"]]
            if c and i - c[0] <= COST_DAYS:
                mingen, hot, own = c[1], c[3] or gc[0], 1.0
            else:
                mingen, hot, own = gc[3], gc[0], 0.0
            fuel = HEAT_RATE[e["tech"]] * g if g else mingen
            rec[key] = dict(tech=e["tech"], spp=np.nan_to_num(e["spp"], nan=mingen), lsl=e["lsl"],
                            mingen=mingen, hot=hot, own=own, aw=e["aw"] >= AWARD_LSL * e["lsl"], aw_mw=e["aw"], fuel=fuel,
                            awmin=e["aw"] <= MIN_AWARD * e["lsl"], status=stat.get(key, np.ones(24)))
        cache[d] = rec
    return cache


def _static(r, month):
    """[24, n] the features of each hour that do not depend on the path: all from the DAM."""
    spp, lsl, mg = r["spp"], r["lsl"], r["mingen"]
    m = spp - mg
    loss_h, gain_h = -m * lsl, m * lsl
    ahead_loss, ahead_gain = np.zeros(24), np.zeros(24)
    for h in range(24):
        ahead_loss[h] = max(0.0, np.cumsum(loss_h[h:]).max())
        ahead_gain[h] = max(0.0, np.cumsum(gain_h[h:]).max())
    later = np.array([m[h:].max() for h in range(24)])
    aw = r["aw"].astype(float)
    aw_ahead = np.array([aw[h:h + AHEAD].mean() for h in range(24)])
    aw_later = np.array([float(aw[h + 1:].any()) for h in range(24)])
    s = SEASON[month]
    X = np.zeros((24, len(FEATURES)))
    X[:, 0] = np.clip(m / 50.0, -4, 4)
    X[:, 1] = np.log1p(ahead_loss / 1000.0)
    X[:, 2] = np.clip(ahead_loss / r["hot"], 0, 5)
    X[:, 3] = np.log1p(ahead_gain / 1000.0)
    X[:, 4] = np.clip(later / 50.0, -4, 4)
    X[:, 5], X[:, 6], X[:, 7] = aw, aw_ahead, aw_later
    X[:, 8] = r["status"]
    X[:, 9] = r["own"]
    X[:, 10] = np.arange(24) < 6
    if s:
        X[:, 13 + s] = 1.0
    prof = np.cumsum((r["aw_mw"] * (spp - r["fuel"]))[::-1])[::-1]     # DAM profit of delivering the award from h on, at gas cost
    X[:, 17] = np.sign(prof) * np.log1p(np.abs(prof) / 1000.0)
    X[:, 18] = np.clip(prof / r["hot"], -5, 5)
    return X


def _path(X, run, atmin):
    """Fill in the path features: hours in the current state and the at-minimum share."""
    X = X.copy()
    X[..., 11] = np.minimum(run, RUN_CAP) / 24.0
    X[..., 12] = run < 4
    X[..., 13] = atmin
    return X


def _run_before(st, k):
    """Hours the unit had been in the state of hour k - 1 by the end of it."""
    s, n = _on(st[k - 1]), 0
    while k - 1 - n >= 0 and n < RUN_CAP and st[k - 1 - n] in "ma0" and _on(st[k - 1 - n]) == s:
        n += 1
    return n


# ------------------------------------------------------------------ fit --
def _rows(ctx, dates):
    """Transition rows over `dates`: {0: (X, unit, y) from off, 1: from on}."""
    cache = ctx.__dict__.setdefault("_oi_rows", {})
    out = {0: ([], [], []), 1: ([], [], [])}
    for d in dates:
        if d not in cache:
            cache[d] = _day_rows(ctx, d)
        for s in (0, 1):
            for a, b in zip(out[s], cache[d][s]):
                a.extend(b)
    return out


def _day_rows(ctx, d):
    states, days, day0 = _states(ctx), _days(ctx), ctx.stats["day0"]
    out = {0: ([], [], []), 1: ([], [], [])}
    dn = (C._d(d) - day0).days
    for key, r in days.get(d, {}).items():
        if key not in states:
            continue
        st = states[key][1]
        k0 = dn * 24
        if k0 < 1 or k0 + 24 > len(st):
            continue
        S = _static(r, int(d[5:7]))
        run = _run_before(st, k0)
        for h in range(24):
            k = k0 + h
            a, b = st[k - 1], st[k]
            if a in "o-" or b in "o-":
                run = 0
                continue
            if run == 0:
                run = _run_before(st, k)
            s = int(_on(a))
            atmin = float(np.mean([st[j] == "m" for j in range(k - 3, k)])) if s else 0.0
            x = _path(S[h], run, atmin)
            out[s][0].append(x)
            out[s][1].append(key)
            out[s][2].append(float(_on(b) != _on(a)))
            run = run + 1 if _on(b) == _on(a) else 1
    return out


def _fit_side(X, keys, y):
    from sklearn.linear_model import LogisticRegression
    X = np.asarray(X)
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1.0
    units = sorted(set(keys))
    ui = {k: i for i, k in enumerate(units)}
    Z = np.zeros((len(X), len(FEATURES) + len(units)))
    Z[:, :len(FEATURES)] = (X - mu) / sd
    Z[np.arange(len(X)), len(FEATURES) + np.array([ui[k] for k in keys])] = 1.0
    m = LogisticRegression(C=1.0, max_iter=3000).fit(Z, np.asarray(y))
    b = m.coef_[0]
    return dict(mu=mu, sd=sd, coef=b[:len(FEATURES)], unit={k: float(b[len(FEATURES) + i]) for k, i in ui.items()},
                b0=float(m.intercept_[0]))


def fit(ctx, month):
    """Transitions fitted on every 60-day day before `month` (YYYY-MM), cached; None when fewer
    than FIT_MIN_DAYS days."""
    cache = ctx.__dict__.setdefault("_oi_fit", {})
    if month not in cache:
        dates = [d for d in _days(ctx) if d < month + "-01"]
        if len(dates) < FIT_MIN_DAYS:
            cache[month] = None
        else:
            R = _rows(ctx, dates)
            cache[month] = {s: _fit_side(*R[s]) for s in (0, 1)} if all(len(set(R[s][2])) == 2 for s in (0, 1)) else None
    return cache[month]


def _p(f, key, X):
    z = ((X - f["mu"]) / f["sd"]) @ f["coef"] + f["unit"].get(key, 0.0) + f["b0"]
    return 1.0 / (1.0 + np.exp(-z))


# ------------------------------------------------------------- predict --
def p_day(ctx, date, key):
    """[24] P(online) by hour from the true state at HE24 of D - 1, or None."""
    r = _days(ctx).get(date, {}).get(key)
    f = fit(ctx, date[:7])
    states = _states(ctx)
    if r is None or f is None or key not in states:
        return None
    st, dn = states[key][1], (C._d(date) - ctx.stats["day0"]).days
    k0 = dn * 24
    if k0 < 1 or k0 > len(st) or st[k0 - 1] in "o-":
        return None
    S = _static(r, int(date[5:7]))
    awmin = r["awmin"].astype(float)
    runs = np.arange(1, RUN_CAP + 1)
    mass = np.zeros((2, RUN_CAP + 1))     # [state, hours in it]
    mass[int(_on(st[k0 - 1])), min(_run_before(st, k0), RUN_CAP)] = 1.0
    out = np.zeros(24)
    for h in range(24):
        atmin = awmin[max(0, h - 3):h].mean() if h else 1.0
        new = np.zeros_like(mass)
        for s in (0, 1):
            m = mass[s, 1:]
            if m.sum() <= 0:
                continue
            q = _p(f[s], key, _path(np.repeat(S[h][None], RUN_CAP, 0), runs, atmin if s else 0.0))
            new[1 - s, 1] += (m * q).sum()
            stay = m * (1 - q)
            new[s, 2:] += stay[:-1]
            new[s, RUN_CAP] += stay[-1]
        mass = new
        out[h] = mass[1].sum()
    return out


def p_step(ctx, date, key):
    """[24] P(online in h) from the true state in h - 1 (NaN for an hour after an outage or a gap)."""
    r = _days(ctx).get(date, {}).get(key)
    f = fit(ctx, date[:7])
    states = _states(ctx)
    if r is None or f is None or key not in states:
        return None
    st, k0 = states[key][1], (C._d(date) - ctx.stats["day0"]).days * 24
    S = _static(r, int(date[5:7]))
    out = np.full(24, np.nan)
    for h in range(24):
        k = k0 + h
        if k < 4 or st[k - 1] in "o-":
            continue
        s = int(_on(st[k - 1]))
        atmin = float(np.mean([st[j] == "m" for j in range(k - 3, k)])) if s else 0.0
        q = float(_p(f[s], key, _path(S[h], _run_before(st, k), atmin)))
        out[h] = 1 - q if s else q
    return out


def drivers(ctx, date, key, h):
    """[(driver, signed push toward going off)] at hour h from the true state before it, largest first."""
    f = fit(ctx, date[:7])
    r = _days(ctx).get(date, {}).get(key)
    states = _states(ctx)
    if f is None or r is None or key not in states:
        return []
    st, k = states[key][1], (C._d(date) - ctx.stats["day0"]).days * 24 + h
    s = int(_on(st[k - 1]))
    atmin = float(np.mean([st[j] == "m" for j in range(k - 3, k)])) if s else 0.0
    x = _path(_static(r, int(date[5:7]))[h], _run_before(st, k), atmin)
    c = (x - f[s]["mu"]) / f[s]["sd"] * f[s]["coef"] * (1 if s else -1)
    out = [(name, round(float(c[list(ix)].sum()), 2)) for name, ix in DRIVERS]
    return sorted(out, key=lambda t: -abs(t[1]))


# --------------------------------------------------------------- score --
def _cls(on):
    return "on" if on.all() else ("off" if not on.any() else "cycle")


def score(bundle, side="ref"):
    """Day mode against the forecast on the CC and gas steam unit-days both have, outage hours
    left out (as analysis/decision-score.py)."""
    from ..forecast.score import _states as day_states
    from ..intraday import train_of
    from ..store import load_index
    ctx = C.Context(load_index())
    hour = {w: defaultdict(Counter) for w in ("forecast", "operator")}
    day = {w: defaultdict(Counter) for w in ("forecast", "operator")}
    cheap_c = {w: defaultdict(Counter) for w in ("forecast", "operator")}
    brier = {w: defaultdict(list) for w in ("forecast", "operator")}
    run = []    # cheap-stretch run-through, CC trains: (start on, awarded, ran, p forecast, p operator)
    files = sorted(f for f in os.listdir(f"{bundle}/seed/{side}") if f.endswith(".json.gz"))
    for fn in files:
        d = json.load(gzip.open(f"{bundle}/seed/{side}/{fn}"))
        date = d["date"]
        if d["inputs"].get("hindsight"):
            continue
        uf = f"site/data/60d-units/{date}.json.gz"
        st = day_states(ctx, date)
        if not os.path.exists(uf) or not st:
            continue
        u = json.load(gzip.open(uf))
        cols = {c: i + 2 for i, c in enumerate(u["columns"])}
        act, tech = defaultdict(lambda: np.zeros(24, bool)), {}
        for row in u["rows"]:
            name, t = u["units"][row[0]][0], u["units"][row[0]][2]
            if t not in TECHS:
                continue
            k = train_of(name) if t == "combined_cycle" else name
            tech[k] = t
            if (row[cols["online_share"]] or 0) >= 0.5:
                act[k][row[1] - 1] = True
        hub = np.nan_to_num(np.array(d["headline"]["hub"], float), nan=99)
        cheap = hub <= 10
        uh = d["unit_hours"]
        ip = uh["series"].index("p")
        days = _days(ctx).get(date, {})
        for k, s in uh["units"].items():
            t = tech.get(k)
            if t is None:
                continue
            po = p_day(ctx, date, k)
            if po is None:
                continue
            pf = np.nan_to_num(np.array(s[ip], float))
            if pf.shape != (24,):
                pf = np.full(24, float(pf.mean()) if pf.size else 0.0)
            a = act[k]
            ok = np.asarray(st.get(k, ["-"] * 24)) != "o"
            for w, p in (("forecast", pf), ("operator", po)):
                fc = p >= 0.5
                for h in np.where(ok)[0]:
                    hour[w][t][(bool(a[h]), bool(fc[h]))] += 1
                    brier[w][t].append((p[h] - a[h]) ** 2)
                if ok.all():
                    day[w][t][(_cls(a), _cls(fc))] += 1
                    if cheap.any():
                        cheap_c[w][t][(bool((~a & cheap).any()), bool((~fc & cheap).any()))] += 1
            if t == "combined_cycle" and ok.all() and cheap.sum() >= 2 and k in days:
                ix = np.where(cheap)[0]
                a0, a1 = ix[0], ix[-1] + 1
                sts = _states(ctx)[k][1]
                k0 = (C._d(date) - ctx.stats["day0"]).days * 24
                run.append((float(_on(sts[k0 - 1])), float(days[k]["aw"][a0:a1].mean() >= 0.5),
                            float(a[a0:a1].mean() >= 0.5), float(pf[a0:a1].mean()), float(po[a0:a1].mean())))

    def pr(c, pos):
        tp = c[(pos, pos)]
        fp = sum(v for (x, y), v in c.items() if y == pos and x != pos)
        fn = sum(v for (x, y), v in c.items() if x == pos and y != pos)
        return tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    print(f"operator_informed {VERSION} against the forecast ({bundle} {side})")
    for t in TECHS:
        print(f"\n{t}")
        for w in ("forecast", "operator"):
            c = hour[w][t]
            n = sum(c.values())
            if not n:
                continue
            acc = (c[(True, True)] + c[(False, False)]) / n
            op, orc = pr(c, False)
            cp, cr = pr(cheap_c[w][t], True)
            print(f"  {w:9s} hours {n:6d}  acc {acc:.3f}  Brier {np.mean(brier[w][t]):.4f}  off prec/recall {op:.2f}/{orc:.2f}"
                  f"  cheap-hour shutdowns prec/recall {cp:.2f}/{cr:.2f} ({cheap_c[w][t][(True, True)]} caught)")
            print("            day class", {f"{x}->{y}": v for (x, y), v in sorted(day[w][t].items())})
    if run:
        R = np.array(run)
        y = R[:, 2]
        print(f"\nCC cheap-stretch run-through, {len(R)} train-days (ran through {y.mean():.2f})")
        for name, col in (("forecast", 3), ("operator", 4)):
            p = R[:, col]
            print(f"  {name:9s} Brier {np.mean((p - y) ** 2):.4f}  accuracy {np.mean((p >= .5) == (y == 1)):.3f}")
        for s0 in (0, 1):
            for aw in (0, 1):
                m = (R[:, 0] == s0) & (R[:, 1] == aw)
                if m.sum():
                    print(f"  on at start {s0} awarded {aw}: n {m.sum():5d} ran {y[m].mean():.3f}  accuracy forecast "
                          f"{np.mean((R[m, 3] >= .5) == (y[m] == 1)):.3f} operator {np.mean((R[m, 4] >= .5) == (y[m] == 1)):.3f}")


if __name__ == "__main__":
    score(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "ref")
