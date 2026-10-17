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
  an hour charges or discharges, never both: the smaller side is zeroed
  soc[h]  the fleet's energy path, MWh: cumulative charging x EFF minus discharging, shifted so
          its minimum is zero (the fleet at its emptiest); EFF = sum discharged / sum charged
          over the window.  The fleet's energy (sum of maximum state of charge, data/storage,
          60-day) caps the path where known: discharging is scaled down in the hours after the
          cap would be exceeded (input "energy_cap").

Where fewer than MIN_DAYS known days exist, no rows (the page keeps "awaiting").

  python -m pipeline.models.storage_habit 2026-08-17            # one day's rows
  python -m pipeline.models.storage_habit --backtest [--days N]  # MAE table of the rules
"""
import datetime as dt
import gzip
import json

import numpy as np

from ..config import DATA_DIR

NAME = "storage_habit"
VERSION = "v0"

LAG2 = 3              # the 2-day summary for day X is posted on X + 2; the forecast for D is made on D - 1
WINDOW = 60           # days of habit considered
DECAY = 10.0          # weight exp(-age / DECAY) on the habit, age in known days
SHAPE_WINDOW = 30     # days behind the price-rank shape
BLEND = 0.7           # weight on the clock-hour habit; the rest on the price-rank shape
PEAK_FIX = False      # scale the habit so its peak equals the weighted mean daily peak: cuts the peak bias
                      # (-960 to -730 MW) at a small MAE cost (charging 476 to 498 MW); off in v0, the score is MAE
MIN_DAYS = 7


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
    out = predict(habit, date, hub)
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
    """MAE of the rule and of its two parts over the known history; printed as a table."""
    habit = Habit(ctx)
    ds = habit.sorted
    start = max(MIN_DAYS + LAG2, len(ds) - n_days) if n_days else MIN_DAYS + LAG2
    rows = []
    for i in range(start, len(ds)):
        d = ds[i]
        hub, dis, chg = habit.days[d]
        out = predict(habit, d, hub, known=ds[:max(0, i - LAG2 + 1)])
        if out is None:
            continue
        fd, fc = out[0], out[1]
        rows.append((d, np.abs(fd - dis).mean(), np.abs(fc - chg).mean(), (fd.sum() - dis.sum()) / max(dis.sum(), 1.0),
                     fd.max() - dis.max(), fc.max() - chg.max()))
    if not rows:
        print("nothing to backtest"); return
    a = np.array([r[1:] for r in rows], float)
    print(f"{NAME} {VERSION}: {len(rows)} days {rows[0][0]} to {rows[-1][0]}, forecasts from 2-day summaries up to D-{LAG2}")
    print(f"  discharging MAE {a[:, 0].mean():.0f} MW/h, charging MAE {a[:, 1].mean():.0f} MW/h, "
          f"daily discharge GWh error median {np.median(np.abs(a[:, 2])):.1%}, peak discharge bias {a[:, 3].mean():+.0f} MW, peak charging bias {a[:, 4].mean():+.0f} MW")
    for lo, hi, lab in ((0, 90, "first 90 days"), (len(rows) - 90, len(rows), "last 90 days")):
        if hi > lo >= 0:
            b = a[lo:hi]
            print(f"  {lab}: discharging MAE {b[:, 0].mean():.0f}, charging MAE {b[:, 1].mean():.0f}")


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
