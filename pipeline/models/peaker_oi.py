"""Operator-informed peaker model: each combustion turbine's (and recip engine's) hourly start and
stop judged with what its operator knew an hour ahead.  Not a forecast.  Replaces the real-time
fit (peaker_rt, retired Oct 2026), which read the same hour's real-time price: a hindsight the
operator never has, and partly caused by the peakers starting.
Proposal: "Operator-informed peaker model on the site" (Oct 30 2026).

Two hourly transitions, each a logistic pooled over the turbines with one intercept per unit:
  from off  P(online in hour h | offline in h - 1)
  from on   P(offline in hour h | online in h - 1)
from what the operator had before hour h starts (FEATURES): the unit's day-ahead node price at h
and its highest over h to h + 3, its DAM award at h and the share of h to h + 3 awarded, its DAM
resource status (online, OFFQS), DAM system lambda at h, the real-time price at its node in
h - 1 and the highest over h - 3 to h - 1, that real-time price less the day-ahead price for
h - 1, the hour (two harmonics) and how long it has been in its current state.  Prices through
asinh($ / SCALE).  Step mode only: each hour from the true state before it, the decision the
operator faced in that hour.

Monthly, expanding: a month is judged by transitions fitted on every day before it (at least
FIT_MIN_DAYS), a day HALF_LIFE days before the month counting half as much as the day before it.

Hours ERCOT had the unit committed by RUC (unit_hours_60d "ruc"), and the hour after each, are
left out of the fits and the scores: ERCOT's call, not the operator's.

Backtest, Mar-Aug 2026, 225 CTs, each month fitted on earlier days (numpy ridge, as here but
unstandardised): starts caught 2,322 of 15,015 with 1,637 false, stops 6,087 of 15,040 with
3,639 false, Brier from offline 0.0185.  The retired real-time fit: 6,159 starts caught with
25,931 false.  Day-ahead alone: 1,559 / 1,437.  The same hour's real-time price instead of the
hour before's (not knowable): 2,215 / 1,502.  RTD indicative LMPs, the last hour's load, wind
and solar forecast errors, and the intra-hour forecasts each traded caught starts for false ones
about one for one and left the Brier flat, so none is used.  Most CT starts are not predictable
an hour ahead.

The turn-on point, per unit and day with an hour it went into offline: every price at its node,
day-ahead and the real-time hours before, shifted by the same $/MWh until the model's chance that
it starts in one of those hours (1 less the product of each hour's chance of not starting)
reaches 0.5, reported as the day's highest day-ahead node price at
that shift, so it reads against the circle at the day's actual highest.  The real-time prices
shift too because the model reads real-time above day-ahead as a reason to start: shifting the
day-ahead prices alone would push that spread down and hold the chance flat (Oct 2026, Jul: 60%
of hours from offline then never reached 0.5 at any shift).  The chance over the day, not the
highest hour's: a unit that starts most days spreads its start over many hours, none of them
past 0.5 (Aug 26 2026: 33 of 186 days called right on the highest hour, 61 over the day).
Feb-Aug 2026 by day: 6,699 of 14,809 days a unit started called, 1,678 days called that didn't.  Searched over SHIFTS; null when no
shift in it starts the unit.

Writes data/peaker/oi.json.gz:
  {"model", "version", "columns": [...], "half_life", "days": {date: [[unit, turn_on, peak,
   started, hours_on, hours_avail, hours_off, window], ...]},
   "score_columns": [...], "scores": [[month, tech, start, award, cheap, model, hours, right,
   brier, off_n, off_caught, off_false, on_n, on_caught, on_false, ruc_hours], ...]}
turn_on and peak in $/MWh (day-ahead at the unit's node, highest hour of the day); started 1
when it went from offline to online in some hour judged (RUC left out); hours_off the hours it
went into offline (the ones a start could come in); window the days the month's fit used.
scores in operator_scores' columns, tech "combustion_turbine", start the state going into the
hour, model "operator" or "state" (stays as it was), a switch caught only in its own hour.
Rebuilt in full each run.
"""
from collections import defaultdict

import numpy as np

from ..config import DATA_DIR, UNIT_DATA_DIR
from ..parse_prices import node_hourly
from ..store import read_json_gz, write_json_gz

