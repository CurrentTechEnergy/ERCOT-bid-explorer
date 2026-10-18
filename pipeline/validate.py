"""Accuracy checks on the processed data, run after every update (no downloads).

Each operating day is checked against ERCOT's own independent aggregates and for internal
consistency:

  60-day vs 2-day   wind, solar and storage curves rebuilt from the 60-day unit data match
                    ERCOT's 2-day aggregate curves; thermal base points match the 2-day
                    generation summary (its Non-IRR plus "remaining resources" groups)
  internal          each technology's curve stays within its online HSL, the SCED view holds at
                    least the online LSL at the floor, base points stay within HSL
  2-day             wind, solar and thermal offers cover the base points in the generation summary
  runs              11 to 13 SCED runs per hour (0 in the spring-forward hour, about 24 in the
                    repeated fall-back hour)
  prices            system lambda for every hour and close to the hub average
  statuses          per-unit file: status codes and resource types the pipeline knows
  dam               DAM day file: awards within each hour's HSL (warning), 24 hours per unit,
                    and (recorded) how the day-ahead awards compare with real-time base points
  fit               2-day fit file (pipeline/models/two_day_fit): the residual after the fit is
                    not above the residual before, the fitted curve at the cap does not exceed
                    the 2-day curve by more than the tolerance, group sums equal the fleet, a
                    model and version on every row, and (recorded) the fitted committed minimum
                    against the 2-day curve at -$20
  storage           battery day file (pipeline/storage): fleet discharging and charging rebuilt
                    from the per-unit base points match the 2-day generation summary's ESR
                    series; every battery has 24 hours; DAM awards within each battery's HSL
                    and LSL and never charging and discharging in the same hour; the state of
                    charge inside its min / max window; (recorded) how many batteries report a
                    state of charge and have DAM rows, and the DAM names without a SCED match;
                    (format 2) charging bids shrink and discharge offers grow as price rises,
                    both inside the fleet's LSL and HSL
  forecast          forecast day file (pipeline/forecast): shares between 0 and 1, group sums
                    equal technology sums equal the fleet hour by hour, committed minimum <=
                    expected output <= capacity, verdict counts equal the units rows, a model
                    name and version on every row and series, and (recorded) that a day with
                    an answer has been scored
  unit_curves       thermal offer curves by hour (pipeline/unit_curves.py): every hourly index
                    points at a stored curve, each curve's prices and MW never fall, and the
                    unit-hours with a curve file entry are the thermal unit-hours online in the
                    hourly unit file (data/60d-units)
  forecast_stack    dispatch stack file (pipeline/forecast/stack.py): MW never falls as the
                    price rises, groups and technologies each sum to the fleet, the floor is at
                    least the forecast's committed minimum and the top at most its capacity
  events            the unit events file (pipeline/events.py), checked once per run under the
                    pseudo-day "events": ids unique, every kind known, every unit a unit the
                    site knows (or fleet:<tech> for the fuel kind, a battery in
                    storage/habits.json.gz, or a unit or train in trends first_seen), every date a real date inside the loaded record (thermal
                    events inside the 60-day days), a first-seen date on every event; and the
                    cutoff history file: a model name and version, cutoffs numeric per MW of
                    LSL, every move on a unit with rows; and storage/units.json.gz and
                    habits.json.gz: one value per day for every field of every battery, the
                    shares charged and discharged in its top and bottom hours within 0 to 1, no
                    negative size or MWh

A check is an "error" when the numbers cannot both be right (a parsing or mapping bug), a
"warning" when something is worth a look, and "info" when it is only recorded.  Results that did not pass are kept per day in data/validation.json.

Usage:
  python -m pipeline.validate                 # days not yet in validation.json
  python -m pipeline.validate --all           # every day
  python -m pipeline.validate 2026-07-15 ...  # given days
Exits 1 if any checked day has an error (unless --no-fail).
"""
import argparse
import datetime as dt
import json
import sys
import warnings

import numpy as np

from .config import DATA_DIR, PRICE_GRID, TECH_OF_TYPE, UNIT_DATA_DIR
from .log import warn, write_summary
from .store import read_json_gz

REPORT_PATH = DATA_DIR / "validation.json"
THERMAL = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "hydro", "other"]
I_ZERO = int(np.searchsorted(PRICE_GRID, 0))
I_FLOOR = int(np.searchsorted(PRICE_GRID, -249))
I_TOP = PRICE_GRID.size - 1

# Status codes seen in the 60-day disclosure.  Online = starts with "ON" (pipeline convention);
# STARTUP, SHUTDOWN, EMR, EMRSWGR and blank count as neither online nor offline.
KNOWN_STATUSES = {"ON", "ONREG", "ONOS", "ONOSREG", "ONDSR", "ONDSRREG", "ONTEST", "ONEMR", "ONEMRSW",
                  "ONRUC", "ONOPTOUT", "ONHOLD", "ONSC", "ONFFRRRS", "ONRR", "ONRL",
                  "OFF", "OFFNS", "OFFQS", "OUT", "EMR", "EMRSWGR", "STARTUP", "SHUTDOWN", ""}

