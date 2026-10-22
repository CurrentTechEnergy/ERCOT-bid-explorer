"""Score every forecast day against what happened, so the track record the page shows is the
number the model gate used (site layout plan, section 6.2).

Two answers per day:
  two_day    from the 2-day generation summary (data/2dgen/, two days after the day):
             thermal expected output (the fleet series) against ERCOT's summed base points for
             Non-IRR plus "remaining resources" (nuclear sits in the latter; storage was in it
             until ESR_SPLIT_DATE and is taken out for those days, as validate.py found), hour
             by hour; wind and solar expected dispatch against the summed WGR / PVGR base
             points.  The reference also holds hydro and the "other" resources the models
             leave out (about 1 GW), so the thermal bias runs low by that much; the gap is
             recorded, not hidden.
  sixty_day  from the per-unit rows (data/60d-units/) and hourly states, sixty days on:
             expected output by timescale group and technology against actual output, and
             the commitment call per unit: a unit judged on (or maybe) was right when it ran
             at least half of its hours with data; one judged off when it did not.  Peakers
             are scored on the share of hours online against the mean p_on.

  fit        the 2-day fit (pipeline/models/two_day_fit, data/fit/): its residual against the
             2-day curve before and after, and, sixty days on, the committed minimum (online
             LSL by hour, fleet and by group) of the forecast and of the fit against the
             60-day online LSL, the fit's on/off calls beside the forecast's on the same units,
             and how often it named the right combined-cycle configuration

  floor      (in sixty_day) the committed minimum: the forecast's fleet "min" series against
             the summed LSL of thermal units online at least half the hour, hour by hour, over
             all hours, the cheap hours (day-ahead hub at or below CHEAP_HUB) and the negative
             ones; kept as sums (hours, absolute error, error, expected, actual, MW-h) so the
             summary weights every hour alike.  This is the number that says how much thermal
             gets out of the way when prices are low; the daily GWh call barely sees it.
  floor_parts  (in sixty_day) the same error split by cause, unit by unit and hour by hour,
             so errors that cancel in the fleet sum show up (v10 held about 2 GW on units that
             were out and ran about 2 GW short on units that were available): each unit-hour's
             committed minimum (its "min" series) less its online LSL goes to
               outage   the unit was offline and in the outage state that hour
               onoff    offline and not on outage, or online while the forecast held it at
                        under half weight (p < 0.5)
               sizing   online and held at half weight or more: the size it was given
               other    online units the forecast has no row for
             kept as sums per part over all and cheap hours, as floor

Per day: mean absolute error (MW over 24 hours), bias (expected minus actual), expected and
actual GWh, and the headline call: right when expected thermal GWh is within HEADLINE_TOL of
the 2-day answer.  Summary: hit rates and mean errors by price band, keyed by the model
versions that produced the files, over the as-of days only: a day whose models read history
it could not have had (the first LAG days, inputs.hindsight; groups and stats from a point
with too little history, inputs.asof_hindsight; a curve snapshot from after the day,
inputs.curve_hindsight) is scored and kept per day, flagged "asof": false, and left out of
the summary, which counts it in n_hindsight.

Writes data/forecast/scores.json.gz:
  days[date]   {"versions": {...}, "band", "two_day": {...} | null, "sixty_day": {...} | null,
                "fit": {...} | null}
  days[date]["asof"]  false for a hindsight day (left out of the summary)
  summary      {versions key: {n, n_hindsight, headline_hit, thermal_mae, thermal_bias, unit_hit,
                n_judged, wind_mae, solar_mae, floor: {all, cheap, neg: {hours, mae, bias, exp,
                act} (MW)}, floor_parts: {part: {all, cheap: {hours, mae, bias}}}, by_band: {band: {...}}, group: {g: {mae, bias, n}}}}
"""
import numpy as np

from ..config import DATA_DIR
from ..intraday import train_of
from ..store import read_json_gz, write_json_gz
from . import context as C
from .build import GROUPS

