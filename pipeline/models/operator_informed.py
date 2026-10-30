"""Operator-informed on/off model: each CC train's and gas steam unit's hourly on/off call judged
with what its operator knew, scored only on days whose 60-day disclosures are in (D + LAG).
Not a forecast.
Proposal: "Operator-informed unit predictor" (Oct 2026).

Two hourly transitions, each a logistic with one intercept per unit, fitted on the 60-day hourly
states:
  from on   P(offline in hour h | online in h - 1)
  from off  P(online in hour h | offline in h - 1)
from what the operator had before hour h (FEATURES): the unit's own day-ahead node price against
its minimum-energy cost and against its gas cost (HEAT_RATE x the day-before gas price), the
loss (or profit) of running from h through the rest of the cheap (or dear) stretch at either cost, that loss against its own hot start cost, its DAM award at h, over the next
AHEAD hours and later in the day, the DAM profit of delivering its award from h on at gas cost (award MW x
(node price - HEAT_RATE x the day-before gas price at the unit's own hub, Waha or Houston Ship Channel,
from fuel_hubs.json.gz as pipeline/gascost.py reads it)) and that against its hot
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

Each transition also has, on SLOPES (margin, loss ahead, profit ahead, award ahead), one slope
per unit on top of the fleet's, pulled toward the fleet's by a penalty 1 / SLOPE_SCALE**2 times
the rest: some units shrug off a loss others shut on (Oct 2026: CC Brier 0.0273 -> 0.0266, gas
steam 0.1263 -> 0.1230, at SLOPE_SCALE 0.5; 1.0 did slightly worse).

The COP (pipeline/cop.py) is the operator's own written plan, so it is close to the answer it
is meant to explain, and it is left out of the main call (plan "none").  With cop=True the
model also takes the unit's COP plan: as of 14:00 D - 1 in day mode (plan "da", which a day-mode
fit must also use) and as of an hour before each hour in step mode (plan "live").  Oct 2026, Jan
to Aug: all of its gain is in unawarded hours, two thirds of it in self-commit runs, and little
in cheap hours (CC 675 -> 566 wrong cheap hours, gas steam 78 -> 71).  cop_plan gives the plan
to show beside the call.

Hours ERCOT had a unit committed by RUC (unit_hours_60d "ruc", pipeline/intraday.py) are not the
operator's decision: a transition into, out of or within one is left out of the fits (Oct 2026,
Feb to Aug: cheap turn-offs caught 318 -> 322 of 443, false 101 -> 95; all hours 4.23% -> 4.25%
wrong), and the scorecard leaves them out too.  The history days (before Dec 2025) have no unit
status, so nothing is left out there.

Fits are monthly and expanding: a month is judged by transitions fitted on the days before it
(at least FIT_MIN_DAYS), so no day is judged by a fit that saw it.

Days before the 60-day fits (Jan 2019 to Jan 2026) are judged from the thermal history files
(operator_history.py) by reduced fits: each month on the HISTORY_WINDOW months before it, with the
DAM resource status from the history's dam-status files (Apr 2019 to Nov 2025, every 5th day: CC
hours right 96.35% -> 96.75%, turn-offs caught 2,759 -> 2,985 of 5,081 with 1,398 -> 1,331 false;
gas steam 95.05% -> 95.43%).  Their day files carry "reduced": true and the
hourly "state" (no 60-day unit file shows what they did), and the index lists them apart as
history_days.

Writes data/operator/<date>.json.gz for the Unit page (build_days, run by the daily update):
  date, model, version
  units   {train: {"tech", "start" (on, off or out at HE24 of D - 1), "p" [24] P(online), the main
          call, "p_cop" [24] the same with the COP, "plan" [24] COP plan on (1), off (0) or null
          where none, "award" [24] 1 where awarded at least AWARD_LSL x LSL, "why_h" the hour the
          reasons are for, "why_from" its state the hour before, "why" [[driver, push toward
          off in log-odds], ...] top three}}
and data/operator/index.json.gz {"model", "version", "days"}, data/operator/decisions.json.gz
(build_decision_view) for the decision history chart, and data/operator/scores.json.gz, the
scorecard against the baselines (pipeline/models/operator_scores.py), and data/operator/cutoffs.json.gz,
each unit's turn-off point for the Commitment cutoff curve (pipeline/models/operator_cutoffs.py).  Every day is rewritten when
VERSION changes; otherwise only new days.  The reasons are for the hour of the unit's first
actual switch that day, else the first hour the call switches, else its cheapest hour, from
the true state before it (drivers).

python -m pipeline.models.operator_informed [--all]   writes the day files.
"""
import os
import sys