# Tolerances.  Calibrated on Dec 2025 - Oct 2026, where every day passes the error limits.
TOL = {
    "irr_curve_mw": 300,       # wind / solar: 60-day vs 2-day curve, MW, plus...
    "irr_curve_pct": 0.03,     # ...3% of the 2-day value
    "storage_curve_mw": 600,   # storage: 60-day vs 2-day curve, MW, plus...
    "storage_curve_pct": 0.05,
    "base_point_median_mw": 1000,  # thermal base point vs generation summary: median hour, MW (error)
    "base_point_max_mw": 2500,     # same, worst hour, MW (warning)
    "irr_bp_mw": 2500,         # wind / solar base point vs generation summary, MW (warning)
    "limit_mw": 5,             # curve vs HSL / LSL, base point vs HSL: rounding slack, MW
    "lambda_hub": 0.5,         # min hourly correlation of system lambda and hub average (warning)
    "fit_cap_mw": 1500,        # fitted curve at the cap above the 2-day curve at the cap, worst hour, MW (warning)
    "storage_bp_mw": 400,      # fleet discharging / charging vs generation summary ESR series: median hour, MW (error)
    "storage_bp_max_mw": 1000, # same, worst hour (warning)
    "soc_mwh": 1.0,            # state of charge outside [min, max] by more than this, MWh (warning)
    "storage_fleet_mw": 20000, # forecast battery fleet discharging or charging above this, MW (warning)
}


def _a(rows):
    """List of lists with None -> float array with NaN."""
    return np.array([[np.nan if v is None else v for v in (r if r is not None else [])] or [np.nan]
                     for r in rows], float) if rows else np.zeros((0, 0))


def _v(xs):
    return np.array([np.nan if v is None else v for v in xs], float)


def _hourly(rows, i):
    """24 values at grid index i from a 24 x grid curve list (None rows -> NaN)."""
    return np.array([np.nan if r is None or r[i] is None else r[i] for r in rows], float)


class Day:
    def __init__(self, date):
        self.date = date
        self.results = []      # [check, level ("ok" | "warning" | "error"), detail]

    def add(self, check, level, detail):
        self.results.append([check, level, detail])

    def limit(self, check, diff, allowed, what, warn_only=False):
        """diff, allowed: arrays over hours (NaN = not compared)."""
        ok = ~np.isnan(diff)
        if not ok.any():
            return
        over = ok & (np.abs(diff) > allowed)
        worst = int(np.nanargmax(np.where(ok, np.abs(diff) - allowed, -np.inf)))
        detail = f"{what}: largest gap {diff[worst]:+.0f} MW at hour {worst} (allowed {allowed[worst]:.0f})"
        if over.any():
            self.add(check, "warning" if warn_only else "error", f"{int(over.sum())} hour(s) out of range; {detail}")
        else:
            self.add(check, "ok", detail)


def _runs_check(day, source, runs, date):
    runs = np.asarray(runs, float)
    if runs.size != 24:
        day.add(f"runs_{source}", "error", f"{runs.size} hours instead of 24")
        return
    d = dt.date.fromisoformat(date)
    spring = d.month == 3 and d.weekday() == 6 and 8 <= d.day <= 14
    fall = d.month == 11 and d.weekday() == 6 and d.day <= 7
    bad = []
    for h, n in enumerate(runs):
        if spring and h == 2:
            ok = n == 0
        elif fall and h == 1:
            ok = 20 <= n <= 28
        else:
            ok = 10 <= n <= 18      # extra (manual) SCED runs add a few
        if not ok:
            bad.append(f"hour {h}: {n:.0f}")
    if bad:
        day.add(f"runs_{source}", "warning", "unusual SCED run counts: " + ", ".join(bad[:6]))
    else:
        day.add(f"runs_{source}", "ok", f"{runs.min():.0f} to {runs.max():.0f} runs per hour")