PATH = DATA_DIR / "forecast" / "scores.json.gz"
FLOOR_PARTS = ("outage", "onoff", "sizing", "other")
HEADLINE_TOL = 0.10
CHEAP_HUB = C.CHEAP_HUB          # $/MWh: an hour at or below this day-ahead hub price is a cheap hour
ESR_SPLIT_DATE = "2026-06-22"     # before this, ERCOT's "remaining resources" included storage


def _arr(v):
    return np.array([np.nan if x is None else float(x) for x in (v or [None] * 24)][:24], float)


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def score_two_day(day: dict) -> dict:
    gen = read_json_gz(DATA_DIR / "2dgen" / f"{day['date']}.json.gz")
    if not gen:
        return None
    h = gen.get("hourly", {})
    non_irr = _arr(h.get("sum_base_point_non_irr"))
    if h.get("sum_base_point_remaining_res"):
        rem = _arr(h["sum_base_point_remaining_res"])
        if day["date"] < ESR_SPLIT_DATE and h.get("sum_base_point_esr"):
            rem = rem - _arr(h["sum_base_point_esr"])
        non_irr = non_irr + rem
    exp = _arr(day["hourly"]["fleet"]["exp"])
    out = {}
    ok = ~np.isnan(non_irr) & ~np.isnan(exp)
    if ok.any():
        d = exp[ok] - non_irr[ok]
        out["thermal_mae"] = _r(np.abs(d).mean()); out["thermal_bias"] = _r(d.mean())
        out["thermal_gwh_exp"] = _r(np.nansum(exp) / 1000, 2); out["thermal_gwh_act"] = _r(np.nansum(non_irr) / 1000, 2)
        err = (np.nansum(exp) - np.nansum(non_irr)) / np.nansum(non_irr) if np.nansum(non_irr) else np.nan
        out["gwh_err"] = _r(err, 3)
        out["headline_hit"] = bool(abs(err) <= HEADLINE_TOL) if np.isfinite(err) else None
    for t, col in (("wind", "sum_base_point_wgr"), ("solar", "sum_base_point_pvgr")):
        act = _arr(h.get(col))
        ser = day["hourly"].get(t)
        if ser is None or np.isnan(act).all():
            continue
        disp = _arr(ser["disp"])
        ok = ~np.isnan(act) & ~np.isnan(disp)
        if ok.any():
            d = disp[ok] - act[ok]
            out[f"{t}_mae"] = _r(np.abs(d).mean()); out[f"{t}_bias"] = _r(d.mean())
            out[f"{t}_gwh_act"] = _r(np.nansum(act) / 1000, 2)
    # batteries: fleet discharging and charging against the summary's ESR series
    st = day["hourly"].get("storage")
    for k, col, sign in (("dis", "sum_base_point_esr_discharging", 1.0), ("chg", "sum_base_point_esr_charging", -1.0)):
        act = sign * _arr(h.get(col))
        if np.isnan(act).all():
            continue
        out[f"storage_{k}_gwh_act"] = _r(np.nansum(act) / 1000, 2)
        if st:
            exp = sign * _arr(st[k])
            ok = ~np.isnan(act) & ~np.isnan(exp)
            if ok.any():
                d = exp[ok] - act[ok]
                out[f"storage_{k}_mae"] = _r(np.abs(d).mean()); out[f"storage_{k}_bias"] = _r(d.mean())
                out[f"storage_{k}_gwh_exp"] = _r(np.nansum(exp) / 1000, 2)
                out[f"storage_{k}_peak_err"] = _r(np.nanmax(exp) - np.nanmax(act))
    return out or None