import numpy as np

from .. import gascost, private
from ..config import DATA_DIR, GENERIC_COSTS
from ..cop import COP_DIR
from ..decisions import AWARD_LSL, COST_DAYS, _dam_trains
from ..forecast import context as C
from ..guide import EIA_HR
from ..store import read_json_gz, write_json_gz

NAME = "operator_informed"
VERSION = "v5"   # v5: v4 again, with Graham really at Ship Channel (the v4 run read the hubs from before fuel_hub.REFIT); v4: Graham at Houston Ship Channel (fuel_hub.REFIT), and RUC left out of the scores as well as the fits; v3: gas at each unit's own hub (Waha or Houston Ship Channel), not Houston Ship Channel for all; v1: transitions with per-unit intercepts and slopes; v2: the COP only beside the main call, margins at gas cost
TECHS = ("combined_cycle", "gas_steam")
AHEAD = 6            # hours of award looked at ahead of h
MIN_AWARD = 1.1      # an award at most this x LSL counts as holding at minimum (day mode)
RUN_CAP = 48         # hours in the current state are counted up to this
FIT_MIN_DAYS = 60    # days of transitions a monthly fit needs
HISTORY_WINDOW = 12  # months of history days a reduced fit (before the 60-day fits) is fitted on
LIVE_VERSION = "s2"   # 60-day day files only (s2: a thermal unit online with no output and no HSL is offline, intraday.empty_hour)
HISTORY_VERSION = "h2"   # history day files only (h2: with the DAM resource status); a change rewrites them, newest first
HISTORY_BUDGET = 75 * 60   # seconds a run may spend writing history day files
SAVE_EVERY = 30      # history day files between index writes
REDUCED_NOTE = ("days before the 60-day fits: fitted on the 12 months before, from the thermal history files "
                "and the DAM resource status; gas at Henry Hub where no Ship Channel price is stored")
SLOPES = (0, 1, 3, 6)   # features with a slope per unit: margin, loss ahead, profit ahead, award ahead
SLOPE_SCALE = float(os.environ.get("OI_SLOPE_SCALE", "0.5"))   # 0 turns the per-unit slopes off
ON_STATUS = ("ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR")
FEATURES = ("margin", "loss ahead", "loss ahead against its start cost", "profit ahead",
            "best margin later", "award", "award ahead", "award later", "DAM status on",
            "own offer", "overnight", "hours in its state", "short run", "hours at minimum",
            "spring", "summer", "autumn", "award profit ahead", "award profit against its start cost",
            "COP plan on", "COP plan on ahead", "COP plan known",
            "margin at gas cost", "loss ahead at gas cost", "profit ahead at gas cost")
DRIVERS = [("price against its cost", (0, 1, 3, 4, 22, 23, 24)), ("loss against its start cost", (2,)),
           ("DAM award", (5, 6, 7, 17, 18)), ("DAM status", (8,)), ("time in its state", (11, 12)),
           ("sitting at minimum", (13,)), ("hour and season", (10, 14, 15, 16)),
           ("its own COP plan", (19, 20, 21))]
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


