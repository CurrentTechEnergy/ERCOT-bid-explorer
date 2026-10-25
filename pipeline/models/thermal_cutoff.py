"""Commitment: which thermal units are expected on for the day, judged on the day's own
economics, never on a price level.

For every thermal train in the latest DAM disclosure (pipeline.forecast.context.Context.units):

  outage      its last known hourly state (the latest 60-day day public before the day's
              day-ahead market cleared, so about sixty days old) is outage and the outage had
              already lasted LONG_OUT days or more by then: expected off all day.  A shorter
              outage sixty days ago says little about today (most are over), so it is ignored
              and the unit is judged like any other
  nuclear     on (output at HSL) unless on outage
  never       the always-on group (off only for outages in its history): on
  never_on    no running hour in the 60-day history: off (p_on 0)
  daily       loss = the worst contiguous window of (minimum-energy cost - day-ahead price at
              the unit's node) x LSL over the day, in $ (pipeline.decisions._window).  v1 turns
              it into p_on, the probability the unit stays on through that window: v5 boosted
              trees (scikit-learn, GBT settings, _trees) fitted on the decision days up to the
              asof point, one model over every technology, from
                - the loss over the unit's cutoff, per MW of LSL.  The cutoff is the unit's own
                  (pipeline.decisions._cutoff, on its decision days before this day) pulled
                  toward its technology's pooled cutoff by POOL_K / (decision days + POOL_K);
                  a unit without its own but with POOL_MIN decision days gets the pooled one
                - the window's length against the unit's 10th-percentile off spell (log ratio;
                  MIN_OFF_DEFAULT without one).  A window reaching HE24 runs on into the next
                  morning while the margin stays negative there, with the day's own early-hour
                  prices standing in for the next day's, which are not known yet
                - the margin the unit earns before and after the window, per MW
                - the unit's award history share (the day's own award is not public yet), and
                  the loss over the cutoff split by it
                - the technology, whether the group is a daily one, the month, the hour and
                  log(1 + loss per MW of LSL)
                - v8: the P(on) of a first set of trees (_stack) fitted the same way on the
                  thermal history before the 60-day window (2024 to Nov 2025, the `history`
                  release, pipeline/history.py), without the unit's award history and share of
                  days run (_hist_view: those are as of today, not as of the old day).  The
                  trees on the recent days decide how far the older market's behaviour carries
                  over past RTC+B (Dec 5, 2025)
                - v9: those history trees also read the day's forecast net load (ERCOT's load
                  forecast less its wind and solar forecasts, as of the day-ahead market,
                  pipeline/load.py) for combined cycles (_net)
              "off" below P_OFF, "maybe" up to P_ON, "on" above.  A daily unit with no cutoff
              at all ("nocut") gets p_on = its share of days with any online hour.
  CC trains, gas steam
              every combined-cycle train and gas steam unit (WINDOW_TECHS) with a group other
              than never is judged as a daily unit is, on its own stay-on loss
              (CC_WINDOW_GROUPS); the trees tell the slow-cycling ones (multiday, seasonal) apart
              by the daily-group input.  A gas steam unit with too few decision days for a cutoff
              falls back to the seasonal rule.
  seasonal, multiday
              (coal, and gas steam without a cutoff) rule v0 (SEASONAL_VERSION): on when the unit was running at its last known hour
              and the month's day-ahead hub average to date is not below the lowest monthly
              hub average it has run through; off otherwise.  A placeholder until a
              multi-week economics rule exists.
  NRC        a nuclear unit whose reactor the NRC reported below NRC_OFF_PCT power the morning
              before (Context.nrc_off) is "outage" all day
  listed out  a unit in ERCOT's unplanned outage report public before the day cleared
              (Context.listed_out) is "outage" all day; a CC train counts only when all its gas
              turbines are listed (one listed of two usually still runs, on the other).  A CC
              train, or a gas steam unit outside the never group, on a long outage at the last
              known hour that the report does not list (CLEAR_TECHS) is judged as if off then.
              Always-on gas steam units are left out: their long outages are mostly mothballs,
              which the report does not carry.
  unseen      the outage capacity by zone that the unit-level report does not explain
              (Context.unseen_out, planned outages mostly) is placed on the zone's coal, CC, gas
              steam and combustion turbine units not judged "outage", by free HSL x (UNSEEN_EPS +
              the share of days the unit was out within two weeks of the date in earlier years,
              Context.outage_prior), each capped at its free HSL (v10; spread by HSL alone
              before): each carries unseen_share, folded into out_share, which the dispatch model
              takes off its weight
  stay-on     (v11) a CC train or gas steam unit judged on its window takes P(on) inside it as
              the trees' P(on) in the hour before it times a logistic's P(stays on | on): one
              fit per technology with one intercept per unit (_logit_fit, the year to the asof
              point, on unit-days online going into the window), whose inputs are the loss per
              MW of LSL, the margins either side, the window against the unit's short off spell,
              overnight and season.  Without a fit the trees' P(on) stands
  pool        (v11) once outage_pool has its fitted days (outage_pool.ready), the long-outage
              carry-over for coal and CC (POOL_DROP_TECHS) and the unseen allocation give way to
              outage_pool's zonal deduction by hour (commit "outage_pool" true; the build takes
              it off after the dispatch), placed on no unit; units the outage report names keep
              their calls.  Before that (the first weeks of the outage report snapshots) the
              unseen allocation stands, and the rows' version says so ("+v10-outages")
  peakers     combustion turbines outside the always-on group (which are held on, as other
              always-on units) are not judged here (peaker_share, by hour, on the hours
              they were available); they get verdict "peaker" and p_on from that model, and the
              outage calls above (long outage, listed, unseen share) as other units do.  So do
              the gas steam and CC units that run like peakers (peaker_share.peaker_like).

p_on is the weight the dispatch model applies to the unit's MW: 1 for on, 0 for off, the
history share for nocut, and for a daily unit judged on its window the probability above,
here by hour: the trees are fitted on the window's unit-hours, with each hour's own margin and
its distance from the window's edge added, and p_on is its mean over the window.  The hourly
values are carried as p_window with the window (win_from, win_hours): the dispatch model holds
the unit on outside the window and at p_window inside it.  off_from and off_hours are still set for "off"
and "maybe" so the 2-day fit starts those units off or off for the window.

Everything a verdict reads from history is as of the day's known date: groups, online shares
and the seasonal month floor from pipeline.forecast.context's asof point (stats_at,
groups_at), decision days on or before the known date, and the last known state from the
merged states up to that hour only (an off spell open at that hour is judged on its hours so
far, not on how it later turned out).  A live day reads the full record, as before.
"""
import datetime as dt
import os
from collections import defaultdict

