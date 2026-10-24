"""The 2-day fit (site layout plan, section 3, layer 2): which thermal units were actually
committed on a day, inferred from ERCOT's 2-day aggregate thermal offer curve.

The 2-day SCED energy curves report (NP3-908-ER) publishes, two days after the operating
day, the sum of every non-IRR unit's SCED2 offer curve for every SCED run.  That sum is
(validate.py checks it) the same number the 60-day unit curves add up to, so it identifies
the committed set long before the 60-day disclosure names it: the MW offered at or below the
floor, -$20 and $0 are mostly the minimum output (LSL) of the units that were on, and the MW
at $10, $25, $50 and the cap say which of them it was.

Method (v0), for one operating day with a forecast file and a 2-day curve file:

  start      the forecast's committed set: every thermal train's verdict, p_on and off
             window from data/forecast/<date>.json.gz (what was known the day before)
  contribute each unit's SCED2 offer curve from the latest monthly snapshot public before the
             day cleared (the same curve the dispatch model uses), evaluated as MW at or below
             each price in PRICES and clipped to [0, HSL].  A combined-cycle train has one
             option per configuration (its own curve, LSL and HSL: a 2x1 holds twice the
             minimum output of a 1x1), and the fit picks the configuration too; the forecast
             judges the train on its smallest configuration, which is where most of the
             forecast's missing minimum output sits
  fixed      nuclear (on unless on outage), and hydro and "other" from the latest known 60-day
             day's curves (about 1 GW, not fitted)
  peakers    combustion turbines are not judged one by one (they start by the hour): the fit
             carries one online share per hour for the peaker fleet, started at the forecast's
             p_on-weighted share and re-solved after each pass given the committed set
  target     the 2-day non-IRR curve, hourly mean, at PRICES
  fit        coordinate descent: units in order of how uncertain the forecast was about them
             (maybe and no-cutoff first, then daily units by how close their day loss sat to
             their cutoff, then seasonal and multi-day, then always-on and outage last) are
             each tried off all day, on all day (in each configuration) and, where the
             forecast gave one, on outside its off window; a change is kept when it lowers
             the weighted residual
             sum_h sum_p w_p |fleet(h, p) - target(h, p)| by more than MIN_GAIN of the unit's
             own contribution (MIN_GAIN_FIRM for always-on units and units on outage, where
             the forecast is surer).  Passes repeat until nothing changes (at most MAX_PASSES).
  report     the fitted set by group and technology (MW of LSL and HSL, counts, flips), each
             unit's forecast and fitted verdict with the gain its change bought, the residual
             by hour and price point before and after, and an "interchangeable" flag on a
             changed unit when another unit of the same technology and about the same size
             was left as forecast (similar curves cannot be told apart in a sum)

Written to data/fit/<date>.json.gz with an index, scored by pipeline/forecast/score.py (the
fitted LSL against the 60-day online LSL, and the fitted on/off calls against the 60-day
answer, beside the forecast's), checked by pipeline/validate.py.

  python -m pipeline.models.two_day_fit                        # every day with a forecast and a 2-day curve
  python -m pipeline.models.two_day_fit --days 2026-06-01 2026-06-30
"""
import argparse
import datetime as dt
import sys

import numpy as np

from ..config import DATA_DIR, PRICE_GRID
from ..curves import mw_at_prices
from ..store import load_index, read_json_gz, save_index, write_json_gz
from ..forecast import context as C

NAME = "two_day_fit"
VERSION = "v0"
FORMAT = 1
OUT_DIR = DATA_DIR / "fit"
PRICES = [-249.0, -20.0, 0.0, 10.0, 25.0, 50.0, float(PRICE_GRID[-1])]
WEIGHTS = [1.0, 2.0, 2.0, 1.0, 1.0, 1.0, 0.5]       # the LSL-identifying points count double; the cap depends on HSL
MIN_GAIN = 0.02          # a change must lower the residual by this share of the unit's own contribution
MIN_GAIN_FIRM = 0.15     # ... and by this share for always-on units and units on outage (the forecast is surer of them)
CT_STEPS = 51            # peaker online share by hour: grid searched on [0, 1]
MAX_PASSES = 4
SIMILAR = 0.10           # "interchangeable": same technology, LSL and HSL within this share
GRID_IDX = [int(np.searchsorted(PRICE_GRID, p)) for p in PRICES]
ORDER = {"maybe": 0, "nocut": 1, "on": 2, "off": 2, "outage": 4}
UNIT_COLS = ["unit", "tech", "group", "hsl", "lsl", "forecast", "p_on", "fit", "config", "lsl_fit", "hsl_fit", "changed",
             "gain", "interchangeable", "off_from", "off_hours", "model", "version"]