def check_day(date, have):
    day = Day(date)
    d2 = read_json_gz(DATA_DIR / "2d" / f"{date}.json.gz") if date in have["2d"] else None
    d6 = read_json_gz(DATA_DIR / "60d" / f"{date}.json.gz") if date in have["60d"] else None
    gen = read_json_gz(DATA_DIR / "2dgen" / f"{date}.json.gz") if date in have["2dgen"] else None
    pr = read_json_gz(DATA_DIR / "prices" / f"{date}.json.gz") if date in have["prices"] else None
    dam = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz") if date in have.get("dam", ()) else None

    if d2:
        _runs_check(day, "2d", d2["runs"], date)
    if d6:
        _runs_check(day, "60d", d6["runs"], date)

    # 60-day vs 2-day aggregate curves (wind, solar, storage)
    if d2 and d6:
        for tech in ("wind", "solar", "storage"):
            if tech not in d2["curves"] or tech not in d6["curves"]:
                continue
            mw, pct = ((TOL["storage_curve_mw"], TOL["storage_curve_pct"]) if tech == "storage"
                       else (TOL["irr_curve_mw"], TOL["irr_curve_pct"]))
            points = [("$0", I_ZERO), ("cap", I_TOP)] + ([("floor", I_FLOOR)] if tech == "storage" else [])
            for label, i in points:
                a, b = _hourly(d2["curves"][tech], i), _hourly(d6["curves"][tech], i)
                day.limit(f"curve_{tech}_{label.strip('$')}", b - a, mw + pct * np.abs(a),
                          f"{tech} offered at or below {label}, 60-day minus 2-day")

    # 60-day internal consistency, per technology and hour
    if d6:
        sn = d6["stat_names"]
        bad_top, bad_floor, bad_bp = [], [], []
        for tech, st in d6["stats"].items():
            s = _a(st)
            if s.shape[1] < len(sn):
                continue
            hsl, lsl, bp = s[:, sn.index("hsl")], s[:, sn.index("lsl")], s[:, sn.index("base_point")]
            top = _hourly(d6["curves"][tech], I_TOP)
            floor = _hourly(d6["curves"][tech], I_FLOOR)
            lim = TOL["limit_mw"]
            if np.nanmax(top - hsl, initial=-np.inf) > lim:
                bad_top.append(f"{tech} {np.nanmax(top - hsl):+.0f}")
            if tech != "storage" and np.nanmax(lsl - floor, initial=-np.inf) > lim:
                bad_floor.append(f"{tech} {np.nanmax(lsl - floor):+.0f}")
            if np.nanmax(bp - hsl, initial=-np.inf) > lim:
                bad_bp.append(f"{tech} {np.nanmax(bp - hsl):+.0f}")
        for check, bad, what in (("hsl_cap", bad_top, "curve at the cap above online HSL"),
                                 ("base_point_hsl", bad_bp, "base point above online HSL")):
            day.add(check, "error" if bad else "ok", f"{what}: " + ", ".join(bad) if bad else f"no {what}")
        # Recorded, not judged: the SCED-view curves hold 2-4 GW less than online LSL at the floor on
        # every day so far, so not all minimum output sits at -$250 (cause not yet known).
        day.add("lsl_floor", "info", "online LSL above the SCED-view curve at -$249, MW: "
                + (", ".join(bad_floor) if bad_floor else "none"))

    # base points vs the 2-day generation summary
    if gen:
        h = gen["hourly"]
        if d6:
            sn = d6["stat_names"]
            bp6 = {t: _a(d6["stats"][t])[:, sn.index("base_point")] for t in d6["stats"]}
            if "sum_base_point_non_irr" in h and "sum_base_point_remaining_res" in h:
                # ERCOT's "remaining resources" group included storage until 22 Jun 2026 and excludes it
                # since; take whichever definition fits the day
                ref = _v(h["sum_base_point_non_irr"]) + _v(h["sum_base_point_remaining_res"])
                thermal = sum(bp6[t] for t in THERMAL if t in bp6)
                fits = [("excluding storage", thermal - ref)]
                if "sum_base_point_esr" in h:
                    fits.append(("including storage", thermal - (ref - _v(h["sum_base_point_esr"]))))
                with np.errstate(all="ignore"):
                    label, diff = min(fits, key=lambda f: np.nanmedian(np.abs(f[1])))
                if not np.isnan(diff).all():
                    med, worst = float(np.nanmedian(np.abs(diff))), int(np.nanargmax(np.abs(diff)))
                    detail = (f"thermal base point, 60-day minus generation summary (remaining resources "
                              f"{label}): median hour {med:.0f} MW, worst {diff[worst]:+.0f} MW at hour {worst}")
                    level = ("error" if med > TOL["base_point_median_mw"] else
                             "warning" if abs(diff[worst]) > TOL["base_point_max_mw"] else "ok")
                    day.add("base_point_thermal", level, detail)
            for tech, col in (("wind", "sum_base_point_wgr"), ("solar", "sum_base_point_pvgr")):
                if col in h and tech in bp6:
                    day.limit(f"base_point_{tech}", bp6[tech] - _v(h[col]), np.full(24, TOL["irr_bp_mw"]),
                              f"{tech} base point, 60-day minus generation summary", warn_only=True)
        if d2:
            # SCED cannot dispatch more than was offered: the 2-day curve at the cap covers the base point
            for tech, col in (("wind", "sum_base_point_wgr"), ("solar", "sum_base_point_pvgr"),
                              ("non_irr", "sum_base_point_non_irr")):
                if tech in d2["curves"] and col in h:
                    short = _v(h[col]) - _hourly(d2["curves"][tech], I_TOP)
                    allowed = 300 + 0.02 * np.abs(_v(h[col]))
                    day.limit(f"offer_covers_bp_{tech}", np.where(short > 0, short, 0.0), allowed,
                              f"{tech} base point above the 2-day curve at the cap", warn_only=True)

    # prices
    if pr:
        lam = _v(pr["lambda"]["hourly_mean"])
        missing = [h for h in range(24) if np.isnan(lam[h])]
        d = dt.date.fromisoformat(date)
        spring = d.month == 3 and d.weekday() == 6 and 8 <= d.day <= 14
        expected = [2] if spring else []
        if missing != expected:
            day.add("lambda_hours", "warning", f"no system lambda in hour(s) {missing}")
        else:
            day.add("lambda_hours", "ok", "system lambda in every hour")
        hub = pr.get("spp15", {}).get("HB_HUBAVG")
        if hub and len(hub) == 96:
            with np.errstate(all="ignore"), warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                hh = np.nanmean(_v(hub).reshape(24, 4), axis=1)
            ok = ~np.isnan(hh) & ~np.isnan(lam)
            if ok.sum() >= 12 and np.std(lam[ok]) > 5 and np.std(hh[ok]) > 1:
                c = float(np.corrcoef(lam[ok], hh[ok])[0, 1])
                gap = float(np.median(hh[ok] - lam[ok]))
                level = "ok" if c >= TOL["lambda_hub"] else "warning"
                day.add("lambda_vs_hub", level, f"hourly correlation {c:.3f}, median hub minus lambda {gap:+.2f} $/MWh")

    # per-unit file: status codes and resource types
    unit_path = UNIT_DATA_DIR / "60d" / f"{date}.json.gz"
    if d6 and unit_path.exists():
        u = read_json_gz(unit_path)
        codes, types = set(), set()
        for e in u["units"].values():
            types.add(e["type"])
            codes.update(ev[1] for ev in e["status"] if ev[1] is not None)
        new_codes = sorted(codes - KNOWN_STATUSES)
        new_types = sorted(types - set(TECH_OF_TYPE))
        if new_codes or new_types:
            day.add("codes", "warning", "; ".join(
                ([f"new status code(s) {new_codes}"] if new_codes else []) +
                ([f"resource type(s) grouped as 'other': {new_types}"] if new_types else [])))
        else:
            day.add("codes", "ok", f"{len(codes)} status codes and {len(types)} resource types, all known")
    # DAM day file: awards within limits, complete hours, and the day-ahead vs real-time gap
    if dam:
        over, short, n_award = [], [], 0
        by_tech = {}
        for name, u in dam["units"].items():
            aw = [a for a in u.get("award", []) if a is not None]
            if len(u.get("award", [])) != dam.get("hours", 24):
                short.append(name)
            if aw:
                n_award += 1
                hsl_h = u.get("hsl_h") or [u.get("hsl")] * len(u["award"])
                pairs = [(a - hh, a, hh) for a, hh in zip(u["award"], hsl_h) if a is not None and hh is not None]
                if pairs:
                    worst = max(pairs, key=lambda p: p[0])
                    if worst[0] > TOL["limit_mw"]:
                        over.append(f"{name} {worst[1]:.0f} > HSL {worst[2]:.0f}")
                if u["tech"] in THERMAL:
                    acc = by_tech.setdefault(u["tech"], np.zeros(24))
                    for h, a in enumerate(u["award"][:24]):
                        if a is not None:
                            acc[h] += a
        if over:
            day.add("dam_awards", "warning", f"{len(over)} unit(s) awarded above that hour's HSL, e.g. {'; '.join(over[:3])}")
        elif short:
            day.add("dam_awards", "warning", f"{len(short)} unit(s) without a row for every hour, e.g. {short[:3]}")
        else:
            day.add("dam_awards", "ok", f"{n_award} units with a DAM energy award, all within HSL")
        if d6 and by_tech:
            stat = d6["stat_names"].index("base_point") if "stat_names" in d6 else LEGACY_STATS.index("base_point")
            gaps = []
            for tech, aw in by_tech.items():
                bp = _hourly(d6["stats"].get(tech) or [], stat)
                if bp.size == 24 and np.isfinite(bp).any():
                    gaps.append(f"{tech} {np.nanmedian(aw - bp):+.0f}")
            day.add("dam_vs_rt", "info", "DAM award minus real-time base point, median hour MW: " + ", ".join(gaps))
    # thermal offer curves by hour (pipeline/unit_curves)
    cv = read_json_gz(DATA_DIR / "60d-curves" / f"{date}.json.gz") if date in have["60d"] else None
    if cv:
        _curve_checks(day, cv, read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz", default=None))
    # battery day file (pipeline/storage)
    st = read_json_gz(DATA_DIR / "storage" / f"{date}.json.gz") if date in have.get("storage", ()) else None
    if st:
        _storage_checks(day, st, gen, dam)
    # forecast day file (pipeline/forecast): the page renders it as is, so it must add up
    fc = read_json_gz(DATA_DIR / "forecast" / f"{date}.json.gz") if date in have.get("forecast", ()) else None
    if fc:
        _forecast_checks(day, fc)
        st = read_json_gz(DATA_DIR / "forecast" / "stack" / f"{date}.json.gz", default=None)
        if st:
            _stack_checks(day, fc, st)
        else:
            day.add("forecast_stack", "warning", "forecast day without a dispatch stack file")
    ft = read_json_gz(DATA_DIR / "fit" / f"{date}.json.gz") if date in have.get("fit", ()) else None
    if ft:
        _fit_checks(day, ft)
    return day


def _fit_checks(day, ft):
    r = ft["residual"]
    day.add("fit_residual", "ok" if r["after"] <= r["before"] else "error",
            f"weighted residual {r['before']:,.0f} before, {r['after']:,.0f} after ({1 - r['after'] / r['before']:.0%} lower)" if r["before"]
            else "no residual recorded")
    T = np.array([[np.nan if v is None else v for v in row] for row in ft["hourly"]["target"]], float)
    A = np.array([[np.nan if v is None else v for v in row] for row in ft["hourly"]["after"]], float)
    over = A[:, -1] - T[:, -1]
    day.limit("fit_cap", np.where(over > 0, over, 0.0), np.full(24, TOL["fit_cap_mw"]), "fitted curve at the cap above the 2-day curve", warn_only=True)
    g_lsl = sum(v["lsl_fit"] for v in ft["groups"].values())
    t_lsl = sum(v["lsl_fit"] for v in ft["tech"].values())
    day.add("fit_sums", "ok" if abs(g_lsl - t_lsl) <= 2 else "error", f"fitted LSL by group {g_lsl:,.0f} MW, by technology {t_lsl:,.0f} MW")
    cols = ft["units"]["columns"]
    im, iv = cols.index("model"), cols.index("version")
    bad = sum(1 for row in ft["units"]["rows"] if not row[im] or not row[iv])
    day.add("fit_model", "ok" if not bad else "error", f"{bad} row(s) without a model name or version" if bad else "every row names its model and version")
    lsl_fit = _v(ft["hourly"]["lsl_fit"])
    at20 = T[:, 1]
    day.add("fit_lsl_vs_curve", "info", f"fitted committed minimum minus the 2-day curve at -$20, median hour {np.nanmedian(lsl_fit - at20):+.0f} MW "
            f"(the curve at -$20 holds most of the online LSL; units pricing minimum output above $0 sit higher)")
def _storage_checks(day, st, gen, dam):
    f = st["fleet"]
    # fleet discharging and charging against ERCOT's own ESR sums (independent file)
    if gen:
        h = gen["hourly"]
        for k, col, sign in (("dis", "sum_base_point_esr_discharging", 1.0), ("chg", "sum_base_point_esr_charging", -1.0)):
            if col in h:
                diff = _v(f[k]) - sign * _v(h[col])
                if not np.isnan(diff).all():
                    med, worst = float(np.nanmedian(np.abs(diff))), int(np.nanargmax(np.abs(diff)))
                    level = ("error" if med > TOL["storage_bp_mw"] else
                             "warning" if abs(diff[worst]) > TOL["storage_bp_max_mw"] else "ok")
                    day.add(f"storage_{k}_vs_2dgen", level,
                            f"battery {'discharging' if k == 'dis' else 'charging'}, per-unit minus generation summary: "
                            f"median hour {med:.0f} MW, worst {diff[worst]:+.0f} MW at hour {worst}")
    # every battery has 24 hours; DAM awards within limits and one direction per hour; SOC in its window
    short, over, soc_out, n_dam, n_soc = [], [], [], 0, 0
    for name, u in st["units"].items():
        if any(len(u[k] or [None] * 24) != 24 for k in ("bp", "out")):
            short.append(name)
        if u.get("dam"):
            n_dam += 1
            hsl, lsl = u.get("hsl") or 0.0, u.get("lsl") or 0.0
            bad = [a for a in u["dam"] if a is not None and (a > hsl + TOL["limit_mw"] or a < lsl - TOL["limit_mw"])]
            if bad:
                over.append(f"{name} {max(bad, key=abs):.0f} outside [{lsl:.0f}, {hsl:.0f}]")
        if u.get("soc"):
            n_soc += 1
            lo, hi = u.get("soc_min"), u.get("soc_max")
            vals = [v for v in u["soc"] if v is not None]
            if vals and lo is not None and hi is not None and hi > lo and (min(vals) < lo - TOL["soc_mwh"] or max(vals) > hi + TOL["soc_mwh"]):
                soc_out.append(f"{name} {min(vals):.0f}-{max(vals):.0f} vs [{lo:.0f}, {hi:.0f}]")
    day.add("storage_hours", "error" if short else "ok",
            f"{len(short)} battery(ies) without 24 hourly values, e.g. {short[:3]}" if short else f"{st['n_units']} batteries with 24 hourly values")
    if n_dam:
        # a DAM award is one signed number per hour, so one direction per hour holds by construction;
        # the check that can fail is the award against the battery's limits
        day.add("storage_dam_awards", "warning" if over else "ok",
                f"{len(over)} battery(ies) awarded outside HSL / LSL, e.g. {'; '.join(over[:3])}" if over
                else f"{n_dam} batteries with a DAM energy award, all within their limits")
        if dam:
            sced_names = set(st["units"])
            unmatched = sorted(n for n, u in dam["units"].items() if u.get("tech") == "storage" and n not in sced_names)
            day.add("storage_dam_names", "warning" if len(unmatched) > 0.1 * max(n_dam, 1) else "ok" if not unmatched else "info",
                    f"{len(unmatched)} DAM battery name(s) without a SCED match, e.g. {unmatched[:3]}" if unmatched
                    else "every DAM battery name matches a SCED battery")
    else:
        day.add("storage_dam_awards", "info", "no DAM battery rows for this day (DAM ESR file not loaded)")
    if n_soc:
        day.add("storage_soc", "warning" if soc_out else "ok",
                f"{len(soc_out)} battery(ies) with a state of charge outside its window, e.g. {'; '.join(soc_out[:3])}" if soc_out
                else f"{n_soc} of {st['n_units']} batteries report a state of charge, all inside their windows")
    else:
        day.add("storage_soc", "info", "no state of charge for this day (per-unit file predates format 7)")
    _storage_offer_checks(day, st)


def _storage_offer_checks(day, st):
    """Offer prices and MW by price (storage format 2): charging bids shrink and discharge offers
    grow as price rises, and both stay inside the fleet's limits."""
    f = st["fleet"]
    if not f.get("chg_ge"):
        day.add("storage_offers", "info", "no offer metrics in this battery day file (format 1)")
        return
    prices = sorted(f["chg_ge"], key=float)
    chg = np.array([_v(f["chg_ge"][p]) for p in prices])
    dis = np.array([_v(f["dis_le"][p]) for p in prices])
    if np.isnan(chg).all():
        day.add("storage_offers", "warning" if st.get("n_online") else "info", "no battery offer curves on this day")
        return
    tol = TOL["limit_mw"]
    with np.errstate(invalid="ignore"):
        bad_order = int((np.diff(chg, axis=0) > tol).sum() + (np.diff(dis, axis=0) < -tol).sum())
        over_chg = np.nanmax(chg[0] - (-_v(f["lsl"])))
        over_dis = np.nanmax(dis[-1] - _v(f["hsl"]))
    problems = ([f"{bad_order} hour-price step(s) where charging grows or discharge shrinks as price rises"] if bad_order else []) + \
               ([f"charging bids {over_chg:.0f} MW above the fleet's charging limit"] if over_chg > tol * 10 else []) + \
               ([f"discharge offers {over_dis:.0f} MW above the fleet's HSL"] if over_dis > tol * 10 else [])
    day.add("storage_offers", "error" if problems else "ok",
            "; ".join(problems) if problems else
            f"offer prices for {sum(1 for u in st['units'].values() if u.get('dis0'))} batteries; charging and discharge MW by price consistent with the fleet limits")


def _curve_checks(day, cv, uh):
    from .unit_curves import TECHS
    bad, n_curves = [], 0
    for name, u in cv["units"].items():
        n = len(u["curves"])
        n_curves += n
        if any(not -1 <= i < n for i in u["sub"] + u["used"]):
            bad.append(f"{name}: hourly index out of range")
        for p, mw in u["curves"]:
            if len(p) != len(mw) or np.any(np.diff(p) < -0.005) or np.any(np.diff(mw) < -0.05):
                bad.append(f"{name}: a curve whose price or MW falls")
                break
    if uh:
        names = [u[0] for u in uh["units"]]
        want = {(names[r[0]], r[1]) for r in uh["rows"] if uh["units"][r[0]][2] in TECHS}
        have_ = {(k, h + 1) for k, u in cv["units"].items() for h, v in enumerate(u["lim"]) if v is not None}
        # a unit online without any curve all day has no entry, so only extra hours are a mismatch
        extra = have_ - want
        if extra:
            bad.append(f"{len(extra)} unit-hours with curves that the hourly unit file has offline")
        miss = {k for k in want - have_ if k[0] in cv["units"]}
        if miss:
            bad.append(f"{len(miss)} online unit-hours missing from units that have curves")
    day.add("unit_curves", "error" if bad else "ok", "; ".join(bad[:5]) or
            f"{len(cv['units'])} thermal units, {n_curves} distinct curves, indices and limits agree with the hourly unit file")


def _stack_checks(day, fc, st):
    tol = 2.0
    fl = np.asarray(st["fleet"]["mw"], float)                 # [24][prices]
    drop = float(np.max(-np.diff(fl, axis=1))) if fl.shape[1] > 1 else 0.0
    g = np.sum([np.asarray(v["mw"], float) for v in st["group"].values()], axis=0)
    t = np.sum([np.asarray(v["mw"], float) for v in st["tech"].values()], axis=0)
    dg, dt_ = float(np.max(np.abs(g - fl))), float(np.max(np.abs(t - fl)))
    h = fc["hourly"]["fleet"]
    low = float(np.max(_v(h["min"]) - fl[:, 0]))
    high = float(np.max(fl[:, -1] - _v(h["hsl"])))
    bad = []
    if drop > tol:
        bad.append(f"MW falls by up to {drop:.0f} as the price rises")
    if dg > tol or dt_ > tol:
        bad.append(f"groups vs fleet {dg:.0f} MW, technologies vs fleet {dt_:.0f} MW")
    if low > tol:
        bad.append(f"floor {low:.0f} MW below the committed minimum")
    if high > tol:
        bad.append(f"top {high:.0f} MW above capacity")
    day.add("forecast_stack", "error" if bad else "ok", "; ".join(bad) or
            f"monotone, sums agree, floor {fl[:, 0].min():.0f}-{fl[:, 0].max():.0f} MW within "
            f"[committed minimum, capacity]")


def _forecast_checks(day, fc):
    tol = 2.0
    h = fc["hourly"]
    groups = fc["hourly"]["group"]
    bad = []
    for k in ("min", "exp", "hsl"):
        g = np.sum([_v(v[k]) for v in groups.values()], axis=0)
        t = np.sum([_v(v[k]) for v in h["tech"].values()], axis=0)
        f = _v(h["fleet"][k])
        c = np.sum([_v(v[k]) for v in h.get("category", {}).values()], axis=0) if h.get("category") else f
        if np.nanmax(np.abs(g - f)) > tol or np.nanmax(np.abs(t - f)) > tol or np.nanmax(np.abs(c - f)) > tol:
            bad.append(f"{k}: groups vs fleet {np.nanmax(np.abs(g - f)):.0f} MW, techs vs fleet {np.nanmax(np.abs(t - f)):.0f} MW, "
                       f"categories vs fleet {np.nanmax(np.abs(c - f)):.0f} MW")
    day.add("forecast_sums", "error" if bad else "ok", "; ".join(bad) or "group, technology, category and fleet series agree")
    f_min, f_exp, f_hsl = _v(h["fleet"]["min"]), _v(h["fleet"]["exp"]), _v(h["fleet"]["hsl"])
    over = int(((f_exp < f_min - tol) | (f_exp > f_hsl + tol)).sum())
    day.add("forecast_limits", "error" if over else "ok",
            f"{over} hour(s) with expected output outside [committed minimum, capacity]" if over
            else f"expected {f_exp.min():.0f}-{f_exp.max():.0f} MW within minimum {f_min.min():.0f} and capacity {f_hsl.max():.0f}")
    shares = []
    for k in ("baseload", "price_sensitive", "peakers"):
        c = fc["headline"].get(k) or {}
        if c.get("share") is not None:
            shares.append(c["share"])
    badp = [r for r in fc["units"]["rows"] if r[6] is not None and not 0 <= r[6] <= 1]
    day.add("forecast_shares", "error" if any(not 0 <= x <= 1 for x in shares) or badp else "ok",
            f"headline shares {shares}, {len(badp)} unit(s) with p_on outside [0, 1]")
    cap = fc["capacity"]["tech"]
    n_cap = sum(c["n_on"] + c["n_off"] + c["n_out"] + c["n_unknown"] for c in cap.values())
    n_rows = len(fc["units"]["rows"])
    day.add("forecast_counts", "ok" if n_cap == n_rows else "error",
            f"{n_cap} units in the capacity panel, {n_rows} unit rows")
    cols = fc["units"]["columns"]
    im, iv = cols.index("model"), cols.index("version")
    no_model = sum(1 for r in fc["units"]["rows"] if not r[im] or not r[iv])
    rc = fc["renewables"]["columns"]
    no_model += sum(1 for r in fc["renewables"]["rows"] if not r[rc.index("model")] or not r[rc.index("version")])
    series = [k for k in list(groups) + list(h["tech"]) + ["fleet", "wind", "solar"] + (["storage"] if h.get("storage") else []) if not h["model"].get(k)]
    st = h.get("storage")
    if st:
        dis, chg, soc = _v(st["dis"]), -_v(st["chg"]), _v(st["soc"])
        hs = fc["headline"].get("storage") or {}
        both = int(((dis > 0) & (chg > 0)).sum())
        neg = int(((dis < -tol) | (chg < -tol) | (soc < -tol)).sum())
        eff = hs.get("eff") or 1.0
        start = soc[0] - (chg[0] * eff - dis[0])
        energy_ok = np.nansum(dis) <= np.nansum(chg) * eff + start + 1.0
        day.add("forecast_storage", "error" if both or neg or not energy_ok else "ok",
                f"{both} hour(s) charging and discharging at once, {neg} negative value(s), "
                f"discharged {np.nansum(dis) / 1000:.1f} GWh against {np.nansum(chg) / 1000:.1f} GWh charged x {eff:.2f} + {start / 1000:.1f} GWh to start"
                if (both or neg or not energy_ok) else
                f"battery fleet: discharging peaks {np.nanmax(dis):,.0f} MW, charging {np.nanmax(chg):,.0f} MW, one direction per hour, energy balanced at {eff:.2f}")
        day.limit("forecast_storage_mw", np.maximum(dis, chg), np.full(24, TOL["storage_fleet_mw"]), "battery fleet MW above the fleet bound", warn_only=True)
    day.add("forecast_model", "ok" if not no_model and not series else "error",
            f"{no_model} row(s) without a model name or version; series without one: {series}" if (no_model or series)
            else "every row and series names its model and version")
    sc = read_json_gz(DATA_DIR / "forecast" / "scores.json.gz", default=None) or {"days": {}}
    s = sc["days"].get(fc["date"])
    has_answer = (DATA_DIR / "2dgen" / f"{fc['date']}.json.gz").exists()
    if has_answer:
        day.add("forecast_scored", "ok" if s and s.get("two_day") else "warning",
                "scored against the 2-day answer" if s and s.get("two_day") else "has a 2-day answer but no score")


def check_files(index):
    """Checks on files built once per run rather than per day (events, per-battery daily rows,
    cutoff history, unit index)."""
    from .events import FUEL, KINDS, PATH as EVENTS_PATH, _train
    from .models.cutoff_history import PATH as CUTOFF_PATH
    from .unit_index import PATH as UNIT_INDEX_PATH, TECHS as UNIT_INDEX_TECHS
    day = Day("events")
    ev = read_json_gz(EVENTS_PATH, default=None)
    if ev is None:
        return day
    events = ev.get("events", [])
    ids = [e.get("id") for e in events]
    dup = len(ids) - len(set(ids))
    day.add("events_ids", "error" if dup else "ok", f"{dup} duplicate id(s)" if dup else "unique")
    bad_kind = sorted({e.get("kind") for e in events if e.get("kind") not in KINDS})
    day.add("events_kinds", "error" if bad_kind else "ok", f"unknown kind(s) {bad_kind[:5]}" if bad_kind else "all known")
    known = set()
    for name, key in (("decisions.json.gz", "units"), ("groups_60d.json.gz", "units")):
        known |= set((read_json_gz(DATA_DIR / name, default={}) or {}).get(key, {}))
    known |= {u["unit"] for u in (read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}).get("units", [])}
    for e in (read_json_gz(DATA_DIR / "renew_changes.json.gz", default={}) or {}).get("events", []):
        known.add(e.get("plant")); known |= set(e.get("units") or [])
    known |= {f"fleet:{t}" for t in FUEL}      # fleet-wide fuel events
    hb = read_json_gz(DATA_DIR / "storage" / "habits.json.gz", default={}) or {}
    known |= set(hb.get("units", {}))           # battery events
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    known |= {_train(u) for u in tr.get("first_seen") or {}}   # new units (combined cycle by train)
    unknown = sorted({e["unit"] for e in events if e.get("unit") not in known})
    day.add("events_units", "error" if unknown else "ok", f"{len(unknown)} unknown unit(s), e.g. {unknown[:5]}" if unknown else "all known")
    d60 = sorted(index["days"].get("60d", []))
    last = max((max(v) for v in index["days"].values() if v), default=None)
    bad_date = []
    for e in events:
        try:
            dt.date.fromisoformat(e.get("date") or "")
        except ValueError:
            bad_date.append(e.get("id")); continue
        if (last and e["date"] > last) or (not e["kind"].startswith("renew_") and d60 and not d60[0] <= e["date"] <= d60[-1]):
            bad_date.append(e["id"])
    day.add("events_dates", "error" if bad_date else "ok", f"{len(bad_date)} event(s) outside the record, e.g. {bad_date[:3]}" if bad_date else "inside the record")
    no_seen = [e["id"] for e in events if not e.get("seen")]
    day.add("events_seen", "error" if no_seen else "ok", f"{len(no_seen)} event(s) without a first-seen date" if no_seen else "every event dated")
    for name in ("units.json.gz", "habits.json.gz"):     # per-battery daily rows (storage.py)
        su = read_json_gz(DATA_DIR / "storage" / name, default=None)
        if su is None:
            continue
        n = len(su.get("dates", []))
        bad = [u for u, r in su.get("units", {}).items() if set(r) != set(su.get("fields", [])) or any(len(v) != n for v in r.values())]
        hr = [u for u, r in su.get("units", {}).items() if any(v is not None and not 0 <= v <= 1 for k in ("chg_tb", "dis_tb") for v in r.get(k, []))]
        neg = [u for u, r in su.get("units", {}).items() if any(v is not None and v < 0 for k in ("hsl", "soc_max", "dis", "chg") for v in r.get(k, []))]
        day.add(f"storage_{name.split('.')[0]}", "error" if bad or hr or neg else "ok",
                f"{len(bad)} battery row(s) not one value per day per field, {len(hr)} with a share in the top or bottom hours outside 0 to 1, "
                f"{len(neg)} with a negative size or MWh, e.g. {(bad + hr + neg)[:3]}" if bad or hr or neg else f"{len(su.get('units', {}))} batteries, {n} days")
    ch = read_json_gz(CUTOFF_PATH, default=None)
    if ch is not None:
        ok = bool(ch.get("model")) and bool(ch.get("version"))
        day.add("cutoff_model", "ok" if ok else "error", f"{ch.get('model')} {ch.get('version')}")
        bad = [k for k, u in ch.get("units", {}).items()
               if not (u.get("lsl") or 0) > 0 or any(not isinstance(r[1], (int, float, type(None))) or not isinstance(r[2], (int, float, type(None))) for r in u.get("rows", []))]
        day.add("cutoff_rows", "error" if bad else "ok", f"{len(bad)} unit(s) with bad rows, e.g. {bad[:3]}" if bad else f"{len(ch.get('units', {}))} units")
        orphan = [m["unit"] for m in ch.get("moves", []) if m["unit"] not in ch.get("units", {}) or not isinstance(m.get("to"), (int, float))]
        day.add("cutoff_moves", "error" if orphan else "ok", f"{len(orphan)} move(s) without rows, e.g. {orphan[:3]}" if orphan else f"{len(ch.get('moves', []))} moves")
    ui = read_json_gz(UNIT_INDEX_PATH, default=None)
    if ui is not None:
        rows = ui.get("rows", [])
        names = [r[0] for r in rows]
        dup = len(names) - len(set(names))
        day.add("unit_index_names", "error" if dup or not rows else "ok", f"{dup} duplicate name(s)" if dup else f"{len(rows)} units" if rows else "empty")
        bad = [r[0] for r in rows if r[1] not in UNIT_INDEX_TECHS or (r[3] is not None and not r[3] >= 0)]
        day.add("unit_index_rows", "error" if bad else "ok", f"{len(bad)} row(s) with an unknown tech or bad MW, e.g. {bad[:3]}" if bad else "techs known, MW non-negative")
    return day