def score_sixty_day(day: dict, ctx: C.Context) -> dict:
    date = day["date"]
    rows_file = read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz")
    if not rows_file:
        return None
    cols = {c: i + 2 for i, c in enumerate(rows_file["columns"])}
    names = rows_file["units"]
    act = {}          # train -> (output[24], online[24])
    on_lsl = np.zeros(24)
    key_lsl = {}      # train -> online LSL[24]
    for r in rows_file["rows"]:
        name, t = names[r[0]][0], names[r[0]][2]
        if t not in C.THERMAL:
            continue
        key = train_of(name) if t == "combined_cycle" else name
        o, on = act.setdefault(key, (np.zeros(24), np.zeros(24)))
        h = r[1] - 1
        if r[cols["output"]] is not None:
            o[h] += r[cols["output"]]
        if (r[cols["online_share"]] or 0) >= 0.5:
            on[h] = 1
            on_lsl[h] += r[cols["lsl"]] or 0.0
            key_lsl.setdefault(key, np.zeros(24))[h] += r[cols["lsl"]] or 0.0
    uc = {c: i for i, c in enumerate(day["units"]["columns"])}
    by_g = {g: [np.zeros(24), np.zeros(24)] for g in GROUPS}
    by_t = {t: [np.zeros(24), np.zeros(24)] for t in C.THERMAL}
    hits, judged = 0, 0
    peak_on, peak_p = [], []
    exp_rows = {}
    for r in day["units"]["rows"]:
        key, tech, g, verdict, p_on = r[uc["unit"]], r[uc["tech"]], r[uc["group"]], r[uc["verdict"]], r[uc["p_on"]]
        a = act.get(key)
        on_share = float(a[1].mean()) if a is not None else 0.0
        if verdict in ("on", "maybe", "off"):
            judged += 1
            hits += int((verdict != "off") == (on_share >= 0.5))
        elif verdict == "peaker":
            peak_on.append(on_share); peak_p.append(p_on or 0.0)
    # expected by group / tech from the hourly series; actual summed by each train's group
    for r in day["units"]["rows"]:
        key, tech, g = r[uc["unit"]], r[uc["tech"]], r[uc["group"]]
        a = act.get(key)
        if a is None:
            continue
        if g in by_g:
            by_g[g][1] += a[0]
        by_t[tech][1] += a[0]
    for g in GROUPS:
        by_g[g][0] = _arr(day["hourly"]["group"][g]["exp"])
    for t in C.THERMAL:
        by_t[t][0] = _arr(day["hourly"]["tech"][t]["exp"])
    def stat(e, a):
        d = e - a
        return {"mae": _r(np.abs(d).mean()), "bias": _r(d.mean()), "exp_gwh": _r(e.sum() / 1000, 2), "act_gwh": _r(a.sum() / 1000, 2)}
    out = {"unit_hit": _r(hits / judged, 3) if judged else None, "n_judged": judged,
           "peaker_online_share": _r(np.mean(peak_on), 3) if peak_on else None,
           "peaker_p_on": _r(np.mean(peak_p), 3) if peak_p else None,
           "group": {g: stat(e, a) for g, (e, a) in by_g.items()},
           "tech": {t: stat(e, a) for t, (e, a) in by_t.items()}}
    fe = sum(_arr(day["hourly"]["tech"][t]["exp"]) for t in C.THERMAL)
    fa = sum(by_t[t][1] for t in C.THERMAL)
    out["fleet"] = stat(fe, fa)
    out["floor"] = score_floor(_arr(day["hourly"]["fleet"]["min"]), on_lsl, _arr(day["headline"].get("hub")))
    out["floor_parts"] = score_floor_parts(day, key_lsl, _states(ctx, date), _arr(day["headline"].get("hub")))
    return out


def _states(ctx: C.Context, date: str) -> dict:
    """{train: [24] merged hourly states (m, a, 0, o, -)} for `date` from the 60-day unit hours,
    outage spells not rewritten; {} when the day is outside them."""
    dates = (ctx.uh or {}).get("dates") or []
    if not dates:
        return {}
    dn = (C._d(date) - C._d(dates[0])).days
    out = {}
    for key, (_, st) in ctx.raw_states().items():
        if 0 <= dn and (dn + 1) * 24 <= len(st):
            out[key] = st[dn * 24:(dn + 1) * 24]
    return out