import numpy as np

from ..config import DATA_DIR
from ..store import read_json_gz

from ..decisions import _window, _cutoff, _dam_trains, HALF, OUT_MIN_H
from ..forecast import context as C
from . import dam_replay, outage_pool, peaker_share

UNSEEN_EPS = 0.1   # unseen-outage weight of a unit never out in these weeks of earlier years, against 1.1 for one always out then
UNSEEN_TECHS = ("coal", "combined_cycle", "gas_steam", "combustion_turbine")   # spread the zonal unseen outage MW over these
NAME = "thermal_cutoff"
VERSION = "v11"   # v11: logistic stay-on rule in the window, zonal outage pool in place of the unseen allocation, long outages carried for gas steam and CTs only; v10: the zonal unseen outage placed first on units usually out in these weeks, at the fitted slope; v9: the history trees also read the forecast net load, for combined cycles; v8: the P(on) of trees fitted on the 2024-25 thermal history as an input; v7: combustion turbines share the zonal unseen outage; v6: technology one-hot, drivers of each P(on); v5: stay-on probability by boosted trees; v4: loss over the cutoff split by award history; v3: gas steam on its stay-on loss, stale gas steam outages dropped; v2: CC outage calls by gas turbine, zonal unseen outages; v1: NRC reactor status, listed outages; probability of staying on through the window, per-unit horizon, pooled cutoffs
SEASONAL_VERSION = "v0"
RUN_SHARE = 0.5          # a month the unit ran through: online at least this share of its hours
LONG_OUT = 21            # days an outage must already have lasted at the last known hour to carry forward
MIN_OFF_DEFAULT = {"combined_cycle": 7.0, "gas_steam": 16.0, "coal": 24.0}   # hours, without a p10 of its own
POOL_K = 15              # decision days at which a unit's own cutoff and the pooled one weigh the same
POOL_MIN = 3             # decision days a unit needs for a pooled cutoff
P_OFF, P_ON = 0.3, 0.7   # p_on below P_OFF is "off", above P_ON "on", between "maybe"
DAILY_TECHS = ("combined_cycle", "gas_steam", "coal")
POOL_DROP_TECHS = ("coal", "combined_cycle")    # with the outage pool, the long-outage carry-over is dropped for these only (kept for gas steam and CTs, where it was mostly right)
CLEAR_TECHS = ("combined_cycle", "gas_steam")   # a 60-day outage these carry is dropped when the outage report does not list the unit
WINDOW_TECHS = ("combined_cycle", "gas_steam")   # judged on their own stay-on cost in CC_WINDOW_GROUPS
CC_WINDOW_GROUPS = ("daily1", "daily2", "daily3", "multiday", "seasonal")   # CC trains judged on their own stay-on cost
GBT = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=200, l2_regularization=1.0, random_state=0)


def _month_floor(ctx, key, known):
    """Lowest monthly mean day-ahead hub average over the months the unit ran through, from
    the days up to the known date."""
    st = ctx.stats["states"].get(key)
    if st is None or known is None:
        return None
    tech, states = st
    dates, day0 = ctx.uh["dates"], ctx.stats["day0"]
    hub = ctx.hub_daily()
    by_month = {}
    for d in dates:
        if d > known:
            break
        dn = (C._d(d) - day0).days
        seg = states[dn * 24:(dn + 1) * 24]
        if d not in hub or seg.size < 24:
            continue
        m = by_month.setdefault(d[:7], [0, 0, []])
        m[0] += int(np.isin(seg, ["m", "a"]).sum()); m[1] += int((seg != "-").sum()); m[2].append(hub[d])
    ran = [float(np.mean(v[2])) for v in by_month.values() if v[1] and v[0] / v[1] >= RUN_SHARE]
    return min(ran) if ran else None