NAME = "peaker_oi"
VERSION = "v1"
PATH = DATA_DIR / "peaker" / "oi.json.gz"
COLUMNS = ("unit", "turn_on", "peak", "started", "hours_on", "hours_avail", "hours_off", "window")
SCORE_COLUMNS = ("month", "tech", "start", "award", "cheap", "model", "hours", "right", "brier",
                 "off_n", "off_caught", "off_false", "on_n", "on_caught", "on_false", "ruc_hours")
FEATURES = ("da", "da_ahead", "award", "award_ahead", "status_on", "status_offqs", "lambda",
            "rt_last", "rt_last3", "rt_less_da", "sin1", "cos1", "sin2", "cos2", "run")
SCALE = 10.0         # $/MWh in asinh(price / SCALE)
HALF_LIFE = 30.0     # days
FIT_MIN_DAYS = 45      # Jan 2026, fitted on December alone, called 1,292 false starts
AHEAD = 4            # hours h to h + AHEAD - 1 in da_ahead and award_ahead
CHEAP = 10.0         # $/MWh DAM system lambda, as operator_scores
ON_STATUS = {"ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR"}
SHIFTS = np.r_[-np.geomspace(1000, 0.5, 40), 0.0, np.geomspace(0.5, 5000, 60)]


def node_prices(dates, units) -> dict:
    """{unit: [len(dates), 24] hourly real-time price at its resource node, NaN for a day without
    all 24} for the units with a node (unit_index.json.gz) and at least one such day.  Also read
    by events.py (rt_price)."""
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


def _a(x):
    return np.arcsinh(np.asarray(x, float) / SCALE)


def features(R, shift=0.0):
    """[n, len(FEATURES)] from the raw rows R (a dict of arrays), every node price, day-ahead and
    real-time, moved by `shift` $/MWh (so the real-time less day-ahead spread stays as it was)."""
    ang = 2 * np.pi * R["h"] / 24
    return np.c_[_a(R["da"] + shift), _a(R["da_ahead"] + shift), R["award"], R["award_ahead"],
                 R["status_on"], R["status_offqs"], _a(R["lam"]), _a(R["rt1"] + shift), _a(R["rt3"] + shift),
                 _a(R["rt1"] - R["da1"]), np.sin(ang), np.cos(ang), np.sin(2 * ang),
                 np.cos(2 * ang), R["run"]]