def ruc_hours(ctx):
    """{train: set of hour indices on the stats' calendar} in RUC (unit_hours_60d "ruc"),
    configurations merged into their train; empty where the file has none (history days).  A
    HistoryContext (operator_history.py) takes its live context's, on its own calendar, so the
    scores, which run on it, leave RUC out too (before v4 they did not: ruc_hours was 0 throughout)."""
    from ..intraday import train_of
    cache = ctx.__dict__.setdefault("_oi_ruc", {})
    ruc = getattr(ctx, "live", ctx).uh.get("ruc")     # a HistoryContext's own uh has none: take its live context's
    if not cache and ruc:
        day0 = ctx.stats["day0"]
        for name, days in ruc.items():
            key = train_of(name)
            for d, hes in days:
                k0 = (C._d(d) - day0).days * 24
                cache.setdefault(key, set()).update(k0 + he - 1 for he in hes)
    return cache


def _gas(ctx):
    """{hub: (dates, $/MMBtu)} of the daily gas price at each hub ("hsc", "waha")."""
    if "_oi_gas" not in ctx.__dict__:
        h = (private.read("gas_hubs.json.gz", default={}) or {}).get("hubs", {})
        ctx._oi_gas = {k: (v.get("dates") or [], v.get("value") or []) for k, v in h.items()}
    return ctx._oi_gas


def _gas_before(ctx, d, key):
    """The latest gas price strictly before `d` (public when the DAM for d clears) at the unit's
    own hub (gascost: fuel_hubs.json.gz, Houston Ship Channel without one), or None."""
    import bisect
    gd, gv = _gas(ctx).get(gascost.hub_of(key), ([], []))
    i = bisect.bisect_left(gd, d) - 1
    while i >= 0 and gv[i] is None:
        i -= 1
    return gv[i] if i >= 0 else None


def _cop(ctx, d, dd):
    """{train: (da [24], live [24], known [24])} plan on (1.0) or off from the COP (pipeline/cop.py):
    as of 14:00 D - 1, and for each hour as of an hour before it; known 0 where no plan."""
    from ..intraday import train_of
    day = (read_json_gz(COP_DIR / f"{d}.json.gz", default=None) or {}).get("units", {})
    tech = {n: u.get("tech") for n, u in dd.get("units", {}).items()}
    out = {}
    for name, v in day.items():
        t = tech.get(name)
        if t not in TECHS:
            continue
        key = train_of(name) if t == "combined_cycle" else name
        da, live, known = out.setdefault(key, (np.zeros(24), np.zeros(24), np.zeros(24)))
        for h in range(24):
            a, b = v["da"][h], v["live"][h]
            da[h] = max(da[h], float(a.startswith("ON")))
            live[h] = max(live[h], float((b or a).startswith("ON")))
            known[h] = max(known[h], float(bool(a)))
    return out


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
        tr, stat, cop = _dam_trains(dd), _status(dd), _cop(ctx, d, dd)
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
            g = _gas_before(ctx, d, key)
            fuel = HEAT_RATE[e["tech"]] * g if g else mingen
            rec[key] = dict(tech=e["tech"], spp=np.nan_to_num(e["spp"], nan=mingen), lsl=e["lsl"],
                            mingen=mingen, hot=hot, own=own, aw=e["aw"] >= AWARD_LSL * e["lsl"], aw_mw=e["aw"], fuel=fuel,
                            awmin=e["aw"] <= MIN_AWARD * e["lsl"], status=stat.get(key, np.ones(24)),
                            cop=cop.get(key, (np.full(24, 0.5), np.full(24, 0.5), np.zeros(24))))
        cache[d] = rec
    return cache