def _last_state(ctx, key, known):
    """(state char at the last hour with data of the known day, days the current outage had
    lasted by then) for a train ("-", 0 if none).  Read from the raw merged states up to that
    hour: an open non-running spell is an outage when, so far, it is mostly outage or has
    fewer than OUT_MIN_H hours OFF (the rule the full record applies to whole spells)."""
    st = ctx.raw_states().get(key)
    if st is None or known is None:
        return "-", 0
    dn = (C._d(known) - ctx.stats["day0"]).days
    end = (dn + 1) * 24
    seg = st[1][:end]
    idx = np.where(seg != "-")[0]
    if not idx.size:
        return "-", 0
    last = idx[-1]
    if seg[last] in "ma":
        return seg[last], 0
    k = last
    while k >= 0 and seg[k] not in "ma":
        k -= 1
    spell = seg[k + 1:last + 1]
    off, out = int((spell == "0").sum()), int((spell == "o").sum())
    if out and (off < OUT_MIN_H or out > off):
        return "o", (last - k) / 24.0
    return ("0" if off else seg[last]), 0


def _decision_rows(ctx, key, known):
    """(loss, award share, shut) for the unit's decision days public by the known date."""
    if known is None:
        return []
    return [(r[2], r[5], r[6]) for r in ctx.decisions.get("days", []) if r[0] == key and r[1] <= known]


# ------------------------------------------------------------------ v1: p_on --
def _span(margin, bs, nh):
    """Hours a loss window lasts on a day that wraps: a window reaching HE24 runs on into the
    next morning for as long as the margin stays negative there.  The next day's prices are not
    known when the day clears, so the day's own early hours stand in for them."""
    if nh <= 0:
        return 0
    if bs + nh < 24:
        return nh
    k = 0
    while k < bs and margin[k] < 0:
        k += 1
    return nh + k


def _features(margin, lsl, loss, bs, nh, cut, min_off, aw, on_days):
    """The logistic's inputs for one unit-day: loss over the cutoff ($/MW of LSL, /100) times
    the share of days without an award and, separately, times the award share, the
    window's wrapped length against the unit's shortest usual off spell (log ratio), the margin
    earned before and after the window ($/MW, /100), the unit's award history share and its
    share of days with any online hour."""
    before = float(np.clip(margin[:bs], 0, None).sum()) / lsl
    after = float(np.clip(margin[bs + nh:], 0, None).sum()) / lsl
    span = _span(margin, bs, nh)
    over = (loss - cut) / lsl / 100.0
    # the cutoff is learned on days without an award, so the loss over it is split by the
    # unit's award history: the fit decides how much it counts for a unit usually awarded
    return [1.0, over * (1.0 - aw), over * aw, float(np.log(max(span, 1) / min_off)), before / 100.0, after / 100.0,
            aw, on_days]


def _hourly(f, margin, lsl, bs, nh):
    """[24, len(f) + 3]: the day's features for each hour, with that hour's margin ($/MW, /100),
    whether it is inside the loss window, and its distance from the window's nearer edge
    (share of the window, 0 outside): a unit that shuts is off in the window's deep middle,
    often still on at its edges, and one that rarely runs is off outside it too."""
    hs = np.arange(24)
    inw = (hs >= bs) & (hs < bs + nh)
    edge = np.where(inw, np.minimum(hs - bs, bs + nh - 1 - hs) / max(nh, 1), 0.0)
    return np.column_stack([np.tile(f, (24, 1)), margin / lsl / 100.0, inw.astype(float), edge])


def _tree_x(x, tech, group, month, loss, lsl):
    """The boosted trees' inputs for a unit-day's 24 hours: the logistic's (without its
    intercept) and the technology (one column per DAILY_TECHS), whether the group is a daily
    one, the month, the hour, log(1 + loss per MW of LSL).  The order is DRIVERS'."""
    return np.column_stack([x[:, 1:], np.tile([float(tech == t) for t in DAILY_TECHS], (24, 1)),
                            np.full(24, float(str(group or "").startswith("daily"))), np.full(24, float(month)),
                            np.arange(24, dtype=float), np.full(24, float(np.log1p(max(loss, 0.0) / lsl)))])


# the trees' inputs (_tree_x columns) gathered into the drivers a unit page lists
DRIVERS = [("loss against its cutoff", (0, 1, 16)), ("award history", (5,)),
           ("window length against its usual off spell", (2,)), ("margin before and after the window", (3, 4)),
           ("share of days it ran", (6,)), ("hour-by-hour prices in the window", (7, 8, 9, 15)),
           ("technology, group and month", (10, 11, 12, 13, 14)),
           ("how units like it ran in 2024-25", (17,))]


def _hist_view(Z):
    """What the history trees see of _tree_x rows: no award history and no share of days run.
    Those are the unit's as of the forecast, not as of the history day, so on old days they
    would mislabel the unit; its loss over the cutoff is kept whole."""
    Z = np.array(Z, float)
    Z[:, 0] += Z[:, 1]
    Z[:, [1, 5, 6]] = 0.0
    return Z


def _net(ctx, date, tech):
    """[24]: the history trees' net-load input, the day's mean forecast net load (GW,
    Context.net_load) for a combined cycle, NaN otherwise or where unknown.  Only the history
    trees read it: their 23 months hold enough days to learn from it, while in the recent
    trees a day-level input this wide would mostly tell the 60 days apart."""
    v = ctx.net_load(date) if tech == "combined_cycle" else None
    return np.full(24, float(np.nanmean(v)) / 1000.0 if v is not None and np.isfinite(v).any() else np.nan)


