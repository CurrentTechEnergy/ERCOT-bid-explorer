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

Per day: mean absolute error (MW over 24 hours), bias (expected minus actual), expected and
actual GWh, and the headline call: right when expected thermal GWh is within HEADLINE_TOL of
the 2-day answer.  Summary: hit rates and mean errors over all scored days and by price band,
keyed by the model versions that produced the files.

Writes data/forecast/scores.json.gz:
  days[date]   {"versions": {...}, "band", "two_day": {...} | null, "sixty_day": {...} | null,
                "fit": {...} | null}
  summary      {versions key: {n, headline_hit, thermal_mae, thermal_bias, unit_hit, n_judged,
                wind_mae, solar_mae, by_band: {band: {...}}, group: {g: {mae, bias, n}}}}
"""
import numpy as np

from ..config import DATA_DIR
from ..intraday import train_of
from ..store import read_json_gz, write_json_gz
from . import context as C
from .build import GROUPS

PATH = DATA_DIR / "forecast" / "scores.json.gz"
HEADLINE_TOL = 0.10
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
    return out or None


def score_sixty_day(day: dict, ctx: C.Context) -> dict:
    date = day["date"]
    rows_file = read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz")
    if not rows_file:
        return None
    cols = {c: i + 2 for i, c in enumerate(rows_file["columns"])}
    names = rows_file["units"]
    act = {}          # train -> (output[24], online[24])
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
        scores["days"][date] = {"versions": day["models"], "band": day["headline"].get("band"),
                                "two_day": score_two_day(day), "sixty_day": score_sixty_day(day, ctx),
                                "fit": score_fit(day, ctx)}
    scores["days"] = {d: v for d, v in sorted(scores["days"].items()) if d in set(days)}
    scores["summary"] = summarise(scores["days"])
    scores["headline_tol"] = HEADLINE_TOL
    write_json_gz(PATH, scores)
    return scores


def _vkey(versions):
    return " ".join(f"{k}={v}" for k, v in sorted(versions.items()) if v)


def summarise(days: dict) -> dict:
    by = {}
    for d, s in days.items():
        by.setdefault(_vkey(s["versions"]), []).append(s)
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
                   "unit_hit": _r(sum(h * n for h, n in uh) / sum(n for _, n in uh), 3) if uh and sum(n for _, n in uh) else None,
                   "n_judged": int(sum(n for _, n in uh))}
            res["group"] = {g: {"mae": _r(np.mean([s["group"][g]["mae"] for s in sd])), "bias": _r(np.mean([s["group"][g]["bias"] for s in sd])), "n": len(sd)}
                            for g in GROUPS} if sd else None
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
            return res
        o = agg(lst)
        o["by_band"] = {b: agg([s for s in lst if s.get("band") == b]) for b in ("low", "medium", "high")}
        out[k] = o
    return out