def _static(r, month, plan="none"):
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
    g = spp - r["fuel"]
    gl, gg = np.zeros(24), np.zeros(24)
    for h in range(24):
        gl[h] = max(0.0, np.cumsum(-g[h:] * lsl).max())
        gg[h] = max(0.0, np.cumsum(g[h:] * lsl).max())
    X[:, 22] = np.clip(g / 50.0, -4, 4)
    X[:, 23] = np.log1p(gl / 1000.0)
    X[:, 24] = np.log1p(gg / 1000.0)
    if plan != "none":
        da, lv, known = r["cop"]
        X[:, 19] = lv if plan == "live" else da
        X[:, 20] = np.array([da[h:h + AHEAD].mean() for h in range(24)])
        X[:, 21] = known
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
def _rows(ctx, dates, plan="none"):
    """Transition rows over `dates`: {0: (X, unit, y) from off, 1: from on}."""
    cache = ctx.__dict__.setdefault("_oi_rows", {}).setdefault(plan, {})
    out = {0: ([], [], []), 1: ([], [], [])}
    for d in dates:
        if d not in cache:
            cache[d] = _day_rows(ctx, d, plan)
        for s in (0, 1):
            for a, b in zip(out[s], cache[d][s]):
                a.extend(b)
    return out


def _day_rows(ctx, d, plan="none"):
    states, days, day0, ruc = _states(ctx), _days(ctx), ctx.stats["day0"], ruc_hours(ctx)
    out = {0: ([], [], []), 1: ([], [], [])}
    dn = (C._d(d) - day0).days
    for key, r in days.get(d, {}).items():
        if key not in states:
            continue
        st, rk = states[key][1], ruc.get(key, ())
        k0 = dn * 24
        if k0 < 1 or k0 + 24 > len(st):
            continue
        S = _static(r, int(d[5:7]), plan)
        run = _run_before(st, k0)
        for h in range(24):
            k = k0 + h
            a, b = st[k - 1], st[k]
            if a in "o-" or b in "o-" or k in rk or k - 1 in rk:
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
    """Fleet slopes, one intercept per unit and, on SLOPES, one slope per unit on top of the
    fleet's; those columns are scaled by SLOPE_SCALE, so the common L2 penalty pulls a unit's own
    slope toward the fleet's harder than the rest (by 1 / SLOPE_SCALE**2)."""
    from sklearn.linear_model import LogisticRegression
    X = np.asarray(X)
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1.0
    units = sorted(set(keys))
    ui = {k: i for i, k in enumerate(units)}
    nf, nu, ns = len(FEATURES), len(units), len(SLOPES) if SLOPE_SCALE else 0
    rows, ix = np.arange(len(X)), np.array([ui[k] for k in keys])
    Z = np.zeros((len(X), nf + nu + nu * ns), dtype=np.float32)
    Xs = (X - mu) / sd
    Z[:, :nf] = Xs
    Z[rows, nf + ix] = 1.0
    for j, c in enumerate(SLOPES[:ns]):
        Z[rows, nf + nu + ix * ns + j] = Xs[:, c] * SLOPE_SCALE
    m = LogisticRegression(C=1.0, max_iter=3000).fit(Z, np.asarray(y))
    b = m.coef_[0]
    slope = {k: b[nf + nu + i * ns:nf + nu + (i + 1) * ns] * SLOPE_SCALE for k, i in ui.items()} if ns else {}
    return dict(mu=mu, sd=sd, coef=b[:nf], unit={k: float(b[nf + i]) for k, i in ui.items()},
                b0=float(m.intercept_[0]), slope=slope)


def fit(ctx, month, plan="none"):
    """Transitions fitted on every 60-day day before `month` (YYYY-MM) with the COP `plan` ("none",
    "da" or "live"), cached; None when fewer than FIT_MIN_DAYS days."""
    live = getattr(ctx, "live", None)      # a HistoryContext (operator_history.py)
    if live is not None:
        f = fit(live, month, plan)
        if f is not None or plan != "none":
            return f
        return _reduced_fit(ctx, month)
    cache = ctx.__dict__.setdefault("_oi_fit", {}).setdefault(plan, {})
    if month not in cache:
        dates = [d for d in _days(ctx) if d < month + "-01"]
        if len(dates) < FIT_MIN_DAYS:
            cache[month] = None
        else:
            R = _rows(ctx, dates, plan)
            cache[month] = {s: _fit_side(*R[s]) for s in (0, 1)} if all(len(set(R[s][2])) == 2 for s in (0, 1)) else None
    return cache[month]