def score_floor_parts(day: dict, key_lsl: dict, states: dict, hub) -> dict | None:
    """The floor error split by cause (FLOOR_PARTS, module docstring), as sums over all and
    cheap hours like score_floor.  None for a forecast file without unit hours."""
    uh = (day.get("unit_hours") or {})
    series = uh.get("series") or []
    if "min" not in series or "p" not in series:
        return None
    ip, im = series.index("p"), series.index("min")
    err = {k: np.zeros(24) for k in FLOOR_PARTS}
    for key, s in (uh.get("units") or {}).items():
        mn, p = _arr(s[im]), _arr(s[ip])
        if mn.shape != (24,) or p.shape != (24,):
            continue
        mn, p = np.nan_to_num(mn), np.nan_to_num(p)
        a = key_lsl.get(key, np.zeros(24))
        st = np.asarray(states.get(key, ["-"] * 24))
        on = a > 0
        out = ~on & (st == "o")
        sizing = on & (p >= 0.5)
        e = mn - a
        err["outage"] += np.where(out, e, 0.0)
        err["sizing"] += np.where(sizing, e, 0.0)
        err["onoff"] += np.where(~out & ~sizing, e, 0.0)
    for key, a in key_lsl.items():
        if key not in (uh.get("units") or {}):
            err["other"] -= a
    ok = ~np.isnan(hub) if hub.shape == (24,) else np.zeros(24, bool)
    res = {}
    for part, e in err.items():
        res[part] = {}
        for k, sel in (("all", ok), ("cheap", ok & (np.nan_to_num(hub, nan=np.inf) <= CHEAP_HUB))):
            res[part][k] = {"hours": int(sel.sum()), "abs": _r(np.abs(e[sel]).sum()), "err": _r(e[sel].sum())}
    return res


CAL_BINS = [0.0, 0.05, 0.2, 0.4, 0.6, 0.8, 0.95, 1.0001]   # P(on) bins of the reliability table


def calibration(days: dict, out_dir) -> dict:
    """Brier score and reliability of P(on) for the units judged on their loss window (verdict
    on, maybe or off with a window), over the as-of days with a 60-day answer: each unit-day's
    P(on) against the share of the window's hours it was online.  Read from the forecast day
    files in out_dir, so a backtest can score a side written by older code the same way.
    {n, brier, bins: [[lo, hi, n, mean p, online share]]}."""
    n, sq = 0, 0.0
    bins = [[0, 0.0, 0.0] for _ in CAL_BINS[:-1]]
    for date, s in sorted(days.items()):
        if s.get("asof") is False or not s.get("sixty_day"):
            continue
        day = read_json_gz(out_dir / f"{date}.json.gz")
        rf = read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz")
        if not day or not rf:
            continue
        cols = {c: i + 2 for i, c in enumerate(rf["columns"])}
        on = {}
        for r in rf["rows"]:
            name, t = rf["units"][r[0]][0], rf["units"][r[0]][2]
            if t not in C.THERMAL:
                continue
            key = train_of(name) if t == "combined_cycle" else name
            if (r[cols["online_share"]] or 0) >= 0.5:
                on.setdefault(key, np.zeros(24))[r[1] - 1] = 1
        uc = {c: i for i, c in enumerate(day["units"]["columns"])}
        for r in day["units"]["rows"]:
            wf, wh = r[uc["win_from"]] if "win_from" in uc else None, r[uc["win_hours"]] if "win_hours" in uc else None
            if r[uc["verdict"]] not in ("on", "maybe", "off") or not wf or not wh:
                continue
            p = float(r[uc["p_on"]] or 0.0)
            yv = float(on.get(r[uc["unit"]], np.zeros(24))[wf - 1:wf - 1 + wh].mean())
            n += 1; sq += (p - yv) ** 2
            b = bins[min(np.searchsorted(CAL_BINS, p, side="right") - 1, len(bins) - 1)]
            b[0] += 1; b[1] += p; b[2] += yv
    return {"n": n, "brier": _r(sq / n, 4) if n else None,
            "bins": [[CAL_BINS[i], min(CAL_BINS[i + 1], 1.0), b[0], _r(b[1] / b[0], 3) if b[0] else None,
                      _r(b[2] / b[0], 3) if b[0] else None] for i, b in enumerate(bins)]}


