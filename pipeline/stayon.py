"""Stay on or shut down: what thermal units earned or lost by running through cheap stretches,
against what a shutdown and restart would have cost.  Needs no downloads.  Read by trends.html.

A cheap stretch is a run of consecutive hours (across consecutive days) with system lambda
below a threshold (intraday.CHEAP).  A unit "rode through" a stretch when it was running in
every hour of it and in the hour before and the hour after.  For each such unit and stretch:

  revenue   sum over the stretch of output x system lambda ($)
  cost      sum of output x minimum-energy cost ($): the DAM three-part offer's $/MWh at
            minimum output, applied to all MW produced (output above minimum is usually small
            in these hours; the unit's incremental offer would be a closer cost for it)
  loss      cost - revenue (positive when running through lost money against lambda)
  start     the cost of restarting after the stretch: the DAM hot start cost when the stretch
            is at most HOT_H hours, intermediate up to INTER_H, cold beyond (ERCOT's own
            hot / intermediate / cold boundaries are set per unit by the QSE and not disclosed)
  saves     loss - start: what shutting down for the stretch would have saved (negative when
            staying on was the cheaper choice)

Costs come from the unit's DAM three-part offer that day (data/dam/).  A unit with none that
day uses its own most recent offer within COST_DAYS days (est = 1), or the technology's
generic value from config.GENERIC_COSTS (est = 2).  Lambda is the system price, not the unit's
node price, so congestion is not in these numbers.

Writes data/stayon_60d.json.gz:
  dates, cheap (thresholds), min_hours, hot_h, inter_h
  stretches[thr]      [start date, start hour ending, hours, mean lambda]
  rides               [unit, tech, thr, stretch index, MWh, revenue, cost, loss, start, saves, est]
  tech[thr][tech]     {n: ride-throughs, mwh, loss, saves_pos: total of positive saves,
                       share_saves_pos: share of ride-throughs where shutting down would have
                       paid, est_share: share using estimated costs}
  costs               daily medians by technology from the DAM summaries:
                      {tech: {start_hot: [day], start_inter: [day], start_cold: [day],
                              mingen: [day], n_offer: [day]}} (null where no DAM file)
"""
import numpy as np

from .config import DATA_DIR, GENERIC_COSTS, UNIT_DATA_DIR
from .intraday import CHEAP
from .store import read_json_gz, write_json_gz
from .trends import UNIT_TECHS

MIN_HOURS = 2       # shortest stretch kept
HOT_H = 8           # a stretch up to this long is followed by a hot start, ...
INTER_H = 24        # ... up to this long an intermediate start, longer a cold start
COST_DAYS = 10      # how far back a unit's own DAM costs are carried when a day has none


def _r(x, nd=0):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _costs_by_day(dates):
    """{date: {unit: (hot, inter, cold, mingen, tech)}} from the DAM day files, and the daily
    technology medians for the trend series."""
    by_day, series = {}, {t: {k: [] for k in ("start_hot", "start_inter", "start_cold", "mingen", "n_offer")}
                          for t in UNIT_TECHS}
    summ = read_json_gz(DATA_DIR / "summary_dam.json.gz", default={})
    for d in dates:
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz")
        if dd:
            by_day[d] = {name: (u["start"][0], u["start"][1], u["start"][2], u["mingen"], u["tech"])
                         for name, u in dd["units"].items()
                         if u.get("mingen") is not None or any(x is not None for x in u.get("start", []))}
        s = summ.get(d) or {}
        for t in UNIT_TECHS:
            e = s.get(t) or {}
            for k in ("start_hot", "start_inter", "start_cold", "mingen"):
                q = e.get(k)
                series[t][k].append(q[1] if q else None)
            series[t]["n_offer"].append(e.get("n_offer"))
    return by_day, series


def _unit_costs(by_day, dates, di, name, tech):
    """(hot, inter, cold, mingen, est) for a unit on day index di."""
    for back in range(0, COST_DAYS + 1):
        if di - back < 0:
            break
        c = by_day.get(dates[di - back], {}).get(name)
        if c and c[3] is not None:
            hot, inter, cold = (c[0] if c[0] is not None else 0.0, c[1] if c[1] is not None else c[0] or 0.0,
                                c[2] if c[2] is not None else c[1] or c[0] or 0.0)
            return hot, inter, cold, c[3], (0 if back == 0 else 1)
    g = GENERIC_COSTS.get(tech)
    if g is None:
        return None
    return g[0], g[1], g[2], g[3], 2