def _reduced_fit(ctx, month):
    """A month before the 60-day fits: transitions fitted on the HISTORY_WINDOW months of
    history days before it, with the DAM status when the history has it, or None."""
    cache = ctx.__dict__.setdefault("_oi_rfit", {})
    if month not in cache:
        y, m = int(month[:4]), int(month[5:7]) - HISTORY_WINDOW
        lo = f"{y + (m - 1) // 12:04d}-{(m - 1) % 12 + 1:02d}-01"
        dates = [d for d in _days(ctx) if lo <= d < month + "-01"]
        if len(dates) < FIT_MIN_DAYS:
            cache[month] = None
        else:
            R = _rows(ctx, dates)
            ok = all(len(set(R[s][2])) == 2 for s in (0, 1))
            # the DAM status where the history has it (operator_history.py); OI_HISTORY_STATUS=0 leaves it out
            keep = getattr(ctx, "has_status", False) and os.environ.get("OI_HISTORY_STATUS", "1") != "0"
            cache[month] = {s: _fit_side(R[s][0] if keep else _no_status(R[s][0]), *R[s][1:]) for s in (0, 1)} if ok else None
    return cache[month]


def _no_status(X):
    X = np.array(X)
    X[:, 8] = 0.0      # constant, so its slope fits to 0 and a day's real status changes nothing
    return X


def _p(f, key, X):
    Xs = (X - f["mu"]) / f["sd"]
    z = Xs @ f["coef"] + f["unit"].get(key, 0.0) + f["b0"]
    sl = f.get("slope", {}).get(key)
    if sl is not None:
        z = z + Xs[..., list(SLOPES)] @ sl
    return 1.0 / (1.0 + np.exp(-z))


# ------------------------------------------------------------- predict --
def p_day(ctx, date, key, cop=False):
    """[24] P(online) by hour from the true state at HE24 of D - 1, or None."""
    plan = "da" if cop else "none"
    r = _days(ctx).get(date, {}).get(key)
    f = fit(ctx, date[:7], plan)
    states = _states(ctx)
    if r is None or f is None or key not in states:
        return None
    return _p_day(ctx, date, key, r, f, plan)


def _p_day(ctx, date, key, r, f, plan="none"):
    """p_day for the day record r (pipeline.models.operator_cutoffs passes one with its prices
    shifted) and the fit f."""
    st, dn = _states(ctx)[key][1], (C._d(date) - ctx.stats["day0"]).days
    k0 = dn * 24
    if k0 < 1 or k0 > len(st) or st[k0 - 1] in "o-":
        return None
    S = _static(r, int(date[5:7]), plan)
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


def p_step(ctx, date, key, cop=False):
    """[24] P(online in h) from the true state in h - 1 (NaN for an hour after an outage or a gap)."""
    plan = "live" if cop else "none"
    r = _days(ctx).get(date, {}).get(key)
    f = fit(ctx, date[:7], plan)
    states = _states(ctx)
    if r is None or f is None or key not in states:
        return None
    st, k0 = states[key][1], (C._d(date) - ctx.stats["day0"]).days * 24
    S = _static(r, int(date[5:7]), plan)
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


def drivers(ctx, date, key, h, cop=False):
    """[(driver, signed push toward going off, in log-odds)] at hour h from the true state before
    it, largest first; "its own habit" is the unit's intercept and slopes against the fleet's."""
    plan = "live" if cop else "none"
    f = fit(ctx, date[:7], plan)
    r = _days(ctx).get(date, {}).get(key)
    states = _states(ctx)
    if f is None or r is None or key not in states:
        return []
    st, k = states[key][1], (C._d(date) - ctx.stats["day0"]).days * 24 + h
    s = int(_on(st[k - 1]))
    atmin = float(np.mean([st[j] == "m" for j in range(k - 3, k)])) if s else 0.0
    x = _path(_static(r, int(date[5:7]), plan)[h], _run_before(st, k), atmin)
    fs, sign = f[s], (1 if s else -1)
    xs = (x - fs["mu"]) / fs["sd"]
    c = xs * fs["coef"] * sign
    out = [(name, round(float(c[list(ix)].sum()), 2)) for name, ix in DRIVERS if cop or 19 not in ix]
    # the unit's own intercept against the fleet's average one, and its own slopes on SLOPES
    sl = fs.get("slope", {}).get(key)
    own = fs["unit"].get(key, 0.0) - float(np.mean(list(fs["unit"].values()))) + (float(xs[list(SLOPES)] @ sl) if sl is not None else 0.0)
    out.append(("its own habit", round(own * sign, 2)))
    return sorted(out, key=lambda t: -abs(t[1]))