def _arr(v):
    return np.array([np.nan if x is None else float(x) for x in v], float)


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _points(p, mw, hsl):
    """A SCED2 curve (price, MW points) evaluated at PRICES, clipped to [0, hsl]."""
    mw = mw_at_prices(np.array([p], float), np.array([mw], float), np.array(PRICES))[0]
    return np.clip(mw, 0.0, hsl)


def _options(ctx: C.Context, month, u, dam_units, hsl, lsl):
    """The ways a train can be on: [(configuration name or None, points at PRICES, lsl, hsl)].
    One per combined-cycle configuration with a snapshot curve (its own limits), else one for
    the train from the DAM limits with a flat stand-in (minimum output at the floor points,
    full output above $0).  Configurations with the same limits collapse to the first."""
    out, seen = [], set()
    curves = ctx.curves(month) if month else {}
    # the configuration the dispatch model used first: the most recent snapshot, most online runs
    names = sorted(u["configs"], key=lambda n: ((curves.get(n) or {}).get("date") or "", (curves.get(n) or {}).get("n_on") or 0), reverse=True)
    for name in names:
        c = curves.get(name)
        d = dam_units.get(name) or {}
        chsl = (c or {}).get("hsl") or d.get("hsl") or (hsl if len(u["configs"]) == 1 else None)
        clsl = (c or {}).get("lsl") if c and c.get("lsl") is not None else d.get("lsl")
        if not chsl or chsl <= 0:
            continue
        clsl = float(clsl or 0.0)
        key = (round(clsl), round(chsl))
        if key in seen:
            continue
        seen.add(key)
        if c and c.get("p"):
            pts = _points(c["p"], c["mw"], chsl)
        else:
            pts = _standin(clsl, chsl)
        out.append((name if len(u["configs"]) > 1 else None, pts, clsl, float(chsl)))
    if not out:
        out.append((None, _standin(lsl, hsl), lsl, hsl))
    return out


def _standin(lsl, hsl):
    """A unit without a snapshot curve: minimum output from -$20 up (where SCED2 curves put
    it), nothing at the floor, full output from $10."""
    return np.array([0.0, lsl, lsl, hsl, hsl, hsl, hsl], float)


def _target(date):
    d2 = read_json_gz(DATA_DIR / "2d" / f"{date}.json.gz")
    if not d2 or "non_irr" not in d2.get("curves", {}):
        return None
    rows = d2["curves"]["non_irr"]
    return np.array([[np.nan if r is None or r[i] is None else r[i] for i in GRID_IDX] for r in rows], float)


def _fixed_other(ctx: C.Context, date):
    """Hydro and other at PRICES by hour from the latest known 60-day day (not fitted)."""
    known, _ = ctx.known_date(date)
    d6 = read_json_gz(DATA_DIR / "60d" / f"{known}.json.gz") if known else None
    out = np.zeros((24, len(PRICES)))
    if not d6:
        return out, None
    for t in ("hydro", "other"):
        rows = d6.get("curves", {}).get(t)
        if rows:
            out += np.nan_to_num(np.array([[np.nan if r is None or r[i] is None else r[i] for i in GRID_IDX] for r in rows], float))
    return out, known


def _residual(F, T, w):
    ok = ~np.isnan(T)
    return float(np.sum(np.where(ok, np.abs(F - T), 0.0) * w[None, :]))


