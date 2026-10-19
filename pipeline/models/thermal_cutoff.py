"""Commitment: which thermal units are expected on for the day, judged on the day's own
economics, never on a price level.

For every thermal train in the latest DAM disclosure (pipeline.forecast.context.Context.units):

  outage      its last known hourly state (the latest 60-day day public before the day's
              day-ahead market cleared, so about sixty days old) is outage and the outage had
              already lasted LONG_OUT days or more by then: expected off all day.  A shorter
              outage sixty days ago says little about today (most are over), so it is ignored
              and the unit is judged like any other
  nuclear     on (output at HSL) unless on outage
  never       the never-off group: on
  daily       loss = the worst contiguous window of (minimum-energy cost - day-ahead price at
              the unit's node) x LSL over the day, in $ (pipeline.decisions._window).  v1 turns
              it into p_on, the probability the unit stays on through that window: a logistic
              fitted per technology on the decision days up to the asof point, from
                - the loss over the unit's cutoff, per MW of LSL.  The cutoff is the unit's own
                  (pipeline.decisions._cutoff, on its decision days before this day) pulled
                  toward its technology's pooled cutoff by POOL_K / (decision days + POOL_K);
                  a unit without its own but with POOL_MIN decision days gets the pooled one
                - the window's length against the unit's 10th-percentile off spell (log ratio;
                  MIN_OFF_DEFAULT without one).  A window reaching HE24 runs on into the next
                  morning while the margin stays negative there, with the day's own early-hour
                  prices standing in for the next day's, which are not known yet
                - the margin the unit earns before and after the window, per MW
                - the unit's award history share (the day's own award is not public yet)
              "off" below P_OFF, "maybe" up to P_ON, "on" above.  A daily unit with no cutoff
              at all ("nocut") gets p_on = its share of days with any online hour.
  seasonal, multiday
              rule v0 (SEASONAL_VERSION): on when the unit was running at its last known hour
              and the month's day-ahead hub average to date is not below the lowest monthly
              hub average it has run through; off otherwise.  A placeholder until a
              multi-week economics rule exists.
  peakers     combustion turbines are not judged here (peaker_share, by hour); they get
              verdict "peaker" and p_on from that model.

p_on is the weight the dispatch model applies to the unit's MW: 1 for on, 0 for off, the
history share for nocut, and for a daily unit judged on its window the probability above,
here by hour: the logistic is fitted on the window's unit-hours, with each hour's own margin and
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
import numpy as np

from ..config import DATA_DIR
from ..store import read_json_gz

from ..decisions import _window, _cutoff, _dam_trains, HALF, OUT_MIN_H
from ..forecast import context as C

NAME = "thermal_cutoff"
VERSION = "v1"    # v1: probability of staying on through the window, per-unit horizon, pooled cutoffs
SEASONAL_VERSION = "v0"
RUN_SHARE = 0.5          # a month the unit ran through: online at least this share of its hours
LONG_OUT = 21            # days an outage must already have lasted at the last known hour to carry forward
MIN_OFF_DEFAULT = {"combined_cycle": 7.0, "gas_steam": 16.0, "coal": 24.0}   # hours, without a p10 of its own
POOL_K = 15              # decision days at which a unit's own cutoff and the pooled one weigh the same
POOL_MIN = 3             # decision days a unit needs for a pooled cutoff
P_OFF, P_ON = 0.3, 0.7   # p_on below P_OFF is "off", above P_ON "on", between "maybe"
DAILY_TECHS = ("combined_cycle", "gas_steam", "coal")
RIDGE = 1.0              # L2 penalty of the logistic fit (features are scaled to about unit size)


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
    """The logistic's inputs for one unit-day: loss over the cutoff ($/MW of LSL, /100), the
    window's wrapped length against the unit's shortest usual off spell (log ratio), the margin
    earned before and after the window ($/MW, /100), the unit's award history share and its
    share of days with any online hour."""
    before = float(np.clip(margin[:bs], 0, None).sum()) / lsl
    after = float(np.clip(margin[bs + nh:], 0, None).sum()) / lsl
    span = _span(margin, bs, nh)
    return [1.0, (loss - cut) / lsl / 100.0, float(np.log(max(span, 1) / min_off)), before / 100.0, after / 100.0,
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


def _logit(X, y):
    """Ridge-penalised logistic regression by Newton steps; the intercept is not penalised."""
    X, y = np.asarray(X, float), np.asarray(y, float)
    w = np.zeros(X.shape[1])
    pen = np.full(X.shape[1], RIDGE); pen[0] = 0.0
    for _ in range(50):
        z = np.clip(X @ w, -30, 30)
        p = 1.0 / (1.0 + np.exp(-z))
        g = X.T @ (p - y) + pen * w
        H = (X * (p * (1 - p))[:, None]).T @ X + np.diag(pen) + 1e-9 * np.eye(X.shape[1])
        step = np.linalg.solve(H, g)
        w -= step
        if np.abs(step).max() < 1e-6:
            break
    return w


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
    X, y, T = [], [], []
    for d, trains in _day_trains(ctx).items():
        if point is not None and d > point:
            continue
        dn = (C._d(d) - day0).days
        for key, (tech, spp, mg, lsl) in trains.items():
            if not str(groups.get(key) or "").startswith("daily") or key not in own:
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
            X.append(_hourly(f, margin, lsl, bs, nh)); y.append(np.isin(seg, ["m", "a"]).astype(float)); T += [tech] * 24
    X = np.vstack(X) if X else np.zeros((0, 0))
    y, T = (np.concatenate(y) if y else np.zeros(0)), np.array(T)
    w = {}
    if len(y):
        w[None] = _logit(X, y)
        for t in set(T):
            m = T == t
            w[t] = _logit(X[m], y[m]) if m.sum() >= 24 * 200 else w[None]
    cache[point] = (own, pool, w)
    return cache[point]


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
    mtd, month = ctx.month_to_date_hub(date)
    node_src = ctx.node_source(date)
    rows = {}
    for key, u in units.items():
        t = u["tech"]
        if t not in C.THERMAL:
            continue
        g = "never" if t == "nuclear" else groups.get(key)
        last, out_days = _last_state(ctx, key, known)
        if last == "o" and out_days < LONG_OUT:
            last = "0"       # a short outage sixty days ago: treated as off then, judged normally
        row = {"tech": t, "group": g, "hsl": u["hsl"], "lsl": u["lsl"], "outage": last == "o",
               "verdict": None, "p_on": 0.0, "loss": None, "cutoff": None, "off_from": None, "off_hours": 0,
               "reason": "", "model": NAME, "version": VERSION}
        if last == "o":
            row.update(verdict="outage", reason=f"on outage for {out_days:.0f} days at the last known hour ({known})")
        elif t == "nuclear" or g == "never":
            row.update(verdict="on", p_on=1.0, reason="never off" if g == "never" else "nuclear")
        elif t == "combustion_turbine":
            row.update(verdict="peaker", reason="judged by hour (peaker_share)")
        elif g in ("seasonal", "multiday"):
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
                wt = w.get(t, w.get(None))
                ph = 1.0 / (1.0 + np.exp(-np.clip(x @ wt, -30, 30))) if wt is not None else np.full(24, float(loss <= cut))
                p_on = round(float(ph[bs:bs + nh].mean()), 2)
                src = "its cutoff" if c else "the pooled cutoff"
                row.update(cutoff=round(cut), p_on=p_on, p_hours=[round(float(v), 3) for v in ph], win_from=bs + 1, win_hours=nh)
                why = (f"loss ${loss:,.0f} vs {src} ${cut:,.0f} over HE {bs + 1}-{bs + nh}"
                       + (f" (lasting {span} h with the next morning)" if span > nh else "")
                       + f", shortest usual off spell {mo:.0f} h: P(on) {p_on:.0%}")
                if p_on < P_OFF:
                    row.update(verdict="off", off_from=bs + 1, off_hours=nh, reason=why)
                elif p_on <= P_ON:
                    row.update(verdict="maybe", off_from=bs + 1, off_hours=nh, reason=why)
                else:
                    row.update(verdict="on", reason=why)
            if u["est"] == 2:
                row["reason"] += " (generic costs)"
        rows[key] = row
    return {"rows": rows, "inputs": {"known_date": known, "hindsight": hindsight, "asof": point,
                                     "asof_hindsight": asof_hind, "node_prices": node_src,
                                     "month": month, "month_hub": None if mtd is None else round(mtd, 2)}}
