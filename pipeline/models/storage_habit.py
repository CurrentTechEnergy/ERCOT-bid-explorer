"""Batteries, fleet level: how much the fleet discharges and charges each hour, from its habit.

The fleet's recent actuals, ERCOT's 2-day generation summary (sum of ESR base points, split into
discharging and charging), carry most of the signal: the fleet discharges into the evening peak
and charges through the solar hours, on a clock that moves slowly, while the fleet itself grows
month by month.  The day-ahead hub price shape adds a little: on a given day the cheapest hours
charge and the dearest discharge.  Tested on 243 days (Dec 2025 to Oct 2026, pipeline.models
.storage_habit --backtest): a trailing clock-hour mean is off by about 440 MW an hour on
discharging; a price-rank shape alone by 560 MW; the 70 / 30 blend used here by 430 MW
(charging 480 MW).  The day's price spread adds nothing measurable to the fleet's peak.

  dis[h]  = BLEND x habit_dis[h] + (1 - BLEND) x peak_dis x shape_dis[rank(hub[h])]
  chg[h]  = the same for charging (held positive here, written negative into the forecast)
  habit   the clock-hour mean over the last WINDOW known days, weighted exp(-age / DECAY),
          scaled so its peak equals the weighted mean of the daily peaks (a mean of days whose
          peak hours differ sits below any one day's peak)
  shape   the mean share of the day's peak by hour rank in the day-ahead hub price (0 =
          cheapest) over the last SHAPE_WINDOW known days; peak = the mean daily peak
  known   2-day summaries posted before the day cleared: operating days up to D - LAG2
  v0 only: an hour charges or discharges, never both (the smaller side is zeroed); v1 keeps both,
          as the fleet does (see predict_v1)
  soc[h]  the fleet's energy path, MWh: cumulative charging x EFF minus discharging, shifted so
          its minimum is zero (the fleet at its emptiest); EFF = sum discharged / sum charged
          over the window.  The fleet's energy (sum of maximum state of charge, data/storage,
          60-day) caps the path where known: discharging is scaled down in the hours after the
          cap would be exceeded (input "energy_cap").

v1 (Oct 20, 2026) corrects that rule with boosted trees, one for discharging and one for
charging (scikit-learn, as thermal_cutoff), fitted on the fleet's known days: each training row is
one hour of one known day, with the rule's own value for it, the hour, the day-ahead hub price at
the hour and either side of it, its rank in the day, the day's max, min and mean, the mean daily
peak over the last 7 known days, month and weekday; the label is the 2-day summary's MW.  The
trees are refit every REFIT days on the days known at the block's start, so a block of days
shares one fit and the forecast for D only uses 2-day summaries public before D.  With fewer
than MIN_TRAIN known days the v0 rule is used and the inputs say so.  Backtest, last 154 days:
discharging MAE 389 -> 361 MW, charging 472 -> 428 MW, daily discharge GWh error (median)
18.4% -> 10.7%, charging 11.6% -> 8.7%, peak discharge bias -790 -> -620 MW; the evening peak
stays the largest error (about 1.5 GW).

Where fewer than MIN_DAYS known days exist, no rows (the page keeps "awaiting").

  python -m pipeline.models.storage_habit 2026-08-17            # one day's rows
  python -m pipeline.models.storage_habit --backtest [--days N]  # MAE table, v1 against the v0 rule
"""
import datetime as dt
import gzip
import json

import numpy as np

from ..config import DATA_DIR

NAME = "storage_habit"
VERSION = "v1"

LAG2 = 3              # the 2-day summary for day X is posted on X + 2; the forecast for D is made on D - 1
WINDOW = 60           # days of habit considered
DECAY = 10.0          # weight exp(-age / DECAY) on the habit, age in known days
SHAPE_WINDOW = 30     # days behind the price-rank shape
BLEND = 0.7           # weight on the clock-hour habit; the rest on the price-rank shape
PEAK_FIX = False      # scale the habit so its peak equals the weighted mean daily peak: cuts the peak bias
                      # (-960 to -730 MW) at a small MAE cost (charging 476 to 498 MW); off in v0, the score is MAE