def _allocate(total, units):
    """{key: MW} placing `total` MW over `units` [(key, free MW, weight)] in proportion to weight,
    each capped at its free MW, the overflow passed on to the rest."""
    out, left = {}, list(units)
    while total > 1e-6 and left:
        w = sum(u[2] for u in left)
        if w <= 0:
            break
        over = [u for u in left if total * u[2] / w >= u[1]]
        if not over:
            for k, _, wt in left:
                out[k] = total * wt / w
            break
        for k, free, _ in over:
            out[k] = free
            total -= free
        left = [u for u in left if u not in over]
    return out


def _stack(hist, Z, net):
    """Z with the history trees' P(on) appended (NaN without history trees); `net` the rows' _net."""
    return np.column_stack([Z, hist.predict_proba(np.column_stack([_hist_view(Z), net]))[:, 1]
                            if hist is not None else np.full(len(Z), np.nan)])


def _trees(Z, y):
    """Boosted trees (scikit-learn) on the unit-hours.  Every input is numeric (the technology
    one-hot), so the tree attributions in _drivers add up exactly."""
    from sklearn.ensemble import HistGradientBoostingClassifier
    Z = np.where(np.isnan(Z).all(axis=0), 0.0, Z)     # an input with no values (no history trees) cannot be binned
    return HistGradientBoostingClassifier(**GBT).fit(Z, y)


def _drivers(model, Z, bs, nh, p_on):
    """(p_base, [[driver, points]]): how far each driver moved the unit's P(on) from the
    trees' starting point (the training data's average, in probability).  Tree SHAP
    attributions in log-odds, averaged over the window's hours, scaled so the points add up
    to p_on - p_base; largest first."""
    import shap
    ex = model.__dict__.get("_explainer")
    if ex is None:
        ex = model._explainer = shap.TreeExplainer(model)
    phi = np.asarray(ex.shap_values(Z[bs:bs + nh])).reshape(nh, -1).mean(axis=0)
    base = float(np.ravel(ex.expected_value)[0])
    p0 = 1.0 / (1.0 + np.exp(-base))
    g = np.array([phi[list(ix)].sum() for _, ix in DRIVERS])
    tot = g.sum()
    pts = g * (p_on - p0) / tot if abs(tot) > 1e-6 else g * p0 * (1 - p0)
    out = sorted(([name, round(float(v), 3)] for (name, _), v in zip(DRIVERS, pts)), key=lambda r: -abs(r[1]))
    return round(p0, 3), out



def _day_trains(ctx):
    """{date: {train: (tech, node prices [24], mingen or None, lsl)}} for every decision date,
    from the DAM day files (combined-cycle configurations merged as in pipeline.decisions)."""
    if getattr(ctx, "_cut_days", None) is None:
        out = {}
        for d in ctx.decisions.get("dates", []):
            dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz")
            if not dd:
                continue
            out[d] = {key: (e["tech"], e["spp"], e["mingen"], e["lsl"]) for key, e in _dam_trains(dd).items()
                      if e["tech"] in DAILY_TECHS and e["spp"] is not None and e["lsl"]}
        ctx._cut_days = out
    return ctx._cut_days



def _seasonal(row, ctx, key, known, last, mtd, month):
    """The seasonal rule (SEASONAL_VERSION) for a seasonal or multiday unit, into `row`."""
    floor = _month_floor(ctx, key, known)
    running = last in "ma"
    row["version"] = f"{VERSION}+seasonal-{SEASONAL_VERSION}"
    if mtd is None:
        row.update(verdict="nocut", p_on=1.0 if running else 0.0, reason="no hub prices for the month")
    elif running and (floor is None or mtd >= floor):
        row.update(verdict="on", p_on=1.0,
                   reason=f"running at {known}; {month} hub ${mtd:.0f} vs lowest month run through ${floor:.0f}" if floor is not None else f"running at {known}")
    elif running:
        row.update(verdict="off", p_on=0.0, off_from=1, off_hours=24,
                   reason=f"{month} hub ${mtd:.0f} below the lowest month it ran through (${floor:.0f})")
    else:
        row.update(verdict="off", p_on=0.0, off_from=1, off_hours=24, reason=f"off at {known}")


def _min_off(ctx, date, key, tech):
    v = ctx.off_p10_at(date).get(key)
    return max(float(v), float(OUT_MIN_H)) if v else MIN_OFF_DEFAULT.get(tech, 12.0)