def _have(index):
    have = {k: set(index["days"].get(k, [])) for k in ("2d", "60d", "2dgen", "dam", "prices")}
    fc = read_json_gz(DATA_DIR / "forecast" / "index.json.gz", default=None) or {}
    have["forecast"] = set(fc.get("days", []))
    have["fit"] = set(index["days"].get("fit", []))
    have["storage"] = set(index["days"].get("storage", []))
    return have


def _level(results):
    levels = {r[1] for r in results}
    return "error" if "error" in levels else "warning" if "warning" in levels else "ok"


def run(dates, index, fail=True):
    have = _have(index)
    report = json.loads(REPORT_PATH.read_text()) if REPORT_PATH.exists() else {"days": {}}
    # errors already recorded for a day (committed with "ignore checks") do not fail a later
    # run that re-checks the day because a new source arrived; only new errors do
    known = {(date, c[0]) for date, e in report["days"].items() for c in e.get("checks", []) if c[1] == "error"}
    checked = []
    for date in sorted(dates):
        day = check_day(date, have)
        if not day.results:
            continue
        # sources present, so a day is re-checked once its 60-day data arrives
        # only checks that did not pass are kept, to keep the file small
        report["days"][date] = {"sources": sorted(k for k in have if date in have[k]),
                                "level": _level(day.results), "n_checks": len(day.results),
                                "checks": [r for r in day.results if r[1] != "ok"]}
        checked.append(day)
    files = check_files(index)
    if files.results:
        report["days"]["events"] = {"sources": ["events"], "level": _level(files.results), "n_checks": len(files.results),
                                    "checks": [r for r in files.results if r[1] != "ok"]}
        checked.append(files)
    if checked:     # leave the file untouched when nothing new was checked (no empty data commits)
        report["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        report["days"] = dict(sorted(report["days"].items()))
        REPORT_PATH.write_text(json.dumps(report, separators=(",", ":")))

    errors = [(d.date, r) for d in checked for r in d.results if r[1] == "error"]
    warnings_ = [(d.date, r) for d in checked for r in d.results if r[1] == "warning"]
    new_errors = [(date, r) for date, r in errors if (date, r[0]) not in known]
    for date, r in errors:
        tag = "" if (date, r[0]) not in known else " (already recorded, not blocking)"
        print(f"::error::validation {date} {r[0]}: {r[2]}{tag}" if _gha() else f"  ERROR {date} {r[0]}: {r[2]}{tag}")
    for date, r in warnings_:
        warn(f"validation {date} {r[0]}: {r[2]}")
    lines = ["### Accuracy checks", "",
             f"{len(checked)} day(s) checked: {len(errors)} error(s) ({len(new_errors)} new), {len(warnings_)} warning(s).", ""]
    if errors or warnings_:
        lines += ["| Day | Check | Level | Detail |", "|---|---|---|---|"]
        lines += [f"| {d} | {r[0]} | {r[1]} | {r[2]} |" for d, r in (errors + warnings_)[:80]]
    write_summary(lines)
    print("\n".join(lines))
    return 1 if (new_errors and fail) else 0


def _gha():
    import os
    return os.environ.get("GITHUB_ACTIONS") == "true"


def pending_days(index):
    """Days whose sources changed since they were last checked (or never checked)."""
    report = json.loads(REPORT_PATH.read_text()) if REPORT_PATH.exists() else {"days": {}}
    have = _have(index)
    out = []
    for date in set().union(*have.values()):
        now = sorted(k for k in have if date in have[k])
        if report["days"].get(date, {}).get("sources") != now:
            out.append(date)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dates", nargs="*", help="operating days to check (default: new or changed days)")
    ap.add_argument("--all", action="store_true", help="check every day")
    ap.add_argument("--no-fail", action="store_true", help="exit 0 even if a check fails")
    args = ap.parse_args(argv)
    index = json.loads((DATA_DIR / "index.json").read_text())
    if args.all:
        dates = set().union(*(set(v) for v in index["days"].values()))
    else:
        dates = args.dates or pending_days(index)
    return run(dates, index, fail=not args.no_fail)


if __name__ == "__main__":
    sys.exit(main())
