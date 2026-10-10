"""Which units are on the margin at their own node, read from the per-unit day files.  Needs
no downloads.

A unit is marginal in a SCED run when SCED dispatched it to the interior of its own submitted
offer curve: its base point sits strictly inside the ramp-limited range it had that run (LDL
to HDL, within LSL and HSL) and on a curve segment with some width, rather than pinned at a
limit or on a vertical step.  A unit climbing at its ramp rate has base point equal to HDL,
so it is pinned, not marginal.  The curve's price at that base point is then the price SCED
saw at the unit's node, so every marginal run carries an implied LMP without the price file.

The implied price is compared with the system lambda of the same run:
  at lambda   within BAND of it ($2, or 5% of lambda when larger): the unit is setting the
              system price
  below       below it: the unit sits behind an export constraint (its node is cheaper than
              the system; wind and solar at negative prices are the usual case)
  above       above it: the unit is on the load side of a constraint (its node is dearer)

Day files from before format 4 keep no per-run base point, HDL or LDL.  For those the hourly
mean base point stands in for every run of the hour and HSL / LSL for HDL / LDL, which lets
a unit swinging between its limits, or held by its ramp rate, read as marginal; `exact`
says which days have the per-run data.  Storage is scored only on exact days: a battery's
hourly mean base point (charging and discharging averaged) says nothing about its margin.

Writes data/marginal_nodes.json.gz:
  dates, exact (per date), has_nodes (per date), band, tol (fraction of HSL), tol_mw
  hours      columns / rows: [date, hour, lambda, tech, n_at, n_below, n_above,
             mw_at, mw_below, mw_above]: unit-hours on the margin (a unit marginal for a
             third of the hour's runs counts a third) and their base point MW averaged
             over the hour
  units      the units most often marginal away from lambda: [name, tech, sp, hours online
             with a curve, h_at, h_below, h_above, mean implied price when marginal, mean
             node price in those runs (days with node prices), n such runs, mean HSL]
  valid      implied price against the published node price for marginal runs: n,
             median_abs (|difference|), within5, within10 (shares), the same per class in
             by_class {at, below, above}, and sample [[implied, node, tech, lambda, class
             0 at / 1 below / 2 above], ...] (at most SAMPLE points)
  n_units    per tech: units ever marginal
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR, SIXTY_DAY_TECHS
from .intraday import _online
from .nodes import settlement_points
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

BAND = 2.0            # $/MWh either side of the run's lambda for "at lambda", at least; see band()
BAND_REL = 0.05       # ... or this share of |lambda| when that is larger
TOL = 0.01            # of HSL: distance from a limit that still counts as pinned (at least TOL_MW)
TOL_MW = 0.5
STEP_MW = 1.0         # a curve segment narrower than this is a vertical step, not a margin
TECHS = list(SIXTY_DAY_TECHS)
TOP_UNITS = 60
SAMPLE = 4000


def band(lam: float) -> float:
    return max(BAND, BAND_REL * abs(lam))


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _arr(vals, n=None):
    a = np.array([np.nan if v is None else v for v in vals], float)
    return a if n is None else np.r_[a[:n], np.full(max(0, n - a.size), np.nan)]


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


def unit_runs(u: dict, n: int, hr: np.ndarray):
    """Per run: (marginal, implied price, base point) for one unit, and whether the per-run
    dispatch data was there (else the hourly means stood in)."""
    si, li, ci = _ffill_index(u["status"], n), _ffill_index(u["lim"], n), _ffill_index(u["curve"], n)
    on = np.array([i >= 0 and _online(u["status"][i][1]) for i in si])
    has_curve = np.array([i >= 0 and u["curve"][i][1] is not None for i in ci])
    hsl = np.array([u["lim"][i][1] if i >= 0 and u["lim"][i][1] is not None else np.nan for i in li], float)
    lsl = np.array([u["lim"][i][2] if i >= 0 and u["lim"][i][2] is not None else np.nan for i in li], float)
    exact = bool(u.get("disp"))
    tol_scale = 1
    if exact:
        di = _ffill_index(u["disp"], n)
        bp, hdl, ldl = (np.array([u["disp"][i][j] if i >= 0 and u["disp"][i][j] is not None else np.nan for i in di], float)
                        for j in (1, 2, 3))
    else:
        # the hourly mean base point stands in for every run, against the hour's mean limits
        # over the runs the unit was online (per-run limits against a mean base point would
        # make every wind farm look curtailed in the runs its HSL ran above the mean)
        bp = _arr(u["bp"], 24)[hr]
        ok_h = on & has_curve & (li >= 0)
        hsl_h, lsl_h = np.full(24, np.nan), np.full(24, np.nan)
        for h in range(24):
            sel = ok_h & (hr == h)
            if sel.any():
                hsl_h[h] = np.nanmean(hsl[sel]) if np.isfinite(hsl[sel]).any() else np.nan
                lsl_h[h] = np.nanmean(lsl[sel]) if np.isfinite(lsl[sel]).any() else np.nan
        hsl, lsl = hsl_h[hr], lsl_h[hr]
        hdl, ldl = hsl, lsl
        tol_scale = 5          # hourly means are blurrier: 5% of HSL, at least 2 MW
    marg = np.zeros(n, bool)
    price = np.full(n, np.nan)
    ok = on & has_curve & np.isfinite(bp) & (li >= 0)
    if not ok.any():
        return marg, price, bp, exact
    idx = np.flatnonzero(ok)
    events = sorted(set(ci[idx]))
    kmax = max(len(u["curve"][c][1]) for c in events)
    Pe = np.full((len(u["curve"]), kmax), np.nan)
    Me = np.full((len(u["curve"]), kmax), np.nan)
    for c in events:
        ev = u["curve"][c]
        Pe[c, :len(ev[1])] = ev[1]
        Me[c, :len(ev[2])] = ev[2]
    P, M = Pe[ci[idx]], Me[ci[idx]]
    h_ = hsl[idx]
    if u.get("frac"):
        M = M * np.where(np.isfinite(h_), h_, 0.0)[:, None]
    b = bp[idx]
    pr, interior = price_at(P, M, b)
    tol = np.maximum(TOL_MW * (4 if tol_scale > 1 else 1), tol_scale * TOL * np.where(np.isfinite(h_), h_, 0.0))
    lo = np.fmax(np.where(np.isfinite(ldl[idx]), ldl[idx], -np.inf), np.where(np.isfinite(lsl[idx]), lsl[idx], -np.inf))
    hi = np.fmin(np.where(np.isfinite(hdl[idx]), hdl[idx], np.inf), np.where(np.isfinite(h_), h_, np.inf))
    interior &= (b > lo + tol) & (b < hi - tol) & np.isfinite(pr)
    marg[idx] = interior
    price[idx[interior]] = pr[interior]
    return marg, price, bp, exact


def run_lambda(lam: dict, runs: list) -> np.ndarray:
    """System lambda at each run (by clock time; the second pass of a repeated DST hour gets
    the first one's value), NaN where the price file has none."""
    by_time = {}
    for t, v in zip(lam.get("time") or [], lam.get("value") or []):
        by_time.setdefault(t, v)
    out = np.full(len(runs), np.nan)
    for i, m in enumerate(runs):
        v = by_time.get(f"{(m % 1440) // 60:02d}:{m % 60:02d}")
        if v is not None:
            out[i] = v
    return out


def node_at(vals, minute: int):
    """A point's price at a run from a node file of either format (24 hourly or 96 quarter-
    hour values)."""
    i = (minute % 1440) // (15 if len(vals) == 96 else 60)
    v = vals[i] if i < len(vals) else None
    return np.nan if v is None else v


def build_marginal_nodes(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    node_days = set(index["days"].get("nodes", []))
    price_days = set(index["days"].get("prices", []))
    sp_of = settlement_points(index)
    rows, has_nodes, exact_days = [], [], []
    units = {}        # name -> [tech, sp, h_on, h_at, h_below, h_above, sum implied, sum node, n node, sum hsl]
    ever = {t: set() for t in TECHS}
    diffs, sample, n_seen = {0: [], 1: [], 2: []}, [], 0
    rng = np.random.default_rng(1)
    for d in dates:
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        pr = read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz") if d in price_days else None
        lam = (pr or {}).get("lambda") or {}
        nodes = ((read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("points") or {}) if d in node_days else {}
        by_site = {}      # site prefix -> nodes, for batteries the DAM files never name
        for k in nodes:
            by_site.setdefault(k.split("_")[0], []).append(k)
        has_nodes.append(bool(nodes))
        exact = bool(ud) and ud.get("format", 0) >= 4
        exact_days.append(exact)
        if not ud or not lam.get("value"):
            continue
        runs = ud["runs"]
        n = len(runs)
        hr = np.minimum(np.array(runs) // 60, 23)
        runs_h = np.bincount(hr, minlength=24).astype(float)
        lam_r = run_lambda(lam, runs)
        lam_h = _arr(lam.get("hourly_mean") or [], 24)
        day = {t: np.zeros((6, 24)) for t in TECHS}     # n_at, n_below, n_above, mw_at, mw_below, mw_above
        for name, u in ud["units"].items():
            t = u.get("tech")
            if t not in day or not u.get("curve") or not (u.get("disp") or u.get("bp")):
                continue
            if t == "storage" and not u.get("disp"):
                continue
            marg, price, bp, _ = unit_runs(u, n, hr)
            if t == "storage":
                marg &= np.abs(bp) >= STEP_MW     # an idle battery sits between its bid and offer, not on a margin
            on_runs = np.isfinite(bp) & np.array([u["lim"][i][1] is not None if i >= 0 else False for i in _ffill_index(u["lim"], n)])
            if not marg.any() and not on_runs.any():
                continue
            hsl_r = np.array([u["lim"][i][1] if i >= 0 and u["lim"][i][1] is not None else np.nan for i in _ffill_index(u["lim"], n)], float)
            rec = units.setdefault(name, [t, sp_of.get(name), 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0])
            rec[2] += float(np.sum(on_runs / runs_h[hr]))
            rec[9] += float(np.nansum(np.where(on_runs, hsl_r, 0.0) / runs_h[hr]))
            sp = rec[1]
            if sp is None and t == "storage" and len(by_site.get(name.split("_")[0], [])) == 1:
                sp = by_site[name.split("_")[0]][0]      # the site's only node
            node = nodes.get(sp) if sp else None
            for r in np.flatnonzero(marg):
                p, l = price[r], lam_r[r]
                if not np.isfinite(l):
                    continue
                cls = 0 if abs(p - l) <= band(l) else (1 if p < l else 2)
                h, w = hr[r], 1.0 / runs_h[hr[r]]
                day[t][cls, h] += w
                day[t][3 + cls, h] += bp[r] * w
                rec[3 + cls] += w
                rec[6] += p * w
                ever[t].add(name)
                if node is not None:
                    v = node_at(node, runs[r])
                    if np.isfinite(v):
                        rec[7] += v
                        rec[8] += 1
                        diffs[cls].append(abs(p - v))
                        n_seen += 1
                        pt = [round(p, 2), round(float(v), 2), t, round(float(l), 2), cls]
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
                    rows.append([d, h, _r(lam_h[h], 2), t] + [_r(v, 2) for v in a[:3, h]] + [_r(v) for v in a[3:, h]])

    top = sorted(units.items(), key=lambda kv: -(kv[1][4] + kv[1][5]))[:TOP_UNITS]
    out_units = [[name, r[0], r[1], _r(r[2]), _r(r[3]), _r(r[4]), _r(r[5]),
                  _r(r[6] / (r[3] + r[4] + r[5]), 2) if r[3] + r[4] + r[5] else None,
                  _r(r[7] / r[8], 2) if r[8] else None, r[8], _r(r[9] / r[2]) if r[2] else None] for name, r in top]

    def stats(a):
        a = np.array(a)
        return {"n": int(a.size), "median_abs": _r(np.median(a), 2) if a.size else None,
                "within5": _r((a <= 5).mean(), 3) if a.size else None, "within10": _r((a <= 10).mean(), 3) if a.size else None}
    valid = {**stats(diffs[0] + diffs[1] + diffs[2]), "by_class": {k: stats(diffs[i]) for i, k in enumerate(("at", "below", "above"))},
             "sample": sample}
    write_json_gz(DATA_DIR / "marginal_nodes.json.gz", {
        "dates": dates, "exact": exact_days, "has_nodes": has_nodes, "band": BAND, "band_rel": BAND_REL, "tol": TOL, "tol_mw": TOL_MW,
        "hours": {"columns": ["date", "hour", "lambda", "tech", "n_at", "n_below", "n_above", "mw_at", "mw_below", "mw_above"],
                  "rows": rows},
        "units": out_units, "valid": valid,
        "n_units": {t: len(ever[t]) for t in TECHS},
    })
    n_at = sum(r[4] for r in rows)
    n_off = sum(r[5] + r[6] for r in rows)
    print(f"marginal_nodes: {len(dates)} days ({sum(exact_days)} with per-run dispatch), {len(rows)} tech-hours, "
          f"{n_at:,.0f} unit-hours marginal at lambda, {n_off:,.0f} away from it; node check on {valid['n']:,} runs, "
          f"median gap {valid['median_abs']} $/MWh, {valid['within5']} within $5")
