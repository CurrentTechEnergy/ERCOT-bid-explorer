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
    return day


def _level(results):
    levels = {r[1] for r in results}
    return "error" if "error" in levels else "warning" if "warning" in levels else "ok"


def run(dates, index, fail=True):
    have = {k: set(index["days"].get(k, [])) for k in ("2d", "60d", "2dgen", "dam", "prices")}
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
    have = {k: set(index["days"].get(k, [])) for k in ("2d", "60d", "2dgen", "dam", "prices")}
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