def fit(date, ctx: C.Context, day: dict) -> dict:
    """day: the forecast file for `date`.  Returns the fit file content, or None when the day
    has no 2-day curve."""
    T = _target(date)
    if T is None:
        return None
    units = ctx.units(date, own=True)     # fitted after the fact: the day's own disclosure
    month, hindsight = ctx.curve_month(date)
    w = np.array(WEIGHTS)
    fixed, known = _fixed_other(ctx, date)
    cols = {c: i for i, c in enumerate(day["units"]["columns"])}
    dam_units = (ctx.dam(ctx.known_dam_date(date, own=True)) or {}).get("units", {})
    cand = []           # fittable units
    fixed_units = np.zeros((24, len(PRICES)))      # nuclear: on unless on outage
    ct_full, ct_fc = np.zeros(len(PRICES)), np.zeros(len(PRICES))   # every peaker on; peakers at the forecast's p_on
    for r in day["units"]["rows"]:
        key, tech, g, hsl, lsl = r[cols["unit"]], r[cols["tech"]], r[cols["group"]], float(r[cols["hsl"]] or 0), float(r[cols["lsl"]] or 0)
        verdict, p_on = r[cols["verdict"]], float(r[cols["p_on"]] or 0.0)
        u = units.get(key)
        if u is None or hsl <= 0:
            continue
        opts = _options(ctx, month, u, dam_units, hsl, lsl)
        if tech == "combustion_turbine":
            ct_full += opts[0][1]
            ct_fc += p_on * opts[0][1]
            continue
        if tech == "nuclear":
            fixed_units += opts[0][1][None, :] * (0.0 if verdict == "outage" else 1.0)
            continue
        off_from, off_hours = r[cols["off_from"]], int(r[cols["off_hours"]] or 0)
        mask = np.ones(24)
        if off_from and off_hours:
            mask[off_from - 1:off_from - 1 + off_hours] = 0.0
        # states: "off", "on:<i>" (configuration i all day), "window:<i>" (on outside the off window)
        states = {"off": (None, 0.0, 0.0, 0.0)}
        for i, (name, pts, clsl, chsl) in enumerate(opts):
            states[f"on:{i}"] = (name, np.tile(pts, (24, 1)), clsl, chsl)
            if off_from and off_hours:
                states[f"window:{i}"] = (name, pts[None, :] * mask[:, None], clsl, chsl)
        i0 = 0      # the first option is the configuration the dispatch model used
        start = "off" if verdict in ("off", "outage") else (f"window:{i0}" if (verdict == "maybe" and off_from and off_hours) else f"on:{i0}")
        if verdict == "nocut":
            start = f"on:{i0}" if p_on >= 0.5 else "off"
        loss, cut = r[cols["loss"]], r[cols["cutoff"]]
        closeness = abs(float(loss) - float(cut)) / max(abs(float(cut)), 1.0) if loss is not None and cut is not None else 1.0
        rank = (ORDER.get(verdict, 2) if g not in ("seasonal", "multiday", "never") else (3 if g != "never" else 4), closeness)
        cand.append({"key": key, "tech": tech, "group": g, "hsl": hsl, "lsl": lsl, "verdict": verdict, "p_on": p_on,
                     "states": states, "mask": mask, "start": start, "state": start, "rank": rank,
                     "min_gain": MIN_GAIN_FIRM if (g == "never" or verdict == "outage") else MIN_GAIN,
                     "off_from": off_from, "off_hours": off_hours, "gain": 0.0})
    cand.sort(key=lambda c: c["rank"])

    def contrib(c, state):
        return c["states"][state][1]

    # peakers: one online share per hour, started at the forecast's (p_on-weighted MW over full MW)
    ct_share_fc = float(ct_fc.sum() / ct_full.sum()) if ct_full.sum() else 0.0
    ct_share = np.full(24, ct_share_fc)
    ct_grid = np.linspace(0.0, 1.0, CT_STEPS)

    def ct_mw(share):
        return share[:, None] * ct_full[None, :]

    def fit_ct(F_other):
        """The peaker share per hour that best closes the hour's residual, given everything else."""
        out = np.empty(24)
        for h in range(24):
            ok = ~np.isnan(T[h])
            res = [np.sum(np.abs(F_other[h] + g * ct_full - T[h])[ok] * w[ok]) for g in ct_grid]
            out[h] = ct_grid[int(np.argmin(res))]
        return out

    F = fixed + fixed_units + ct_mw(ct_share)
    for c in cand:
        F = F + contrib(c, c["state"])
    before = _residual(F, T, w)
    before_hourly = np.nansum(np.abs(F - T) * w[None, :], axis=1)
    before_pts = F.copy()
    changed = True
    passes = 0
    while changed and passes < MAX_PASSES:
        changed = False
        passes += 1
        for c in cand:
            base = F - contrib(c, c["state"])
            cur = _residual(base + contrib(c, c["state"]), T, w)
            own = max(float(np.sum(contrib(c, k) * w[None, :])) for k in c["states"] if k != "off")
            best_state, best_res = c["state"], cur
            for s in c["states"]:
                if s == c["state"]:
                    continue
                res = _residual(base + contrib(c, s), T, w)
                if res < best_res - c["min_gain"] * own:
                    best_state, best_res = s, res
            if best_state != c["state"]:
                c["gain"] += cur - best_res
                c["state"] = best_state
                F = base + contrib(c, best_state)
                changed = True
        # then the peakers' share by hour, given the committed set
        other = F - ct_mw(ct_share)
        new_share = fit_ct(other)
        if np.any(np.abs(new_share - ct_share) > 1e-9):
            changed = True
        ct_share = new_share
        F = other + ct_mw(ct_share)
    after = _residual(F, T, w)
    after_hourly = np.nansum(np.abs(F - T) * w[None, :], axis=1)

    # interchangeable: a changed unit with a same-technology, similar-size unit left as forecast
    for c in cand:
        c["changed"] = c["state"] != c["start"]
        c["fit"] = c["state"].split(":")[0]
        c["config"], _, c["lsl_fit"], c["hsl_fit"] = c["states"][c["state"]]
        c["fc_on"] = c["start"] != "off"
    for c in cand:
        c["interchangeable"] = False
        if not c["changed"]:
            continue
        on = c["fit"] != "off"
        for o in cand:
            if o is c or o["changed"] or o["tech"] != c["tech"] or (o["fit"] != "off") == on:
                continue
            if abs(o["lsl"] - c["lsl"]) <= SIMILAR * max(c["lsl"], 1.0) and abs(o["hsl"] - c["hsl"]) <= SIMILAR * max(c["hsl"], 1.0):
                c["interchangeable"] = True
                break

    # summaries by group and technology: LSL and HSL of units on (window counts as on), counts, flips
    def agg_init():
        return {"lsl_fc": 0.0, "lsl_fit": 0.0, "hsl_fc": 0.0, "hsl_fit": 0.0, "n_fc": 0, "n_fit": 0, "n_on_added": 0, "n_off_added": 0,
                "n_reconfigured": 0, "n": 0}
    groups, techs = {}, {}
    lsl_h_fc, lsl_h_fit = np.zeros(24), np.zeros(24)
    for c in cand:
        g = c["group"] or "ungrouped"
        st0 = c["states"][c["start"]]
        for agg in (groups.setdefault(g, agg_init()), techs.setdefault(c["tech"], agg_init())):
            agg["n"] += 1
            if c["fc_on"]:
                agg["lsl_fc"] += st0[2]; agg["hsl_fc"] += st0[3]; agg["n_fc"] += 1
            if c["fit"] != "off":
                agg["lsl_fit"] += c["lsl_fit"]; agg["hsl_fit"] += c["hsl_fit"]; agg["n_fit"] += 1
            if c["changed"]:
                if c["fit"] == "off":
                    agg["n_off_added"] += 1
                elif not c["fc_on"]:
                    agg["n_on_added"] += 1
                else:
                    agg["n_reconfigured"] += 1
        for on, lsl, arr, state in ((c["fc_on"], st0[2], lsl_h_fc, c["start"]), (c["fit"] != "off", c["lsl_fit"], lsl_h_fit, c["state"])):
            if on:
                arr += lsl * (c["mask"] if state.startswith("window") else 1.0)

    def agg_out(a):
        return {k: (_r(v) if isinstance(v, float) else v) for k, v in a.items()}

    rows = [[c["key"], c["tech"], c["group"], _r(c["hsl"]), _r(c["lsl"]), c["verdict"], _r(c["p_on"], 2), c["fit"], c["config"],
             _r(c["lsl_fit"]), _r(c["hsl_fit"]), int(c["changed"]), _r(c["gain"], 0), int(c["interchangeable"]), c["off_from"], c["off_hours"],
             NAME, VERSION]
            for c in sorted(cand, key=lambda c: c["key"])]
    return {
        "date": date, "format": FORMAT, "model": NAME, "version": VERSION,
        "inputs": {"curve_month": month, "curve_hindsight": hindsight, "known_date": known, "forecast_models": day.get("models"),
                   "forecast_asof": day.get("inputs", {}).get("asof"),
                   "prices": PRICES, "weights": WEIGHTS, "min_gain": MIN_GAIN, "passes": passes,
                   "n_candidates": len(cand), "n_changed": int(sum(c["changed"] for c in cand)),
                   "n_options": int(sum(len(c["states"]) for c in cand))},
        "residual": {"before": _r(before, 0), "after": _r(after, 0),
                     "before_hourly": [_r(v, 0) for v in before_hourly], "after_hourly": [_r(v, 0) for v in after_hourly]},
        "hourly": {"target": [[_r(v, 0) for v in row] for row in T],
                   "before": [[_r(v, 0) for v in row] for row in before_pts],
                   "after": [[_r(v, 0) for v in row] for row in F],
                   "fixed": [[_r(v, 0) for v in row] for row in fixed + fixed_units],
                   "peaker_share_forecast": _r(ct_share_fc, 3), "peaker_share_fit": [_r(v, 3) for v in ct_share],
                   "peaker_hsl": _r(ct_full[-1], 0),
                   "lsl_forecast": [_r(v, 0) for v in lsl_h_fc], "lsl_fit": [_r(v, 0) for v in lsl_h_fit]},
        "groups": {g: agg_out(a) for g, a in sorted(groups.items())},
        "tech": {t: agg_out(a) for t, a in sorted(techs.items())},
        "units": {"columns": UNIT_COLS, "rows": rows},
    }