def _pool(ctx, date):
    """As of asof(date): per unit {key: (own cutoff $/MW or None, decision days, award share)},
    the pooled cutoff per technology ($/MW, median of the units' own), and the logistic weights
    per technology, fitted on every daily-group unit-day up to the point with a loss window:
    the target is the share of the window's hours the unit was online, whatever its state when
    the day began.  Cached per history point."""
    point, _ = ctx.asof(date)
    cache = ctx.__dict__.setdefault("_cut_pool", {})
    if point in cache:
        return cache[point]
    units = ctx.decisions.get("units", {})
    by = {}
    for r in ctx.decisions.get("days", []):
        if point is None or r[1] <= point:
            by.setdefault(r[0], []).append(r)
    own, pm = {}, {}
    for key, rows in by.items():
        u = units.get(key)
        if not u or not u[1]:
            continue
        days = [(r[2], r[5], r[6]) for r in rows]
        c = _cutoff(days)
        aw = float(np.mean([d[1] >= HALF for d in days]))
        own[key] = (c[0] / u[1] if c else None, len(days), aw)
        if c:
            pm.setdefault(u[0], []).append(c[0] / u[1])
    pool = {t: float(np.median(v)) for t, v in pm.items()}
    groups, stats, raw = ctx.groups_at(date), ctx.stats_at(date), ctx.raw_states()
    day0 = ctx.stats["day0"]
    X, y, N, XH, yH = [], [], [], [], []
    L = []      # (train, tech, date, logistic inputs, off) per window-tech unit-day, for the stay-on logistic
    for d, trains in _day_trains(ctx).items():
        if point is not None and d > point:
            continue
        dn = (C._d(d) - day0).days
        for key, (tech, spp, mg, lsl) in trains.items():
            g = groups.get(key)
            if not (str(g or "").startswith("daily") or (tech in WINDOW_TECHS and g in CC_WINDOW_GROUPS)) or key not in own:
                continue
            st = raw.get(key)
            mg = units[key][2] if mg is None else mg
            cpm = _blend(own[key], pool.get(tech))
            if st is None or mg is None or cpm is None or (dn + 1) * 24 > len(st[1]):
                continue
            margin = (spp - mg) * lsl
            loss, bs, nh = _window(-margin)
            seg = st[1][dn * 24:(dn + 1) * 24]
            if nh <= 0 or (seg == "-").any() or (seg == "o").any():
                continue
            s = stats["units"].get(key)
            f = _features(margin, lsl, loss, bs, nh, cpm * lsl, _min_off(ctx, date, key, tech), own[key][2],
                          s["on_days"] if s else 0.0)
            X.append(_tree_x(_hourly(f, margin, lsl, bs, nh), tech, g, d[5:7], loss, lsl)); y.append(np.isin(seg, ["m", "a"]).astype(float))
            N.append(_net(ctx, d, tech))
            k0 = dn * 24 + bs - 1       # the hour before the window (the previous day's HE24 for a window from HE1)
            if tech in WINDOW_TECHS and k0 >= 0 and st[1][k0] in "ma":
                L.append((key, tech, d, _logit_x(f, margin, loss, lsl, bs, nh, d, ctx, key), float(y[-1][bs:bs + nh].mean() < 0.5)))
    # the thermal history before the 60-day window (pipeline/history.py), on the units'
    # attributes as of the point: the same rows from months of DAM days before and after RTC+B
    first = min(_day_trains(ctx), default=None)
    for d, trains in (C.history_trains(DAILY_TECHS, first) if first else {}).items():
        for key, (tech, spp, mg, lsl, seg) in trains.items():
            g = groups.get(key)
            if not (str(g or "").startswith("daily") or (tech in WINDOW_TECHS and g in CC_WINDOW_GROUPS)) or key not in own:
                continue
            mg = units[key][2] if mg is None else mg
            cpm = _blend(own[key], pool.get(tech))
            if mg is None or cpm is None or (seg == "-").any() or (seg == "o").any():
                continue
            margin = (spp - mg) * lsl
            loss, bs, nh = _window(-margin)
            if nh <= 0:
                continue
            s = stats["units"].get(key)
            f = _features(margin, lsl, loss, bs, nh, cpm * lsl, _min_off(ctx, date, key, tech), own[key][2],
                          s["on_days"] if s else 0.0)
            XH.append(np.column_stack([_hist_view(_tree_x(_hourly(f, margin, lsl, bs, nh), tech, g, d[5:7], loss, lsl)),
                                       _net(ctx, d, tech)])); yH.append(np.isin(seg, ["m", "a"]).astype(float))
            if tech in WINDOW_TECHS and bs > 0 and seg[bs - 1] in "ma":
                L.append((key, tech, d, _logit_x(f, margin, loss, lsl, bs, nh, d, ctx, key), float(yH[-1][bs:bs + nh].mean() < 0.5)))
    X = np.vstack(X) if X else np.zeros((0, 0))
    y = np.concatenate(y) if y else np.zeros(0)
    # stacked: trees on the history alone, whose P(on) is one more input to the trees on the
    # 60 days, so the recent market decides how far the history's view carries over
    hist = _trees(np.vstack(XH), np.concatenate(yH)) if XH else None
    w = {None: _trees(_stack(hist, X, np.concatenate(N)), y), "hist": hist} if len(y) else {}
    if point is not None:
        w["logit"] = _logit_fit(L, point)
    cache[point] = (own, pool, w)
    return cache[point]


# ------------------------------------------------------------ logistic stay-on rule --
LOGIT_DAYS = 365      # days up to the asof point the stay-on rule is fitted on
LOGIT_MIN = 300       # unit-days a technology needs for its own fit (else CC and gas steam together)
SEASONS = {12: 0, 1: 0, 2: 0, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 3, 10: 3, 11: 3}
REPLAY = os.environ.get("LOGIT_REPLAY") == "1"    # test switch: the DAM's call replayed on the unit's known offer as a stay-on input