MIN_DAYS = 7
REFIT = 14            # days per tree fit; every day in a block uses the fit made at its start
MIN_TRAIN = 60        # known days needed before the trees are used; fewer, the v0 rule alone
GBT = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, min_samples_leaf=40,
           early_stopping=False, random_state=0)
EPOCH = dt.date(2025, 12, 1)
FEATS = ("rule", "rule_other", "h", "hub", "hub_prev", "hub_next", "rank", "hub_max", "hub_min", "hub_mean",
         "peak7", "month", "dow")


def _arr(v):
    return np.array([np.nan if x is None else float(x) for x in (v or [None] * 24)][:24], float)


def _d(s):
    return dt.date.fromisoformat(s)


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _rl(a, nd=1):
    return [_r(v, nd) for v in a]


def actuals(date):
    """(discharging[24], charging[24]) MW, both positive, from the 2-day summary; None when absent."""
    p = DATA_DIR / "2dgen" / f"{date}.json.gz"
    if not p.exists():
        return None
    with gzip.open(p, "rt") as f:
        h = json.load(f).get("hourly", {})
    if not h.get("sum_base_point_esr_charging") or not h.get("sum_base_point_esr_discharging"):
        return None
    dis, chg = _arr(h["sum_base_point_esr_discharging"]), -_arr(h["sum_base_point_esr_charging"])
    if np.isnan(dis).any() or np.isnan(chg).any():
        return None
    return dis, chg