def fit_days(ctx: C.Context, days: list, forecast_dir) -> list:
    """Write a fit file for every day in `days` that has a forecast file and a 2-day curve;
    returns the days written.  Days whose fit is current (same forecast models, version and
    inputs, and a forecast built from the same as-of history point) are left alone."""
    done = []
    for d in days:
        day = read_json_gz(forecast_dir / f"{d}.json.gz")
        if not day or not (DATA_DIR / "2d" / f"{d}.json.gz").exists():
            continue
        path = OUT_DIR / f"{d}.json.gz"
        cur = read_json_gz(path) if path.exists() else None
        if (cur and cur.get("version") == VERSION and cur.get("format") == FORMAT
                and cur["inputs"].get("forecast_models") == day.get("models") and cur["inputs"].get("curve_month") == ctx.curve_month(d)[0]
                and cur["inputs"].get("forecast_asof") == day.get("inputs", {}).get("asof")):
            continue
        out = fit(d, ctx, day)
        if out is None:
            continue
        write_json_gz(path, out)
        done.append(d)
    return done


def write_index(index: dict):
    days = sorted(p.name[:10] for p in OUT_DIR.glob("20*.json.gz"))
    write_json_gz(OUT_DIR / "index.json.gz", {"days": days, "model": NAME, "version": VERSION, "format": FORMAT,
                                              "prices": PRICES, "weights": WEIGHTS,
                                              "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    index["days"]["fit"] = days
    return days


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", nargs=2, metavar=("START", "END"))
    ap.add_argument("--force", action="store_true", help="refit days whose fit is current")
    args = ap.parse_args(argv)
    from ..forecast.build import OUT_DIR as FC_DIR, forecast_days
    index = load_index()
    ctx = C.Context(index)
    C.update_snapshots(ctx)
    days = forecast_days(ctx)
    if args.days:
        days = [d for d in days if args.days[0] <= d <= args.days[1]]
    if args.force:
        for d in days:
            p = OUT_DIR / f"{d}.json.gz"
            if p.exists():
                p.unlink()
    done = fit_days(ctx, days, FC_DIR)
    all_days = write_index(index)
    save_index(index)
    print(f"fit: {len(done)} day(s) fitted, {len(all_days)} in the index")
    return 0


if __name__ == "__main__":
    sys.exit(main())