def score_floor(exp_min, act_lsl, hub) -> dict:
    """Committed minimum against online LSL as sums over all, cheap and negative hours."""
    ok = ~np.isnan(exp_min) & ~np.isnan(act_lsl)
    out = {}
    for k, sel in (("all", ok), ("cheap", ok & (hub <= CHEAP_HUB)), ("neg", ok & (hub <= 0))):
        d = exp_min[sel] - act_lsl[sel]
        out[k] = {"hours": int(sel.sum()), "abs": _r(np.abs(d).sum()), "err": _r(d.sum()),
                  "exp": _r(exp_min[sel].sum()), "act": _r(act_lsl[sel].sum())}
    return out


def _floor_summary(sd: list) -> dict:
    """Hour-weighted floor errors (MW) over the days' sums."""
    out = {}
    for k in ("all", "cheap", "neg"):
        parts = [s["floor"][k] for s in sd if s.get("floor")]
        n = sum(p["hours"] for p in parts)
        out[k] = {"hours": n,
                  "mae": _r(sum(p["abs"] for p in parts) / n) if n else None,
                  "bias": _r(sum(p["err"] for p in parts) / n) if n else None,
                  "exp": _r(sum(p["exp"] for p in parts) / n) if n else None,
                  "act": _r(sum(p["act"] for p in parts) / n) if n else None}
    return out


def _floor_parts_summary(sd: list) -> dict | None:
    """Hour-weighted MAE and bias (MW) of each floor part over the days that have them."""
    fp = [s["floor_parts"] for s in sd if s.get("floor_parts")]
    if not fp:
        return None
    out = {}
    for part in FLOOR_PARTS:
        out[part] = {}
        for k in ("all", "cheap"):
            parts = [f[part][k] for f in fp if part in f]
            n = sum(x["hours"] for x in parts)
            out[part][k] = {"hours": n, "mae": _r(sum(x["abs"] for x in parts) / n) if n else None,
                            "bias": _r(sum(x["err"] for x in parts) / n) if n else None}
    return out