def _configs(ctx, date, key):
    """The resource names of a unit or train as of `date` (itself when unknown)."""
    cache = ctx.__dict__.setdefault("_logit_configs", {})
    if (date, key) not in cache:
        cache[(date, key)] = tuple((ctx.units(date).get(key) or {}).get("configs") or [key])
    return cache[(date, key)]


def _logit_x(f, margin, loss, lsl, bs, nh, d, ctx=None, key=None):
    """The stay-on rule's inputs for a unit-day (analysis/decision_model.py, its no-award variant,
    without the start offer): log(1 + loss per MW of LSL), log(1 + the margin per MW before and
    after the window), the window's wrapped length against the unit's short off spell (log
    ratio, from _features), whether the window is overnight (starts before HE7 or runs on into
    the next morning), and the season (spring, summer, fall against winter)."""
    s = SEASONS[int(d[5:7])]
    over = float(bs < 6 or _span(margin, bs, nh) > nh)
    x = [float(np.log1p(max(loss, 0.0) / lsl)), float(np.log1p(f[4] * 100.0)), float(np.log1p(f[5] * 100.0)), f[3],
         over, float(s == 1), float(s == 2), float(s == 3)]
    if REPLAY:
        x.append(dam_replay.off_share(ctx, d, _configs(ctx, d, key), bs, nh) if ctx is not None and key else np.nan)
    return x


def _logit_fit(L, point):
    """{tech: (mean, sd, trains, model)}: a logistic for "off for most of the window", given
    online in the hour before it (as analysis/decision_model.py's blocks), on the
    LOGIT_DAYS days up to `point`, standardised inputs plus one intercept per train (L2, as
    analysis/decision_model.py), one fit per technology with LOGIT_MIN unit-days, else one fit
    for both under "*"."""
    from sklearn.linear_model import LogisticRegression
    lo = (C._d(point) - dt.timedelta(days=LOGIT_DAYS)).isoformat()
    rows = [r for r in L if lo < r[2] <= point]
    out = {}
    groups = {t: [r for r in rows if r[1] == t] for t in WINDOW_TECHS}
    small = [t for t, g in groups.items() if len(g) < LOGIT_MIN]
    if small:
        groups = {**{t: g for t, g in groups.items() if t not in small}, "*": [r for r in rows if r[1] in small]}
    for t, g in groups.items():
        ys = np.array([r[4] for r in g])
        if len(g) < 50 or ys.min() == ys.max():
            continue
        x = np.array([r[3] for r in g])
        mu, sd = np.nanmean(x, axis=0), np.nanstd(x, axis=0)
        sd[~(sd > 0)] = 1.0
        trains = sorted({r[0] for r in g})
        out[t] = (mu, sd, trains, LogisticRegression(C=1.0, max_iter=2000).fit(_logit_design(x, mu, sd, trains, [r[0] for r in g]), ys))
    return out


def _logit_design(x, mu, sd, trains, keys):
    ix = {k: i for i, k in enumerate(trains)}
    d = np.zeros((len(keys), len(trains)))
    for j, k in enumerate(keys):
        if k in ix:
            d[j, ix[k]] = 1.0
    return np.hstack([np.nan_to_num((np.asarray(x, float) - mu) / sd), d])


def _logit_p_off(fits, tech, key, x):
    """P(off for most of the window) from the stay-on rule, or None without a fit for the tech."""
    fit = fits.get(tech) or fits.get("*")
    if fit is None:
        return None
    mu, sd, trains, m = fit
    return float(m.predict_proba(_logit_design([x], mu, sd, trains, [key]))[0, 1])


# the stay-on rule's inputs (_logit_x order) grouped for the drivers, plus the unit's own intercept
LOGIT_DRIVERS = [("loss in the window", (0,)), ("margin before and after the window", (1, 2)),
                 ("window length against its usual off spell", (3,)), ("overnight window", (4,)), ("season", (5, 6, 7))]
if REPLAY:
    LOGIT_DRIVERS.append(("the day-ahead market's call on its offer", (8,)))
UNIT_DRIVER = "its own record of staying on"
RUNNING_DRIVER = "chance it is running going in"


def _logit_drivers(fits, tech, key, x, p_in):
    """(p_base, [[driver, points]]) for a unit on the stay-on rule, as _drivers for the trees:
    p_base is P(stays on) for a typical unit of its technology (every input at its mean, the
    average unit intercept) given running going in; each input group's log-odds push, and the
    unit's own intercept against the average, are scaled so they add up to its P(stays on) less
    p_base; RUNNING_DRIVER is then what the trees' P(on) going in (p_in) takes off."""
    fit = fits.get(tech) or fits.get("*")
    if fit is None:
        return None
    mu, sd, trains, m = fit
    k = len(mu)
    coef, b0 = -m.coef_[0], -float(m.intercept_[0])        # signs flipped: log-odds of staying on
    unit_c = coef[k:]
    avg = float(unit_c.mean()) if len(unit_c) else 0.0
    own = float(unit_c[trains.index(key)]) - avg if key in trains else 0.0
    z = np.nan_to_num((np.asarray(x, float) - mu) / sd)
    g = [float((coef[list(ix)] * z[list(ix)]).sum()) for _, ix in LOGIT_DRIVERS] + [own]
    sig = lambda v: 1.0 / (1.0 + np.exp(-v))
    p0, p1 = sig(b0 + avg), sig(b0 + avg + sum(g))
    tot = sum(g)
    pts = [v * (p1 - p0) / tot if abs(tot) > 1e-6 else 0.0 for v in g]
    names = [n for n, _ in LOGIT_DRIVERS] + [UNIT_DRIVER]
    out = [[n, round(float(v), 3)] for n, v in zip(names, pts)] + [[RUNNING_DRIVER, round(float(p_in * p1 - p1), 3)]]
    return round(float(p0), 3), sorted(out, key=lambda r: -abs(r[1]))