def build_stayon(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    D = len(dates)
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    lam = np.full((D, 24), np.nan)
    for i, d in enumerate(dates):
        v = (prices.get(d) or {}).get("lambda") or []
        for h in range(min(24, len(v))):
            if v[h] is not None:
                lam[i, h] = v[h]
    strips = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}).get("units", {})
    day_no = np.array([int(np.datetime64(d).astype(int)) for d in dates])
    consecutive = np.r_[False, np.diff(day_no) == 1] if D else np.zeros(0, bool)

    # cheap stretches per threshold, as (start day index, start hour, hours)
    stretches = {}
    for thr in CHEAP:
        found, cur = [], None
        for i in range(D):
            if i > 0 and not consecutive[i] and cur:
                found.append(cur)
                cur = None
            for h in range(24):
                cheap = np.isfinite(lam[i, h]) and lam[i, h] < thr
                if cheap:
                    if cur is None:
                        cur = [i, h, 0, 0.0]
                    cur[2] += 1
                    cur[3] += lam[i, h]
                elif cur:
                    found.append(cur)
                    cur = None
        if cur:
            found.append(cur)
        stretches[thr] = [s for s in found if s[2] >= MIN_HOURS]

    costs_by_day, cost_series = _costs_by_day(dates)

    def running(name, i, h):
        s = strips.get(name)
        return bool(s) and i * 24 + h < len(s) and s[i * 24 + h] in "ma"

    # hourly output and technology per unit come from the per-unit day files; a few days are
    # kept in memory at a time
    rides = []
    agg = {thr: {t: [0, 0.0, 0.0, 0.0, 0, 0] for t in UNIT_TECHS} for thr in CHEAP}   # n, mwh, loss, saves+, n_saves+, n_est
    cache = {}

    def day_units(i):
        if i not in cache:
            ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{dates[i]}.json.gz")
            cache[i] = {n: (u["tech"], u.get("out")) for n, u in (ud or {}).get("units", {}).items()}
            while len(cache) > 5:                       # drop the least recently loaded day
                cache.pop(next(iter(cache)))
        return cache[i]

    for thr, found in stretches.items():
        for si, (i0, h0, n_h, lam_sum) in enumerate(found):
            hours = [divmod(i0 * 24 + h0 + k, 24) for k in range(n_h)]
            before, after = divmod(i0 * 24 + h0 - 1, 24), divmod(i0 * 24 + h0 + n_h, 24)
            if before[0] < 0 or after[0] >= D:
                continue
            for name in strips:
                if not all(running(name, i, h) for i, h in hours):
                    continue
                if not (running(name, *before) and running(name, *after)):
                    continue
                mwh = rev = 0.0
                tech, ok = None, True
                for i, h in hours:
                    tu = day_units(i).get(name)
                    if not tu or not tu[1] or tu[1][h] is None or not np.isfinite(lam[i, h]):
                        ok = False
                        break
                    tech = tu[0]
                    mwh += tu[1][h]
                    rev += tu[1][h] * lam[i, h]
                if not ok or mwh <= 0 or tech not in UNIT_TECHS:
                    continue
                c = _unit_costs(costs_by_day, dates, i0, name, tech)
                if c is None:
                    continue
                hot, inter, cold, mingen, est = c
                cost = mwh * mingen
                loss = cost - rev
                start = hot if n_h <= HOT_H else inter if n_h <= INTER_H else cold
                saves = loss - start
                rides.append([name, tech, thr, si, _r(mwh), _r(rev), _r(cost), _r(loss), _r(start), _r(saves), est])
                a = agg[thr][tech]
                a[0] += 1
                a[1] += mwh
                a[2] += loss
                if saves > 0:
                    a[3] += saves
                    a[4] += 1
                if est:
                    a[5] += 1

    tech_out = {str(thr): {t: {"n": a[0], "mwh": _r(a[1]), "loss": _r(a[2]), "saves_pos": _r(a[3]),
                               "share_saves_pos": _r(a[4] / a[0], 3) if a[0] else None,
                               "est_share": _r(a[5] / a[0], 3) if a[0] else None}
                           for t, a in agg[thr].items()} for thr in CHEAP}
    write_json_gz(DATA_DIR / "stayon_60d.json.gz", {
        "dates": dates, "cheap": CHEAP, "min_hours": MIN_HOURS, "hot_h": HOT_H, "inter_h": INTER_H,
        "cost_days": COST_DAYS,
        "stretches": {str(thr): [[dates[i0], h0 + 1, n_h, _r(s / n_h, 2)] for i0, h0, n_h, s in found]
                      for thr, found in stretches.items()},
        "rides": rides, "tech": tech_out, "costs": cost_series,
    })
    n_dam = sum(1 for d in dates if d in costs_by_day)
    print(f"stayon_60d: {D} days, {n_dam} with DAM costs, "
          + ", ".join(f"{len(v)} stretches below ${thr}" for thr, v in stretches.items())
          + f", {len(rides)} ride-throughs")