def score_fit(day: dict, ctx: C.Context) -> dict:
    """The 2-day fit for the day against the 60-day answer, beside the forecast."""
    date = day["date"]
    ft = read_json_gz(DATA_DIR / "fit" / f"{date}.json.gz")
    if not ft:
        return None
    out = {"version": ft.get("version"), "residual_before": ft["residual"]["before"], "residual_after": ft["residual"]["after"],
           "n_changed": ft["inputs"].get("n_changed"), "lsl_fc_gwh": _r(np.nansum(_arr(ft["hourly"]["lsl_forecast"])) / 1000, 2),
           "lsl_fit_gwh": _r(np.nansum(_arr(ft["hourly"]["lsl_fit"])) / 1000, 2)}
    rows_file = read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz")
    if not rows_file:
        return out
    cols = {c: i + 2 for i, c in enumerate(rows_file["columns"])}
    names = rows_file["units"]
    on_lsl, on_share, configs = {}, {}, {}
    for r in rows_file["rows"]:
        name, t = names[r[0]][0], names[r[0]][2]
        if t not in ("coal", "combined_cycle", "gas_steam"):
            continue
        key = train_of(name) if t == "combined_cycle" else name
        a = on_lsl.setdefault(key, np.zeros(24))
        if (r[cols["online_share"]] or 0) >= 0.5:
            a[r[1] - 1] += r[cols["lsl"]] or 0.0
            on_share[key] = on_share.get(key, 0) + 1
            configs.setdefault(key, set()).add(name)
    fc = {c: i for i, c in enumerate(ft["units"]["columns"])}
    group_of = {r[fc["unit"]]: (r[fc["group"]] or "ungrouped") for r in ft["units"]["rows"]}
    act_fleet = sum(on_lsl.values()) if on_lsl else np.zeros(24)
    act_group = {}
    for key, a in on_lsl.items():
        g = group_of.get(key)
        if g:
            act_group[g] = act_group.get(g, np.zeros(24)) + a
    lsl_fc, lsl_fit = _arr(ft["hourly"]["lsl_forecast"]), _arr(ft["hourly"]["lsl_fit"])
    out["lsl_act_gwh"] = _r(act_fleet.sum() / 1000, 2)
    out["lsl_mae_fc"] = _r(np.nanmean(np.abs(lsl_fc - act_fleet)))
    out["lsl_mae_fit"] = _r(np.nanmean(np.abs(lsl_fit - act_fleet)))
    out["lsl_bias_fc"] = _r(np.nanmean(lsl_fc - act_fleet))
    out["lsl_bias_fit"] = _r(np.nanmean(lsl_fit - act_fleet))
    # by group: the fit file carries daily sums only, so compare the day's mean online LSL
    out["group"] = {}
    for g, agg in ft["groups"].items():
        act = float(act_group.get(g, np.zeros(24)).mean())
        out["group"][g] = {"lsl_fc": agg["lsl_fc"], "lsl_fit": agg["lsl_fit"], "lsl_act_mean": _r(act),
                           "err_fc": _r(agg["lsl_fc"] - act), "err_fit": _r(agg["lsl_fit"] - act)}
    hit_fc = hit_fit = judged = cfg_hit = cfg_n = 0
    for r in ft["units"]["rows"]:
        key = r[fc["unit"]]
        if key not in on_lsl:
            continue
        on = (on_share.get(key, 0) / 24.0) >= 0.5
        v, p = r[fc["forecast"]], r[fc["p_on"]] or 0.0
        fc_on = (p >= 0.5) if v == "nocut" else v not in ("off", "outage")
        fit_on = r[fc["fit"]] != "off"
        judged += 1; hit_fc += int(fc_on == on); hit_fit += int(fit_on == on)
        if fit_on and on and r[fc["config"]]:
            cfg_n += 1; cfg_hit += int(r[fc["config"]] in configs.get(key, ()))
    out.update(n_judged=judged, unit_hit_fc=_r(hit_fc / judged, 3) if judged else None,
               unit_hit_fit=_r(hit_fit / judged, 3) if judged else None,
               config_hit=_r(cfg_hit / cfg_n, 3) if cfg_n else None, n_config=cfg_n)
    return out


def score_days(days: list, ctx: C.Context, out_dir) -> dict:
    scores = read_json_gz(PATH, default=None) or {"days": {}}
    for date in days:
        day = read_json_gz(out_dir / f"{date}.json.gz")
        if not day:
            continue
        inp = day.get("inputs", {})
        scores["days"][date] = {"versions": day["models"], "band": day["headline"].get("band"),
                                "asof": not (inp.get("hindsight") or inp.get("asof_hindsight") or inp.get("curve_hindsight")),
                                "two_day": score_two_day(day), "sixty_day": score_sixty_day(day, ctx),
                                "fit": score_fit(day, ctx)}
    scores["days"] = {d: v for d, v in sorted(scores["days"].items()) if d in set(days)}
    scores["summary"] = summarise(scores["days"])
    scores["headline_tol"] = HEADLINE_TOL
    write_json_gz(PATH, scores)
    return scores


def _vkey(versions):
    return " ".join(f"{k}={v}" for k, v in sorted(versions.items()) if v)