def _blend(own, pool):
    """Cutoff per MW of LSL: the unit's own pulled toward the technology's pooled cutoff by
    POOL_K / (decision days + POOL_K); the pooled one alone for a unit without its own with at
    least POOL_MIN decision days; None otherwise."""
    c, n, _ = own
    if pool is None:
        return c
    if c is None:
        return pool if n >= POOL_MIN else None
    return (n * c + POOL_K * pool) / (n + POOL_K)


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    known, hindsight = ctx.known_date(date)
    point, asof_hind = ctx.asof(date)
    groups, stats = ctx.groups_at(date), ctx.stats_at(date)
    like = peaker_share.peaker_like(stats)
    mtd, month = ctx.month_to_date_hub(date)
    node_src = ctx.node_source(date)
    rows = {}
    listed = ctx.listed_out(date)
    opool = True if outage_pool.ready(ctx, date, units) else None     # the deduction itself follows the dispatch (build)
    for key, u in units.items():
        t = u["tech"]
        if t not in C.THERMAL:
            continue
        g = "never" if t == "nuclear" else groups.get(key)
        cc_win = t in WINDOW_TECHS and g in CC_WINDOW_GROUPS
        last, out_days = _last_state(ctx, key, known)
        if last == "o" and (out_days < LONG_OUT or (opool is not None and t in POOL_DROP_TECHS)):
            last = "0"       # a short outage sixty days ago (or, with the pool, any for coal and CC): treated as off then, judged normally
        cleared = (last == "o" and t in CLEAR_TECHS and (t == "combined_cycle" or g != "never")
                   and listed is not None and not listed.get(key))
        if cleared:
            last = "0"       # a CC outage sixty days ago the outage report no longer lists: judged normally
        row = {"tech": t, "group": g, "hsl": u["hsl"], "lsl": u["lsl"], "outage": last == "o",
               "verdict": None, "p_on": 0.0, "loss": None, "cutoff": None, "off_from": None, "off_hours": 0,
               "reason": "", "model": NAME, "version": VERSION + ("" if opool else "+v10-outages")}
        if last == "o":
            row.update(verdict="outage", reason=f"on outage for {out_days:.0f} days at the last known hour ({known})")
        elif g == "never_on":
            row.update(verdict="off", p_on=0.0, reason="never on in the period")
        elif t == "nuclear" or (g == "never" and not cc_win):
            row.update(verdict="on", p_on=1.0, reason="always on when available" if g == "never" else "nuclear")
        elif t == "combustion_turbine":
            row.update(verdict="peaker", reason="judged by hour (peaker_share)")
        elif key in like:
            row.update(verdict="peaker", reason="runs like a peaker: judged by hour (peaker_share)")
        elif g in ("seasonal", "multiday") and not cc_win:
            _seasonal(row, ctx, key, known, last, mtd, month)
        elif g is None:
            s = stats["units"].get(key)
            row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0, reason="no hourly history")
        else:   # daily groups: the stay-on loss at the node against the unit's own cutoff
            prices = ctx.node_price(date, u["sp"], name=u["configs"][0]) if u["sp"] else None
            if prices is None or u["mingen"] is None or not u["lsl"]:
                s = stats["units"].get(key)
                row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0,
                           reason="no day-ahead price at its node" if prices is None else "no costs")
                rows[key] = row
                continue
            lsl = float(u["lsl"])
            margin = (np.asarray(prices, float) - u["mingen"]) * lsl
            loss, bs, nh = _window(-margin)
            days = _decision_rows(ctx, key, known)
            c = _cutoff(days) if days else None
            aw = float(np.mean([d[1] >= HALF for d in days])) if days else 0.0
            _, pool, w = _pool(ctx, date)
            cpm = _blend((c[0] / lsl if c else None, len(days), aw), pool.get(t))
            row["loss"] = round(float(loss))
            if cpm is None:
                if t == "gas_steam" and g in ("seasonal", "multiday"):
                    _seasonal(row, ctx, key, known, last, mtd, month)    # too little to judge on its loss
                    row["reason"] += f" (too few decision days ({len(days)}) for a cutoff)"
                else:
                    s = stats["units"].get(key)
                    row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0,
                               reason=f"too few decision days ({len(days)}) for a cutoff; loss ${loss:,.0f}")
            elif nh <= 0:
                row.update(verdict="on", p_on=1.0, cutoff=round(cpm * lsl), reason="no hour below its minimum-energy cost")
            else:
                cut = cpm * lsl
                mo = _min_off(ctx, date, key, t)
                span = _span(margin, bs, nh)
                s = stats["units"].get(key)
                x = _hourly(_features(margin, lsl, loss, bs, nh, cut, mo, aw, s["on_days"] if s else 0.0), margin, lsl, bs, nh)
                wt = w.get(None)
                Z = _stack(w.get("hist"), _tree_x(x, t, g, date[5:7], loss, lsl), _net(ctx, date, t))
                ph = wt.predict_proba(Z)[:, 1] if wt is not None else np.full(24, float(loss <= cut))
                p_off = (_logit_p_off(w.get("logit") or {}, t, key, _logit_x(x[0], margin, loss, lsl, bs, nh, date, ctx, key))
                         if t in WINDOW_TECHS else None)
                if p_off is not None:       # the trees' P(on) going into the window x the stay-on rule's P(stays on | on)
                    ph = ph.copy(); ph[bs:bs + nh] = ph[bs - 1 if bs > 0 else min(bs + nh, 23)] * (1.0 - p_off)
                p_on = round(float(ph[bs:bs + nh].mean()), 2)
                if p_off is not None:
                    p_in = float(ph[bs:bs + nh].mean()) / max(1.0 - p_off, 1e-9)
                    row["p_base"], row["drivers"] = _logit_drivers(w.get("logit") or {}, t, key,
                                                                   _logit_x(x[0], margin, loss, lsl, bs, nh, date, ctx, key), p_in)
                elif wt is not None:
                    row["p_base"], row["drivers"] = _drivers(wt, Z, bs, nh, float(ph[bs:bs + nh].mean()))
                src = "its cutoff" if c else "the pooled cutoff"
                row.update(cutoff=round(cut), p_on=p_on, p_hours=[round(float(v), 3) for v in ph], win_from=bs + 1, win_hours=nh)
                why = (f"loss ${loss:,.0f} vs {src} ${cut:,.0f} over HE {bs + 1}-{bs + nh}"
                       + (f" (lasting {span} h with the next morning)" if span > nh else "")
                       + f", shortest usual off spell {mo:.0f} h: P(on) {p_on:.0%}"
                       + (f", mostly {row['drivers'][0][0]} ({row['drivers'][0][1] * 100:+.0f} pts)" if row.get("drivers") else ""))
                if p_on < P_OFF:
                    row.update(verdict="off", off_from=bs + 1, off_hours=nh, reason=why)
                elif p_on <= P_ON:
                    row.update(verdict="maybe", off_from=bs + 1, off_hours=nh, reason=why)
                else:
                    row.update(verdict="on", reason=why)
            if u["est"] == 2:
                row["reason"] += " (generic costs)"
        if cleared:
            row["reason"] += f"; on outage for {out_days:.0f} days at the last known hour, no longer in the outage report"
        rows[key] = row
    listed = listed or {}
    nrc = ctx.nrc_off(date)
    for key, row in rows.items():
        if key in nrc and row["verdict"] != "outage":
            row.pop("drivers", None); row.pop("p_base", None)
            row.update(verdict="outage", p_on=0.0, off_from=1, off_hours=24, outage=True,
                       reason=f"reactor at {nrc[key]:.0f}% power in the NRC status report the morning before")
            continue
        share = listed.get(key, 0.0)
        if share >= 1.0 and row["verdict"] != "outage":
            row.pop("p_hours", None); row.pop("drivers", None); row.pop("p_base", None)
            row.update(verdict="outage", p_on=0.0, off_from=1, off_hours=24, outage=True,
                       reason="listed out in ERCOT's unplanned outage report")
        elif share > 0 and row["verdict"] != "outage":
            row["out_share"] = round(share, 3)
            row["reason"] += f"; {share:.0%} of its gas turbines listed out in ERCOT's unplanned outage report"
    zone_mw, pool = defaultdict(float), defaultdict(float)
    for key, row in rows.items():
        z = ctx.zone_of(units[key]["sp"], key) if row["tech"] in UNSEEN_TECHS else None
        row["_zone"] = z
        if z:
            zone_mw[z] += row["hsl"] or 0
            if row["verdict"] != "outage":
                pool[z] += (row["hsl"] or 0) * (1 - row.get("out_share", 0.0))
    unseen = (ctx.unseen_out(date, zone_mw) or {}) if opool is None else {}
    prior = C.outage_prior(UNSEEN_TECHS, date) if unseen else {}
    by_zone = defaultdict(list)
    for key, row in rows.items():
        z = row.pop("_zone")
        if z and row["verdict"] != "outage" and unseen.get(z) and pool[z] > 0:
            free = (row["hsl"] or 0) * (1 - row.get("out_share", 0.0))
            if free > 0:
                by_zone[z].append((key, free, free * (UNSEEN_EPS + prior.get(key, 0.0))))
    for z, units_z in by_zone.items():
        free = {k: f for k, f, _ in units_z}
        for key, mw in _allocate(min(unseen[z], pool[z]), units_z).items():
            row, sh = rows[key], min(1.0, mw / free[key])
            row["unseen_share"] = round(sh, 3)
            row["out_share"] = round(1 - (1 - row.get("out_share", 0.0)) * (1 - sh), 3)
    return {"rows": rows, "outage_pool": opool, "inputs": {"known_date": known, "hindsight": hindsight, "asof": point,
                                     "asof_hindsight": asof_hind, "node_prices": node_src,
                                     "month": month, "month_hub": None if mtd is None else round(mtd, 2)}}