def cop_plan(ctx, date, key):
    """([24] planned on as of 14:00 D - 1, [24] whether there was a plan), or None."""
    r = _days(ctx).get(date, {}).get(key)
    if r is None:
        return None
    da, _, known = r["cop"]
    return da, known


# ---------------------------------------------------------------- days --
OUT_DIR = DATA_DIR / "operator"
START = {"m": "on", "a": "on", "0": "off", "o": "out"}


def _r(a, n=3):
    return [None if v is None or not np.isfinite(v) else round(float(v), n) for v in a]


def day_units(ctx, date):
    """{train: Unit page record} for one 60-day day (the format in the module docstring)."""
    states, day0, out = _states(ctx), ctx.stats["day0"], {}
    for key, r in _days(ctx).get(date, {}).items():
        p = p_day(ctx, date, key)
        if p is None:
            continue
        pc = p_day(ctx, date, key, cop=True)
        st, k0 = states[key][1], (C._d(date) - day0).days * 24
        seg = st[k0:k0 + 24]
        on = [_on(c) if c in "ma0" else None for c in seg]
        prev = _on(st[k0 - 1])
        h = next((i for i, v in enumerate(on) if v is not None and v != (prev if i == 0 else on[i - 1])
                  and (i == 0 or on[i - 1] is not None)), None)
        if h is None:
            c = p >= 0.5
            h = next((i for i in range(1, 24) if c[i] != c[i - 1]), None)
        if h is None:
            h = int(np.argmin(r["spp"] - r["fuel"]))
        why = drivers(ctx, date, key, h) if k0 + h >= 4 and st[k0 + h - 1] not in "o-" else []
        da, _, known = r["cop"]
        out[key] = {"tech": r["tech"], "start": START.get(st[k0 - 1], "unknown"), "p": _r(p), "p_cop": _r(pc) if pc is not None else None,
                    "plan": [int(a >= 0.5) if k else None for a, k in zip(da, known)],
                    "award": [int(v) for v in r["aw"]], "why_h": h + 1,
                    "why_from": START.get(st[k0 + h - 1], "unknown"), "why": why[:3]}
        if getattr(ctx, "live", None) is not None:      # a history day: no 60-day unit file to show what it did
            out[key]["state"] = "".join(seg)
    return out