def summarise(days: dict, asof_only: bool = True) -> dict:
    """Summary per model-versions key; asof_only leaves hindsight days out (counted in
    n_hindsight)."""
    by, skipped = {}, {}
    for d, s in days.items():
        k = _vkey(s["versions"])
        if asof_only and s.get("asof") is False:
            skipped[k] = skipped.get(k, 0) + 1
            continue
        by.setdefault(k, []).append(s)
    out = {}
    for k, lst in by.items():
        def agg(items):
            td = [s["two_day"] for s in items if s.get("two_day")]
            sd = [s["sixty_day"] for s in items if s.get("sixty_day")]
            hits = [s["headline_hit"] for s in td if s.get("headline_hit") is not None]
            uh = [(s["unit_hit"], s["n_judged"]) for s in sd if s.get("unit_hit") is not None]
            res = {"n": len(items), "n_two_day": len(td), "n_sixty_day": len(sd),
                   "headline_hit": _r(np.mean(hits), 3) if hits else None,
                   "thermal_mae": _r(np.mean([s["thermal_mae"] for s in td if s.get("thermal_mae") is not None])) if td else None,
                   "thermal_bias": _r(np.mean([s["thermal_bias"] for s in td if s.get("thermal_bias") is not None])) if td else None,
                   "wind_mae": _r(np.mean([s["wind_mae"] for s in td if s.get("wind_mae") is not None])) if any(s.get("wind_mae") is not None for s in td) else None,
                   "solar_mae": _r(np.mean([s["solar_mae"] for s in td if s.get("solar_mae") is not None])) if any(s.get("solar_mae") is not None for s in td) else None,
                   "storage_dis_mae": _r(np.mean([s["storage_dis_mae"] for s in td if s.get("storage_dis_mae") is not None])) if any(s.get("storage_dis_mae") is not None for s in td) else None,
                   "storage_chg_mae": _r(np.mean([s["storage_chg_mae"] for s in td if s.get("storage_chg_mae") is not None])) if any(s.get("storage_chg_mae") is not None for s in td) else None,
                   "storage_peak_bias": _r(np.mean([s["storage_dis_peak_err"] for s in td if s.get("storage_dis_peak_err") is not None])) if any(s.get("storage_dis_peak_err") is not None for s in td) else None,
                   "n_storage": sum(1 for s in td if s.get("storage_dis_mae") is not None),
                   "unit_hit": _r(sum(h * n for h, n in uh) / sum(n for _, n in uh), 3) if uh and sum(n for _, n in uh) else None,
                   "n_judged": int(sum(n for _, n in uh))}
            # a group scored on only some days (one added since older score files were written) averages over those days
            res["group"] = {g: {"mae": _r(np.mean([s["group"][g]["mae"] for s in gd])), "bias": _r(np.mean([s["group"][g]["bias"] for s in gd])), "n": len(gd)}
                            for g in GROUPS for gd in [[s for s in sd if g in s["group"]]] if gd} if sd else None
            ft = [s["fit"] for s in items if s.get("fit")]
            fs = [f for f in ft if f.get("lsl_mae_fit") is not None]
            res["fit"] = {"n": len(ft), "n_sixty_day": len(fs), "version": ft[-1].get("version") if ft else None,
                          "residual_cut": _r(1 - np.mean([f["residual_after"] / f["residual_before"] for f in ft if f.get("residual_before")]), 3) if ft else None,
                          "lsl_mae_fc": _r(np.mean([f["lsl_mae_fc"] for f in fs])) if fs else None,
                          "lsl_mae_fit": _r(np.mean([f["lsl_mae_fit"] for f in fs])) if fs else None,
                          "unit_hit_fc": _r(np.mean([f["unit_hit_fc"] for f in fs if f.get("unit_hit_fc") is not None]), 3) if fs else None,
                          "unit_hit_fit": _r(np.mean([f["unit_hit_fit"] for f in fs if f.get("unit_hit_fit") is not None]), 3) if fs else None,
                          "config_hit": _r(np.mean([f["config_hit"] for f in fs if f.get("config_hit") is not None]), 3) if any(f.get("config_hit") is not None for f in fs) else None} if ft else None
            res["tech"] = {t: {"mae": _r(np.mean([s["tech"][t]["mae"] for s in sd])), "bias": _r(np.mean([s["tech"][t]["bias"] for s in sd])), "n": len(sd)}
                           for t in C.THERMAL} if sd else None
            res["floor"] = _floor_summary(sd) if sd else None
            res["floor_parts"] = _floor_parts_summary(sd) if sd else None
            return res
        o = agg(lst)
        o["n_hindsight"] = skipped.get(k, 0)
        o["by_band"] = {b: agg([s for s in lst if s.get("band") == b]) for b in ("low", "medium", "high")}
        out[k] = o
    return out