def _rows(uh, cts, dates, node, lamd, ruc):
    """The raw rows: one per unit and hour judged (both it and the hour before online or offline
    in SCED, not in or just after RUC, the day's DAM record, the day's 24 real-time prices at its
    node and three real-time hours before)."""
    N = len(dates)
    cols = defaultdict(list)
    n_ruc = defaultdict(int)       # (unit index, k, state before) -> RUC hours left out
    for i, d in enumerate(dates):
        du = (read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz", default=None) or {}).get("units") or {}
        lam = lamd.get(d) or []
        lam = [np.nan if x is None else x for x in lam[:24]] + [np.nan] * (24 - len(lam[:24]))
        for ui, u in enumerate(cts):
            e = du.get(u)
            spp = (e or {}).get("spp") or []
            if len(spp) < 24 or None in spp[:24] or u not in node or np.isnan(node[u][i]).any():
                continue        # a day without its own 24 real-time prices would be judged on its first hour alone
            DA = np.array(spp[:24], float)
            aw = np.array([(x or 0) > 0 for x in ((e.get("award") or []) + [0] * 24)[:24]], float)
            st = str(e.get("status") or "").upper()
            s, P, rk = uh["units"][u], node[u].ravel(), ruc.get(u, ())
            for h in range(24):
                k = i * 24 + h
                if k < 3 or k >= len(s) or s[k - 1] not in "ma0" or s[k] not in "ma0":
                    continue
                prev = s[k - 1] in "ma"
                if k in rk or k - 1 in rk:
                    n_ruc[(ui, i, h, int(prev), int(aw[h]))] += 1
                    continue
                if np.isnan(P[k - 3:k]).any():
                    continue
                run = 0
                while k - 1 - run >= 0 and run < 48 and s[k - 1 - run] in "ma0" and (s[k - 1 - run] in "ma") == prev:
                    run += 1
                for c, v in (("u", ui), ("i", i), ("h", h), ("prev", int(prev)), ("on", int(s[k] in "ma")),
                             ("da", DA[h]), ("da_ahead", DA[h:h + AHEAD].max()), ("award", aw[h]),
                             ("award_ahead", aw[h:h + AHEAD].mean()), ("status_on", float(st in ON_STATUS)),
                             ("status_offqs", float(st == "OFFQS")), ("lam", 0.0 if np.isnan(lam[h]) else lam[h]),
                             ("cheap", int(lam[h] <= CHEAP)), ("rt1", P[k - 1]), ("rt3", P[k - 3:k].max()),
                             ("da1", DA[h - 1] if h else DA[0]), ("run", np.log1p(run) / 4.0), ("peak", DA.max())):
                    cols[c].append(v)
    R = {c: np.array(v) for c, v in cols.items()}
    for c in ("u", "i", "h", "prev", "on", "cheap"):
        R[c] = R.get(c, np.zeros(0)).astype(int)
    return R, n_ruc


def _fit_side(X, units, y, w, n_units):
    """Pooled slopes and one intercept per unit (columns scaled to unit variance, L2 C=1)."""
    from sklearn.linear_model import LogisticRegression
    mu, sd = X.mean(0), X.std(0)
    sd[sd == 0] = 1.0
    Z = np.zeros((len(X), X.shape[1] + n_units), dtype=np.float32)
    Z[:, :X.shape[1]] = (X - mu) / sd
    Z[np.arange(len(X)), X.shape[1] + units] = 1.0
    m = LogisticRegression(C=1.0, max_iter=3000).fit(Z, y, sample_weight=w)
    b = m.coef_[0]
    return dict(mu=mu, sd=sd, coef=b[:X.shape[1]], unit=b[X.shape[1]:], b0=float(m.intercept_[0]))


def _p(f, X, units):
    """Chance of a switch."""
    z = ((X - f["mu"]) / f["sd"]) @ f["coef"] + f["unit"][units] + f["b0"]
    return 1.0 / (1.0 + np.exp(-z))


def _start_by_shift(f, R, sel):
    """[n, len(SHIFTS)] chance of a start in the rows `sel` (all from offline) at each shift."""
    sub = {c: v[sel] for c, v in R.items()}
    return np.stack([_p(f, features(sub, s), sub["u"]) for s in SHIFTS], axis=1)


def build_peaker_oi(index=None) -> int:
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    dates = uh.get("dates") or []
    cts = [u["unit"] for u in tr.get("units", []) if u["tech"] == "combustion_turbine" and u["unit"] in uh.get("units", {})]
    if not dates or not cts:
        return 0
    di_of = {d: i for i, d in enumerate(dates)}
    ruc = {}
    for name, days in (uh.get("ruc") or {}).items():
        for d, hes in days:
            if d in di_of:
                ruc.setdefault(name, set()).update(di_of[d] * 24 + he - 1 for he in hes)
    lamd = (read_json_gz(DATA_DIR / "dam_lambda.json.gz", default={}) or {}).get("days") or {}
    node = node_prices(dates, cts)
    R, n_ruc = _rows(uh, cts, dates, node, lamd, ruc)
    if not len(R.get("u", ())):
        return 0
    X = features(R)
    month = np.array([dates[i][:7] for i in R["i"]])
    T = defaultdict(lambda: np.zeros(len(SCORE_COLUMNS) - 6))
    out, n_fit = {}, 0
    for m in sorted(set(month)):
        f0 = min(i for i, d in enumerate(dates) if d[:7] == m)
        train, test = R["i"] < f0, month == m
        nd = len(set(R["i"][train]))
        if nd < FIT_MIN_DAYS:
            continue
        w_all = 0.5 ** ((f0 - R["i"]) / HALF_LIFE)
        fits = {}
        for side in (0, 1):
            tr_s = train & (R["prev"] == side)
            y = (R["on"][tr_s] != side).astype(int)
            if len(set(y)) < 2:
                break
            w = w_all[tr_s]
            fits[side] = _fit_side(X[tr_s], R["u"][tr_s], y, w / w.mean(), len(cts))
        if len(fits) < 2:
            continue
        n_fit += 1
        p = np.full(len(R["u"]), np.nan)       # chance of a switch
        for side in (0, 1):
            sel = test & (R["prev"] == side)
            p[sel] = _p(fits[side], X[sel], R["u"][sel])
        # scores
        for j in np.flatnonzero(test):
            prev, on, sw = R["prev"][j], R["on"][j], R["on"][j] != R["prev"][j]
            key = (m, "combustion_turbine", "on" if prev else "off", int(R["award"][j]), int(R["cheap"][j]))
            call_sw = p[j] >= 0.5
            p_on = p[j] if not prev else 1 - p[j]
            k = 3 if prev else 6       # off_* from online, on_* from offline
            for name, csw in (("operator", call_sw), ("state", False)):
                v = T[key + (name,)]
                v[0] += 1
                v[1] += csw == sw
                if name == "operator":
                    v[2] += (p_on - on) ** 2
                v[k] += sw
                v[k + 1] += sw and csw
                v[k + 2] += csw and not sw
        for (ui, i, h, prev, aw), n in n_ruc.items():
            if dates[i][:7] == m:
                lam = (lamd.get(dates[i]) or [None] * 24)[h]
                for name in ("operator", "state"):
                    T[(m, "combustion_turbine", "on" if prev else "off", aw, int(lam is not None and lam <= CHEAP), name)][9] += n
        # per unit and day: the turn-on point from the hours it went into offline
        off = test & (R["prev"] == 0)
        S = _start_by_shift(fits[0], R, off)
        jo = np.flatnonzero(off)
        groups = defaultdict(list)
        for r, j in enumerate(jo):
            groups[(R["i"][j], R["u"][j])].append(r)
        day_rows = defaultdict(list)
        for j in np.flatnonzero(test):
            day_rows[(R["i"][j], R["u"][j])].append(j)
        for (i, ui), rs in sorted(groups.items()):
            js = np.array(day_rows[(i, ui)])
            peak = float(R["peak"][js[0]])
            hit = np.flatnonzero(1 - np.prod(1 - S[rs], axis=0) >= 0.5)
            out.setdefault(dates[i], []).append([cts[ui], None if not len(hit) else round(peak + float(SHIFTS[hit[0]]), 2), round(peak, 2),
                                                 int((R["on"][jo[rs]] == 1).any()), int(R["on"][js].sum()), len(js), len(rs), nd])
    rows = [list(k) + [int(v[0]), int(v[1]), round(float(v[2]), 3) if k[5] == "operator" else None] + [int(x) for x in v[3:]]
            for k, v in sorted(T.items())]
    write_json_gz(PATH, {"model": NAME, "version": VERSION, "columns": list(COLUMNS), "half_life": HALF_LIFE,
                         "days": dict(sorted(out.items())), "score_columns": list(SCORE_COLUMNS), "scores": rows})
    print(f"{NAME} {VERSION}: {n_fit} monthly fits, {len(out)} days, {len(rows)} score rows", flush=True)
    return len(out)


def summary(path=None, cheap=None):
    """{model: totals} from the scores, optionally cheap (1) or not (0) only."""
    s = read_json_gz(path or PATH, default=None) or {}
    ci = {c: i for i, c in enumerate(s.get("score_columns", []))}
    out = {}
    for r in s.get("scores", []):
        if cheap is not None and r[ci["cheap"]] != cheap:
            continue
        o = out.setdefault(r[ci["model"]], defaultdict(float))
        for c in SCORE_COLUMNS[6:]:
            o[c] += r[ci[c]] or 0
    return out


if __name__ == "__main__":
    build_peaker_oi()
    for ch in (None, 1):
        print("cheap hours" if ch else "all hours")
        for mdl, o in summary(cheap=ch).items():
            print(f"  {mdl:9s} right {o['right'] / max(o['hours'], 1):6.2%}  on {int(o['on_caught'])}/{int(o['on_n'])} false {int(o['on_false'])}"
                  f"  off {int(o['off_caught'])}/{int(o['off_n'])} false {int(o['off_false'])}  brier {o['brier'] / max(o['hours'], 1):.4f}")