def build_days(index: dict, rebuild: bool = False) -> list:
    """Write the day files for every 60-day day that has none (all of them when VERSION or LIVE_VERSION changed),
    then, from the thermal history files (operator_history.py), the days before the 60-day fits
    begin, newest first, for at most HISTORY_BUDGET seconds a run.  The scores cover both; the
    turn-off points only the 60-day days, which the Commitment day view shows."""
    import time
    from ..store import load_index
    from .operator_history import context as history_context
    ip = OUT_DIR / "index.json.gz"
    ix = read_json_gz(ip, default=None) or {}
    rebuild = rebuild or ix.get("version") != VERSION
    have = set() if rebuild or ix.get("live_version") != LIVE_VERSION else set(ix.get("days", []))
    hist_old = set() if rebuild else set(ix.get("history_days", []))     # files on hand, any history version
    hist_have = (set(ix.get("history_current", ix.get("history_days", []))) if ix.get("history_version") == HISTORY_VERSION
                 else set()) & hist_old                                  # those written by this history version
    ctx = C.Context(index or load_index())
    want = [d for d in sorted(_days(ctx)) if d not in have]
    done = []
    for d in want:
        u = day_units(ctx, d)
        if u:
            write_json_gz(OUT_DIR / f"{d}.json.gz", {"date": d, "model": NAME, "version": VERSION, "units": u})
            done.append(d)
    days = sorted(have | set(done))
    def save_index():      # also every SAVE_EVERY history days, so a run cut short keeps its work
        write_json_gz(ip, {"model": NAME, "version": VERSION, "live_version": LIVE_VERSION, "days": days, "history_days": sorted(hist_old | hist_have | set(hist_new)),
                           "history_version": HISTORY_VERSION, "history_current": sorted(hist_have | set(hist_new)),
                           "reduced": REDUCED_NOTE})
    hctx, t0, hist_new = history_context(ctx), time.time(), []
    if hctx is not None:
        first = days[0] if days else "9999"
        todo = [d for d in sorted(_days(hctx), reverse=True) if d < first and d not in hist_have]
        for d in todo:
            if time.time() - t0 > HISTORY_BUDGET:
                print(f"{NAME}: history budget spent, {len(todo) - len(hist_new)} history day(s) left for the next run", flush=True)
                break
            u = day_units(hctx, d)
            if u:
                write_json_gz(OUT_DIR / f"{d}.json.gz", {"date": d, "model": NAME, "version": VERSION, "reduced": True, "units": u})
                hist_new.append(d)
                if len(hist_new) % SAVE_EVERY == 0:
                    save_index()
    hist = sorted(hist_old | hist_have | set(hist_new))
    save_index()
    n = build_decision_view(days)
    from .operator_scores import build_scores
    from .operator_cutoffs import build_cutoffs
    if hist and hctx is None:
        print(f"{NAME}: no thermal history files, so the scores and turn-off points are left as they were", flush=True)
        m = c = 0
    else:
        m = build_scores(hctx or ctx, hist + days)
        c = build_cutoffs(ctx, days)     # the Commitment day view covers the 60-day days only
    print(f"{NAME} {VERSION}: {len(done)} day file(s) written, {len(days)} in all; {len(hist_new)} history day file(s) written, "
          f"{len(hist)} in all; {n} decision days judged; {m} unit-days scored against the baselines; turn-off points for {c} new day(s)", flush=True)
    return done


def build_decision_view(days) -> int:
    """data/operator/decisions.json.gz for the Unit page's decision history: for every decision
    day (pipeline.decisions: the unit started online) with a day file, the model's average
    chance online over the day's worst stretch, the share of those hours its COP plan had it on
    (null where none) and the reason that pulled hardest.
      {"model", "version", "units": {train: [[date, p, plan, [driver, push]], ...]}}"""
    from ..decisions import PATH as DECISIONS_PATH
    dec = read_json_gz(DECISIONS_PATH, default=None) or {}
    have = set(days)
    files, out, n = {}, {}, 0
    for r in dec.get("days", []):
        key, d, he, hrs = r[0], r[1], r[3], r[4]
        if d not in have or not he or not hrs:
            continue
        if d not in files:
            files[d] = (read_json_gz(OUT_DIR / f"{d}.json.gz", default=None) or {}).get("units", {})
        u = files[d].get(key)
        if not u:
            continue
        w = slice(he - 1, he - 1 + hrs)
        pl = [v for v in u["plan"][w] if v is not None]
        out.setdefault(key, []).append([d, round(float(np.mean(u["p"][w])), 3), round(float(np.mean(pl)), 2) if pl else None,
                                        u["why"][0] if u["why"] else None])
        n += 1
    write_json_gz(OUT_DIR / "decisions.json.gz", {"model": NAME, "version": VERSION, "units": out})
    return n


if __name__ == "__main__":
    build_days({}, rebuild="--all" in sys.argv)
