"""Which units are on the margin at their own node, read from the per-unit day files.  Needs
no downloads.

A unit is marginal in an hour when SCED dispatched it to the interior of its own submitted
offer curve: its base point sits strictly between its minimum and maximum (LSL and HSL, and
the curve's first and last MW) on a segment with some width, rather than pinned at a limit
or on a vertical step.  The curve's price at that base point is then the price SCED saw at
the unit's node, so every marginal unit-hour carries an implied LMP without the price file.

The implied price is compared with system lambda over the hour (its min to max, widened by
BAND):
  at lambda   the implied price lies in that range: the unit is setting the system price
  below       the implied price is below it: the unit sits behind an export constraint
              (its node is cheaper than the system; wind and solar at negative prices)
  above       the implied price is above it: the unit is on the load side of a constraint
              (its node is dearer than the system)

Base points are hourly means (the per-unit files keep no per-run base point), so each hour is
scored on its means: base point against the mean HSL and LSL over the runs the unit was
online, on the curve in force for most of them.  A unit that swings between its limits inside
an hour, or one held by its ramp rate, can still read as marginal; the comparison with the
published node price (days with node prices) shows how much that blurs.  Storage is left out:
a battery's hourly mean base point (charging and discharging averaged) says nothing about
where it sat on its curve.

Writes data/marginal_nodes.json.gz:
  dates, has_nodes, band, tol (fraction of HSL), min_online (share of the hour's runs)
  hours      columns / rows: [date, hour, lambda, tech, n_at, n_below, n_above,
             mw_at, mw_below, mw_above] (units on the margin and their base point MW)
  units      the units most often marginal away from lambda: [name, tech, sp, hours online
             with a curve, h_at, h_below, h_above, mean implied price when marginal, mean
             node price in those hours (days with node prices), n such hours, mean HSL]
  valid      implied price against the published node price for marginal unit-hours:
             n, median_abs (|difference|), within5, within10 (shares), the same per class in
             by_class {at, below, above}, and sample [[implied, node, tech, lambda, class
             0 at / 1 below / 2 above], ...] (at most SAMPLE points)
  n_units    per tech: units ever marginal
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR, SIXTY_DAY_TECHS

TECHS = [t for t in SIXTY_DAY_TECHS if t != "storage"]   # a battery's hourly mean base point says nothing about its margin
from .intraday import _online
from .nodes import settlement_points
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

BAND = 2.0            # $/MWh added each side of the hour's lambda range for "at lambda"
TOL = 0.05            # of HSL: distance from a limit that still counts as pinned (at least TOL_MW)
TOL_MW = 2.0
STEP_MW = 1.0         # a curve segment narrower than this is a vertical step, not a margin
MIN_ONLINE = 0.9      # share of the hour's runs the unit must be online with a curve
TOP_UNITS = 60
SAMPLE = 4000


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def price_at(P: np.ndarray, M: np.ndarray, b: np.ndarray):
    """For each row (a curve, NaN padded, MW non-decreasing) the curve price at MW b[row] and
    whether b lies on a segment of positive width strictly inside the curve.
    Returns (price, interior) arrays."""
    valid = ~np.isnan(P) & ~np.isnan(M)
    npts = valid.sum(axis=1)
    Mv = np.where(valid, M, np.inf)
    k = (Mv < b[:, None]).sum(axis=1)                 # first point with MW >= b
    n, kmax = P.shape
    inside = (k > 0) & (k < npts)
    kc = np.clip(k, 1, kmax - 1)
    rows = np.arange(n)
    m0, m1 = M[rows, kc - 1], M[rows, kc]
    p0, p1 = P[rows, kc - 1], P[rows, kc]
    width = m1 - m0
    with np.errstate(invalid="ignore", divide="ignore"):
        frac = np.where(width > 0, (b - m0) / width, 1.0)
    price = np.where(inside, p0 + frac * (p1 - p0), np.nan)
    interior = inside & (width >= STEP_MW)
    return price, interior


def unit_hours(u: dict, runs: list):
    """Per hour: (marginal, implied price, base point, hsl) for one unit.  The hour is scored
    on its means: the hourly mean base point against the mean HSL and LSL over the runs the
    unit was online with a curve, on the curve in force for most of those runs.  Hours where
    that is fewer than MIN_ONLINE of the hour's runs are left NaN / False."""
    n = len(runs)
    hr = np.minimum(np.array(runs) // 60, 23)
    si, li, ci = _ffill_index(u["status"], n), _ffill_index(u["lim"], n), _ffill_index(u["curve"], n)
    on = np.array([i >= 0 and _online(u["status"][i][1]) for i in si])
    has_curve = np.array([i >= 0 and u["curve"][i][1] is not None for i in ci])
    bp = np.array([np.nan if v is None else v for v in u["bp"]], float)
    ok = on & has_curve & np.isfinite(bp[hr]) & (li >= 0)
    hsl_r = np.array([u["lim"][i][1] if i >= 0 and u["lim"][i][1] is not None else np.nan for i in li], float)
    lsl_r = np.array([u["lim"][i][2] if i >= 0 and u["lim"][i][2] is not None else np.nan for i in li], float)
    marg = np.zeros(24, bool)
    price = np.full(24, np.nan)
    hsl_h, lsl_h, curve_h = np.full(24, np.nan), np.full(24, np.nan), np.full(24, -1)
    runs_h = np.bincount(hr, minlength=24)
    for h in range(24):
        sel = ok & (hr == h)
        if runs_h[h] == 0 or sel.sum() < MIN_ONLINE * runs_h[h]:
            continue
        hsl_h[h] = np.nanmean(hsl_r[sel]) if np.isfinite(hsl_r[sel]).any() else np.nan
        lsl_h[h] = np.nanmean(lsl_r[sel]) if np.isfinite(lsl_r[sel]).any() else np.nan
        curve_h[h] = np.bincount(ci[sel]).argmax()
    hours = np.flatnonzero(curve_h >= 0)
    if not hours.size:
        return marg, price, bp, hsl_h
    kmax = max(len(u["curve"][c][1]) for c in np.unique(curve_h[hours]))
    P = np.full((hours.size, kmax), np.nan)
    M = np.full((hours.size, kmax), np.nan)
    for j, h in enumerate(hours):
        ev = u["curve"][curve_h[h]]
        P[j, :len(ev[1])] = ev[1]
        M[j, :len(ev[2])] = ev[2]
    hsl, lsl, b = hsl_h[hours], lsl_h[hours], bp[hours]
    if u.get("frac"):
        M = M * np.where(np.isfinite(hsl), hsl, 0.0)[:, None]
    pr, interior = price_at(P, M, b)
    tol = np.maximum(TOL_MW, TOL * np.where(np.isfinite(hsl), hsl, 0.0))
    lo = np.where(np.isfinite(lsl), lsl, -np.inf)
    hi = np.where(np.isfinite(hsl), hsl, np.inf)
    interior &= (b > lo + tol) & (b < hi - tol) & np.isfinite(pr)
    marg[hours] = interior
    price[hours[interior]] = pr[interior]
    return marg, price, bp, hsl_h


def build_marginal_nodes(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    node_days = set(index["days"].get("nodes", []))
    price_days = set(index["days"].get("prices", []))
    sp_of = settlement_points(index)
    rows, has_nodes = [], []
    units = {}        # name -> [tech, sp, h_on, h_at, h_below, h_above, sum implied, sum node, n node, sum hsl]
    ever = {t: set() for t in TECHS}
    diffs, sample, n_seen = {0: [], 1: [], 2: []}, [], 0
    rng = np.random.default_rng(1)
    for d in dates:
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        pr = read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz") if d in price_days else None
        lam = (pr or {}).get("lambda") or {}
        nodes = (read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("points") if d in node_days else None
        has_nodes.append(bool(nodes))
        if not ud or not lam.get("hourly_mean"):
            continue
        f = lambda k: np.array([np.nan if v is None else v for v in (lam.get(k) or [])[:24]] + [np.nan] * (24 - len((lam.get(k) or [])[:24])), float)
        mean, lo, hi = f("hourly_mean"), f("hourly_min"), f("hourly_max")
        lo, hi = np.fmin(lo, mean) - BAND, np.fmax(hi, mean) + BAND
        runs = ud["runs"]
        day = {t: np.zeros((6, 24)) for t in TECHS}     # n_at, n_below, n_above, mw_at, mw_below, mw_above
        for name, u in ud["units"].items():
            t = u.get("tech")
            if t not in day or not u.get("bp") or not u.get("curve"):
                continue
            marg, price, bp, hsl_h = unit_hours(u, runs)
            on_hours = np.isfinite(hsl_h)
            if not on_hours.any():
                continue
            sp = sp_of.get(name)
            np_ = nodes.get(sp) if nodes and sp else None
            node = np.array([np.nan if v is None else v for v in np_], float) if np_ else None
            rec = units.setdefault(name, [t, sp, 0, 0, 0, 0, 0.0, 0.0, 0, 0.0])
            rec[2] += int(on_hours.sum())
            rec[9] += float(np.nansum(hsl_h))
            for h in np.flatnonzero(marg):
                p = price[h]
                if not np.isfinite(p) or not np.isfinite(mean[h]):
                    continue
                cls = 0 if lo[h] <= p <= hi[h] else (1 if p < lo[h] else 2)
                day[t][cls, h] += 1
                day[t][3 + cls, h] += bp[h]
                rec[3 + cls] += 1
                rec[6] += p
                ever[t].add(name)
                if node is not None and np.isfinite(node[h]):
                    rec[7] += node[h]
                    rec[8] += 1
                    diffs[cls].append(abs(p - node[h]))
                    n_seen += 1
                    pt = [round(p, 2), round(float(node[h]), 2), t, round(float(mean[h]), 2), cls]
                    if len(sample) < SAMPLE:
                        sample.append(pt)
                    else:
                        j = rng.integers(n_seen)
                        if j < SAMPLE:
                            sample[j] = pt
        for t in TECHS:
            a = day[t]
            for h in range(24):
                if a[:3, h].sum() > 0:
                    rows.append([d, h, _r(mean[h], 2), t] + [int(v) for v in a[:3, h]] + [_r(v) for v in a[3:, h]])

    top = sorted(units.items(), key=lambda kv: -(kv[1][4] + kv[1][5]))[:TOP_UNITS]
    out_units = [[name, r[0], r[1], r[2], r[3], r[4], r[5],
                  _r(r[6] / (r[3] + r[4] + r[5]), 2) if r[3] + r[4] + r[5] else None,
                  _r(r[7] / r[8], 2) if r[8] else None, r[8], _r(r[9] / r[2]) if r[2] else None] for name, r in top]
    def stats(a):
        a = np.array(a)
        return {"n": int(a.size), "median_abs": _r(np.median(a), 2) if a.size else None,
                "within5": _r((a <= 5).mean(), 3) if a.size else None, "within10": _r((a <= 10).mean(), 3) if a.size else None}
    valid = {**stats(diffs[0] + diffs[1] + diffs[2]), "by_class": {k: stats(diffs[i]) for i, k in enumerate(("at", "below", "above"))},
             "sample": sample}
    write_json_gz(DATA_DIR / "marginal_nodes.json.gz", {
        "dates": dates, "has_nodes": has_nodes, "band": BAND, "tol": TOL, "min_online": MIN_ONLINE,
        "hours": {"columns": ["date", "hour", "lambda", "tech", "n_at", "n_below", "n_above", "mw_at", "mw_below", "mw_above"],
                  "rows": rows},
        "units": out_units, "valid": valid,
        "n_units": {t: len(ever[t]) for t in TECHS},
    })
    n_at = sum(r[4] for r in rows)
    n_off = sum(r[5] + r[6] for r in rows)
    print(f"marginal_nodes: {len(dates)} days, {len(rows)} tech-hours, {n_at:,} unit-hours marginal at lambda, "
          f"{n_off:,} away from it; node check on {valid['n']:,} unit-hours, median gap "
          f"{valid['median_abs']} $/MWh, {valid['within5']} within $5")