class Habit:
    """The fleet's known actuals with their day-ahead hub prices, loaded once per run."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.days = {}
        for d in sorted(ctx.index["days"].get("2dgen", [])):
            a = actuals(d)
            hub = ctx.hub(d)
            if a is None or hub is None:
                continue
            self.days[d] = (np.asarray(hub, float), a[0], a[1])
        self.sorted = sorted(self.days)
        self._rows = {}       # day -> (X[24, n], dis, chg): the rule's features, fixed once known
        self._fits = {}       # block start -> (dis model, chg model, n days, block start) or None

    def known(self, date):
        cut = (_d(date) - dt.timedelta(days=LAG2)).isoformat()
        return [d for d in self.sorted if d <= cut]


def _ranks(h):
    return np.argsort(np.argsort(h))


def _energy_cap(ctx, date):
    """The fleet's energy, MWh: the sum of maximum state of charge in the latest 60-day battery
    day public before `date`, else None."""
    days = sorted(ctx.index["days"].get("storage", []))
    cut = (_d(date) - dt.timedelta(days=60)).isoformat()
    ok = [d for d in days if d <= cut]
    if not ok:
        return None, None
    p = DATA_DIR / "storage" / f"{ok[-1]}.json.gz"
    if not p.exists():
        return None, None
    with gzip.open(p, "rt") as f:
        st = json.load(f)
    smax = _arr(st["fleet"].get("soc_max"))
    v = float(np.nanmax(smax)) if np.isfinite(smax).any() else None
    return (v if v and v > 0 else None), ok[-1]


def predict(habit: Habit, date, hub, known=None):
    """The rule applied to one day: (dis, chg, inputs) or None when too little is known."""
    known = habit.known(date) if known is None else known
    if len(known) < MIN_DAYS or hub is None:
        return None
    win = known[-WINDOW:]
    A = np.array([habit.days[d][1] for d in win]); B = np.array([habit.days[d][2] for d in win])
    age = np.arange(len(win))[::-1].astype(float)
    w = np.exp(-age / DECAY); w /= w.sum()
    habit_dis, habit_chg = (A * w[:, None]).sum(0), (B * w[:, None]).sum(0)
    if PEAK_FIX:
        if habit_dis.max() > 0:
            habit_dis = habit_dis * ((A.max(1) * w).sum() / habit_dis.max())
        if habit_chg.max() > 0:
            habit_chg = habit_chg * ((B.max(1) * w).sum() / habit_chg.max())
    sw = known[-SHAPE_WINDOW:]
    sd, sc, pd, pc = np.zeros(24), np.zeros(24), [], []
    for d in sw:
        h, dis, chg = habit.days[d]
        r = _ranks(h)
        sd[r] += dis / max(dis.max(), 1.0); sc[r] += chg / max(chg.max(), 1.0)
        pd.append(dis.max()); pc.append(chg.max())
    sd /= len(sw); sc /= len(sw)
    r = _ranks(np.asarray(hub, float))
    shape_dis, shape_chg = float(np.mean(pd)) * sd[r], float(np.mean(pc)) * sc[r]
    dis = BLEND * habit_dis + (1 - BLEND) * shape_dis
    chg = BLEND * habit_chg + (1 - BLEND) * shape_chg
    both = (dis > 0) & (chg > 0)
    keep_dis = dis >= chg
    dis = np.where(both & ~keep_dis, 0.0, dis); chg = np.where(both & keep_dis, 0.0, chg)
    eff = float(A.sum() / B.sum()) if B.sum() > 0 else 0.85
    eff = min(max(eff, 0.5), 1.0)
    inputs = {"known_through": known[-1], "n_known": len(win), "n_shape": len(sw), "window": WINDOW, "decay": DECAY,
              "shape_window": SHAPE_WINDOW, "blend": BLEND, "peak_fix": PEAK_FIX, "eff": round(eff, 3),
              "habit_peak_dis": _r(habit_dis.max()), "habit_peak_chg": _r(habit_chg.max())}
    return dis, chg, eff, inputs


def _features(habit: Habit, date, hub, known, rule):
    """X[24, len(FEATS)] for each side: the rule's value for that side and the other, plus the
    day-ahead price shape."""
    hub = np.asarray(hub, float)
    r = _ranks(hub)
    pk = float(np.mean([habit.days[k][1].max() for k in known[-7:]]))
    pc = float(np.mean([habit.days[k][2].max() for k in known[-7:]]))
    d = _d(date)
    out = []
    for side, peak in ((0, pk), (1, pc)):
        X = np.zeros((24, len(FEATS)))
        for h in range(24):
            X[h] = (rule[side][h], rule[1 - side][h], h, hub[h], hub[max(h - 1, 0)], hub[min(h + 1, 23)], r[h],
                    hub.max(), hub.min(), hub.mean(), peak, d.month, d.weekday())
        out.append(X)
    return out


def _train_row(habit: Habit, d):
    """A known day as training rows: its features as the forecast would have seen them, and its actuals."""
    if d not in habit._rows:
        hub, dis, chg = habit.days[d]
        known = habit.known(d)
        p = predict(habit, d, hub, known=known)
        habit._rows[d] = None if p is None else (_features(habit, d, hub, known, p[:2]), dis, chg)
    return habit._rows[d]


def _fit(habit: Habit, date):
    """The trees for the REFIT-day block holding `date`, fitted on the days known at its start."""
    start = EPOCH + dt.timedelta(days=(_d(date) - EPOCH).days // REFIT * REFIT)
    key = start.isoformat()
    if key not in habit._fits:
        rows = [r for r in (_train_row(habit, d) for d in habit.known(key)) if r is not None]
        if len(rows) < MIN_TRAIN:
            habit._fits[key] = None
        else:
            from sklearn.ensemble import HistGradientBoostingRegressor
            Xd = np.vstack([r[0][0] for r in rows]); Xc = np.vstack([r[0][1] for r in rows])
            yd = np.concatenate([r[1] for r in rows]); yc = np.concatenate([r[2] for r in rows])
            habit._fits[key] = (HistGradientBoostingRegressor(**GBT).fit(Xd, yd),
                                HistGradientBoostingRegressor(**GBT).fit(Xc, yc), len(rows), key)
    return habit._fits[key]


def predict_v1(habit: Habit, date, hub, known=None):
    """v1: the rule corrected by the trees; the rule alone (inputs say so) until MIN_TRAIN days are known."""
    known = habit.known(date) if known is None else known
    out = predict(habit, date, hub, known=known)
    if out is None:
        return None
    dis, chg, eff, inputs = out
    fit = _fit(habit, date)
    if fit is None:
        inputs["trees"] = None
        return dis, chg, eff, inputs
    Xd, Xc = _features(habit, date, hub, known, (dis, chg))
    # no "one direction per hour" here: the fleet is a sum of batteries, and in the 2-day summaries
    # some charge while others discharge in 99.8% of hours; zeroing the smaller side cost v1 about
    # 25 MW an hour and doubled its daily GWh error
    dis = np.clip(fit[0].predict(Xd), 0, None); chg = np.clip(fit[1].predict(Xc), 0, None)
    inputs["trees"] = {"fit_on": fit[3], "n_days": fit[2], "refit_days": REFIT}
    return dis, chg, eff, inputs


def _soc_path(dis, chg, eff, cap):
    """The energy path and, where a cap binds, the discharging the fleet can actually deliver."""
    dis = dis.copy()
    for _ in range(3):
        net = chg * eff - dis
        path = np.cumsum(net)
        path = path - path.min()
        if cap is None or path.max() <= cap + 1e-6:
            return path, dis, False
        # too much energy cycles for the fleet's size: scale discharging and charging together
        f = cap / path.max()
        dis *= f; chg = chg * f
    return path, dis, True


def forecast(date, ctx, habit: Habit = None) -> dict:
    habit = habit or getattr(ctx, "_storage_habit", None)
    if habit is None:
        habit = ctx._storage_habit = Habit(ctx)
    hub = ctx.hub(date)
    out = predict_v1(habit, date, hub)
    if out is None:
        return {"rows": None, "inputs": {"reason": "fewer than %d known 2-day summaries" % MIN_DAYS if hub is not None else "no hub prices"}}
    dis, chg, eff, inputs = out
    cap, cap_day = _energy_cap(ctx, date)
    soc, dis, capped = _soc_path(dis, chg, eff, cap)
    inputs.update({"energy_cap_mwh": _r(cap, 0), "energy_cap_day": cap_day, "capped": capped})
    rows = {"dis": _rl(dis), "chg": _rl(-chg), "soc": _rl(soc, 0),
            "gwh_dis": _r(dis.sum() / 1000, 2), "gwh_chg": _r(chg.sum() / 1000, 2),
            "peak_dis": _r(dis.max()), "peak_chg": _r(chg.max()),
            "model": NAME, "version": VERSION}
    return {"rows": rows, "inputs": inputs}


def backtest(ctx, n_days=None):
    """MAE of v1 and of the v0 rule over the known history; printed as a table."""
    habit = Habit(ctx)
    ds = habit.sorted
    start = max(MIN_DAYS + LAG2, len(ds) - n_days) if n_days else MIN_DAYS + LAG2
    res = {"v0 rule": [], VERSION: []}
    for i in range(start, len(ds)):
        d = ds[i]
        hub, dis, chg = habit.days[d]
        known = ds[:max(0, i - LAG2 + 1)]
        for lab, fn in (("v0 rule", predict), (VERSION, predict_v1)):
            out = fn(habit, d, hub, known=known)
            if out is None or (lab == VERSION and out[3].get("trees") is None):
                continue
            fd, fc = out[0], out[1]
            res[lab].append((d, np.abs(fd - dis).mean(), np.abs(fc - chg).mean(),
                             abs(fd.sum() - dis.sum()) / max(dis.sum(), 1.0), abs(fc.sum() - chg.sum()) / max(chg.sum(), 1.0),
                             fd.max() - dis.max(), abs(fd.max() - dis.max())))
    days = {r[0] for r in res[VERSION]}
    if not days:
        print("nothing to backtest"); return
    print(f"{NAME}: {len(days)} days {min(days)} to {max(days)} (days with trees), forecasts from 2-day summaries up to D-{LAG2}")
    for lab in ("v0 rule", VERSION):
        a = np.array([r[1:] for r in res[lab] if r[0] in days], float)
        print(f"  {lab:8s} discharging MAE {a[:, 0].mean():.0f} MW/h, charging MAE {a[:, 1].mean():.0f} MW/h, "
              f"daily GWh error (median) discharging {np.median(a[:, 2]):.1%} charging {np.median(a[:, 3]):.1%}, "
              f"peak discharge bias {a[:, 4].mean():+.0f} MW, abs error {a[:, 5].mean():.0f} MW")


def main(argv=None):
    import argparse
    import sys
    from ..store import load_index
    from ..forecast import context as C
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("date", nargs="?", help="one day's rows, printed")
    ap.add_argument("--backtest", action="store_true")
    ap.add_argument("--days", type=int, help="backtest only the last N days")
    args = ap.parse_args(argv)
    ctx = C.Context(load_index())
    if args.backtest:
        backtest(ctx, args.days)
        return 0
    if not args.date:
        ap.print_help(); return 2
    out = forecast(args.date, ctx)
    json.dump(out, sys.stdout, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
