"""Assemble one forecast day from the models and write it.

data/forecast/<date>.json.gz
  date, format
  models            {model: version} for every model that contributed
  inputs            what the models saw: node price source ("dam" | "dam_nodes"), the last
                    known 60-day day and whether it is hindsight, the curve snapshot month,
                    availability sources, the month-to-date hub average
  headline          hub_avg (the day-ahead system lambda's daily mean, kept under its old name),
                    band (low | medium | high, on that mean), band_edges [q25, q75] (of the
                    daily lambda means over the past BAND_MONTHS months), hub [24], lambda [24];
                    baseload / price_sensitive / peakers: {cap, on, exp, min, share, gwh,
                    n_on, n_units}; wind / solar: {nameplate, avail, disp, avail_gwh,
                    disp_gwh, curt_gwh, out, out_gwh} (out: ERCOT's zonal renewable outage,
                    planned included, split between wind and solar as the unit-level report lists
                    them, at most nameplate - avail; null without the zonal report)
  capacity          group[g] and tech[t]: {cap, on, off, out, unknown, min, exp, gwh, n_on,
                    n_off, n_out, n_unknown} (MW; on, off and min weighted by each unit's mean p over the day, as exp is,
                    with a unit's outage share (out_share: listed gas turbines and the zonal unseen outage) in out, not off;
                    out and unknown the HSL of units in those states; n_on counts p >= 0.5 of the share not on outage)
  hourly            group[g] / tech[t] / category[c] / fleet: {min, exp, hsl, min_bin, exp_bin} [24]
                    (min_bin / exp_bin: the binary lines, each unit-hour in full when its P(on) >= ON_CALL
                    and none otherwise; every line net of the outage pool); outage_pool: {min, exp,
                    zones, days} (the zonal outage deduction placed on no unit, pipeline.models.outage_pool) or absent; wind /
                    solar: {avail, disp} [24]; model: {series: "model version"}
  units             columns + rows, one per thermal train: unit, tech, group, hsl, lsl,
                    verdict (on | off | maybe | nocut | outage | peaker), p_on, loss, cutoff,
                    off_from, off_hours, reason, curve (1 if dispatched on its own curve),
                    model, version, win_from / win_hours (the loss window an hourly probability
                    was judged over), out_share (share of a CC train's site listed out),
                    cc_small (MW a CC train is held at in cheap hours, its smallest usual size),
                    p_base and drivers (a unit judged on its window: the starting P(on), the trees'
                    or, for a CC train or gas steam unit on the stay-on rule, a typical unit's
                    P(stays on), and [[driver, points]], how far each input moved it, adding up to p_on)
  unit_hours        {"series": UNIT_SERIES, "units": {unit: [[24] per series]}}: each thermal
                    unit's hourly weight online (p), expected MW, committed minimum MW, the
                    day-ahead price it was dispatched against (its node, else the hub) and its size
                    (the minimum it is held at when on; the binary call is on when p >= ON_CALL);
                    null for a series that is zero all day or a price it did not have
  renewables        columns + rows, one per wind / solar unit: unit, tech, nameplate,
                    avail_mwh, disp_mwh, source, offer, model, version

Categories (one definition, used by the headline and the page): baseload = the always-on
group (combustion turbines in it included) plus nuclear, the same units as the always-on group's
capacity; peakers = the units pipeline/groups.py flags as peakers by how they run (online under
its PEAKER_SHARE of available hours, at most PEAKER_RUN_H hours a day when on), whatever their
technology; price-sensitive = the rest: the multi-day and daily groups' other units, the never-on
group and ungrouped thermal units.  A label only: the models choose how each unit is predicted.
"""
import datetime as dt

import numpy as np

from ..config import DATA_DIR
from ..store import read_json_gz, write_json_gz
from ..models import MODELS, versions
from . import context as C
from . import stack as STACK
from ..models import outage_pool
from .groups import GROUPS as HISTORY_GROUPS, GROUP_LABELS as HISTORY_LABELS, unit_peakers

# the history groups (six timescales and never-on) plus one for thermal units with no hourly history yet (new units)
GROUPS = HISTORY_GROUPS + ["ungrouped"]
GROUP_LABELS = {**HISTORY_LABELS, "ungrouped": "Not yet grouped: no hourly history"}

OUT_DIR = DATA_DIR / "forecast"
FORMAT = 1
BAND_MONTHS = 12
UNIT_COLS = ["unit", "tech", "group", "hsl", "lsl", "verdict", "p_on", "loss", "cutoff", "off_from", "off_hours",
             "reason", "curve", "model", "version", "win_from", "win_hours", "out_share", "cc_small", "p_base",
             "drivers"]
UNIT_SERIES = ["p", "exp", "min", "price", "size"]
ON_CALL = 0.5      # P(on) at or above which a unit-hour is called on for the binary lines
RENEW_COLS = ["unit", "tech", "nameplate", "avail_mwh", "disp_mwh", "source", "offer", "model", "version"]
CATEGORIES = {
    "baseload": "the always-on group plus nuclear",
    "price_sensitive": "the multi-day, daily and never-on groups' units that are not peakers (and thermal units with no group yet)",
    "peakers": "units that run like peakers: online under 30% of available hours, at most 16 h a day when on",
}


def category(tech, group, peaker=False):
    if tech == "nuclear" or group == "never":
        return "baseload"
    if peaker:
        return "peakers"
    return "price_sensitive"


def band_edges(ctx: C.Context, date, daily=None):
    """[q25, q75] of the daily day-ahead system lambda averages (or of `daily`, {date: $/MWh})
    over the BAND_MONTHS months before `date` (all available days when the history is
    shorter), and the window used."""
    daily = ctx.lambda_daily() if daily is None else daily
    d = C._d(date)
    lo = (d - dt.timedelta(days=int(BAND_MONTHS * 30.44))).isoformat()
    vals = [v for k, v in daily.items() if lo <= k < date]
    if len(vals) < 30:
        vals = [v for k, v in daily.items() if k < date] or list(daily.values())
    if not vals:
        return None, None
    q = np.percentile(vals, [25, 75])
    keys = sorted(k for k, v in daily.items() if lo <= k < date) or sorted(daily)
    return [round(float(q[0]), 2), round(float(q[1]), 2)], {"from": keys[0], "to": keys[-1], "n": len(vals)}


def band_of(avg, edges):
    if avg is None or edges is None:
        return None
    return "low" if avg < edges[0] else "high" if avg > edges[1] else "medium"


def _r(x, nd=1):
    if x is None:
        return None
    x = float(x)
    return round(x, nd) if nd else int(round(x))


def _rl(a, nd=1):
    return [_r(v, nd) for v in a]


def build_day(date, ctx: C.Context) -> dict:
    m = MODELS
    if getattr(ctx, "_peakers", None) is None:
        ctx._peakers = unit_peakers()       # the units pipeline/groups.py flags as peakers
    pk = ctx._peakers
    commit = m["thermal_cutoff"].forecast(date, ctx)
    peak = m["peaker_share"].forecast(date, ctx)
    disp = m["thermal_dispatch"].forecast(date, ctx, commit, peak)
    renew = m["renewable_floor"].forecast(date, ctx)
    hub = ctx.hub(date)
    lam = ctx.lam(date)
    edges, window = band_edges(ctx, date)
    hub_avg = _r(lam.mean(), 2) if lam is not None else None     # the band's price: lambda, under its old name

    # ---- aggregates ----
    def blank():
        return {"min": np.zeros(24), "exp": np.zeros(24), "hsl": np.zeros(24), "min_bin": np.zeros(24), "exp_bin": np.zeros(24)}
    by_g = {g: blank() for g in GROUPS}
    by_t = {t: blank() for t in C.THERMAL}
    by_c = {k: blank() for k in CATEGORIES}
    cap = {"group": {g: _cap0() for g in GROUPS}, "tech": {t: _cap0() for t in C.THERMAL}}
    cat = {k: {"cap": 0.0, "on": 0.0, "min": 0.0, "exp": 0.0, "gwh": 0.0, "n_on": 0, "n_units": 0} for k in CATEGORIES}
    unit_rows, unit_hours = [], {}
    for key, row in sorted(commit["rows"].items()):
        d = disp["rows"][key]
        g = "never" if row["tech"] == "nuclear" else (row["group"] or "ungrouped")
        hsl, lsl = d["hsl"], float(row["lsl"] or 0.0)
        p_day = float(np.mean(d["p"]))
        avail = 1.0 - float(row.get("out_share") or 0.0)      # counted on or off by its odds while available
        state = ("out" if row["verdict"] == "outage" else "unknown" if row["verdict"] == "nocut"
                 else "on" if p_day >= 0.5 * avail else "off")
        exp_mean = float(d["exp"].mean())
        min_mean = float(np.mean(d["min"]))
        for tgt in ((cap["group"][g] if g in cap["group"] else None), cap["tech"][row["tech"]]):
            if tgt is None:
                continue
            tgt["cap"] += hsl; tgt["n_" + state] += 1
            if state in ("on", "off"):
                # weighted like exp, so the bar's minimum <= expected <= maximum; the part of
                # the weight taken off for outages (out_share) is outage, the rest offline
                osh = float(row.get("out_share") or 0.0)
                tgt["on"] += p_day * hsl; tgt["out"] += osh * hsl
                tgt["off"] += max(0.0, 1.0 - osh - p_day) * hsl
                tgt["min"] += min_mean
            else:
                tgt[state] += hsl
            tgt["exp"] += exp_mean; tgt["gwh"] += float(d["exp"].sum()) / 1000.0
        on = np.asarray(d["p"], float) >= ON_CALL
        min_bin, exp_bin = np.where(on, d["size"], 0.0), np.where(on, d["mw"], 0.0)
        for agg in ((by_g[g] if g in by_g else None), by_t[row["tech"]]):
            if agg is None:
                continue
            agg["min"] += d["min"]; agg["exp"] += d["exp"]
            agg["min_bin"] += min_bin; agg["exp_bin"] += exp_bin
            if state != "out":
                agg["hsl"] += hsl
        ck = category(row["tech"], g, key in pk)
        by_c[ck]["min"] += d["min"]; by_c[ck]["exp"] += d["exp"]
        by_c[ck]["min_bin"] += min_bin; by_c[ck]["exp_bin"] += exp_bin
        if state != "out":
            by_c[ck]["hsl"] += hsl
        c = cat[ck]
        c["cap"] += hsl; c["exp"] += exp_mean; c["gwh"] += float(d["exp"].sum()) / 1000.0; c["n_units"] += 1
        if state in ("on", "off"):
            c["on"] += p_day * hsl; c["min"] += min_mean
        if state == "on":
            c["n_on"] += 1
        p_on = round(p_day, 2) if row["verdict"] == "peaker" else row["p_on"]
        unit_rows.append([key, row["tech"], g, _r(hsl), _r(lsl), row["verdict"], p_on, row["loss"], row["cutoff"],
                          row["off_from"], row["off_hours"], row["reason"], int(d["curve"]),
                          row["model"] if row["verdict"] != "peaker" else peak["rows"].get(key, {}).get("model", row["model"]),
                          row["version"] if row["verdict"] != "peaker" else peak["rows"].get(key, {}).get("version", row["version"]),
                          row.get("win_from"), row.get("win_hours"), row.get("out_share"), d.get("small"),
                          row.get("p_base"), row.get("drivers")])
        hs = [[round(float(v), 2) for v in d["p"]], [round(float(v)) for v in d["exp"]], [round(float(v)) for v in d["min"]]]
        hs = [None if not any(v) else v for v in hs]       # a unit off all day carries nulls
        unit_hours[key] = hs + [None if d.get("price") is None else [round(float(v), 2) for v in d["price"]],
                                [round(float(v)) for v in d["size"]]]
    group_of = {k: ("never" if r["tech"] == "nuclear" else (r["group"] or "ungrouped"), k in pk) for k, r in commit["rows"].items()}
    pool = (outage_pool.deduction(ctx, date, ctx.units(date), {k: (r["min"], r["exp"]) for k, r in disp["rows"].items()},
                                  group_of)
            if commit.get("outage_pool") else None)
    def _deduct(agg, mn, ex):
        for k, v in (("min", mn), ("min_bin", mn), ("exp", ex), ("exp_bin", ex)):
            agg[k] = agg[k] - v
    if pool:        # the zonal outage deduction, on no unit, off the technologies', groups' and categories' lines
        for t in C.THERMAL:
            if t in pool["min"]:
                _deduct(by_t[t], pool["min"][t], pool["exp"][t])
        for (t, gp), mn in pool["pair"]["min"].items():
            g, p = gp if isinstance(gp, tuple) else (gp, False)
            for agg in ((by_g[g] if g in by_g else None), by_c[category(t, g, p)]):
                if agg is not None:
                    _deduct(agg, mn, pool["pair"]["exp"][(t, gp)])
    fleet = blank()
    for t in C.THERMAL:
        for k in fleet:
            fleet[k] += by_t[t][k]
    # wind and solar
    rn = {t: {"avail": np.zeros(24), "disp": np.zeros(24), "nameplate": 0.0, "n": 0} for t in C.RENEW}
    renew_rows = []
    for key, row in sorted(renew["rows"].items()):
        r = rn[row["tech"]]
        r["avail"] += row["avail"]; r["disp"] += row["disp"]; r["nameplate"] += float(row["nameplate"] or 0.0); r["n"] += 1
        renew_rows.append([key, row["tech"], _r(row["nameplate"]), _r(row["avail"].sum()), _r(row["disp"].sum()),
                           row["source"], row["offer"], row["model"], row["version"]])
    headline = {"hub_avg": hub_avg, "band": band_of(hub_avg, edges), "band_edges": edges, "band_window": window,
                "hub": _rl(hub, 2) if hub is not None else None, "lambda": _rl(lam, 2) if lam is not None else None}
    for k, c in cat.items():
        headline[k] = {"cap": _r(c["cap"]), "on": _r(c["on"]), "min": _r(c["min"]), "exp": _r(c["exp"]),
                       "share": _r(c["on"] / c["cap"], 3) if c["cap"] else None, "gwh": _r(c["gwh"], 1),
                       "n_on": c["n_on"], "n_units": c["n_units"]}
    # renewable outage: ERCOT's zonal IRR outage split between wind and solar as the unit-level
    # report lists them (by nameplate when it lists neither), at most the gap between nameplate
    # and available; the rest of that gap is weather
    ro = ctx.renew_out(date)
    lw = (ro["wind"] + ro["solar"]) if ro else 0.0
    npl = sum(rn[t]["nameplate"] for t in C.RENEW) or 1.0
    for t in C.RENEW:
        r = rn[t]
        if ro:
            sh = ro[t] / lw if lw else r["nameplate"] / npl
            r["out"] = np.minimum(np.asarray(ro["irr"], float) * sh, np.maximum(0.0, r["nameplate"] - r["avail"]))
        headline[t] = {"nameplate": _r(r["nameplate"]), "avail": _r(r["avail"].mean()), "disp": _r(r["disp"].mean()),
                       "avail_gwh": _r(r["avail"].sum() / 1000, 2), "disp_gwh": _r(r["disp"].sum() / 1000, 2),
                       "curt_gwh": _r((r["avail"] - r["disp"]).sum() / 1000, 2), "n_units": r["n"],
                       "out": _r(r["out"].mean()) if "out" in r else None,
                       "out_gwh": _r(r["out"].sum() / 1000, 2) if "out" in r else None} if r["n"] else None
    v = versions()
    hourly_model = {**{g: f"{v['thermal_cutoff']} / {v['thermal_dispatch']}" for g in GROUPS},
                    **{t: f"{v['thermal_cutoff']} / {v['thermal_dispatch']}" for t in C.THERMAL},
                    "combustion_turbine": f"{v['peaker_share']} / {v['thermal_dispatch']}",
                    "fleet": f"{v['thermal_cutoff']} / {v['peaker_share']} / {v['thermal_dispatch']}",
                    "wind": v["renewable_floor"], "solar": v["renewable_floor"]}
    out = {
        "date": date, "format": FORMAT,
        "models": {k: val for k, val in v.items()},
        "inputs": {**commit["inputs"], **disp["inputs"], "avail": renew["inputs"]["avail"],
                   "forecast_posted": renew["inputs"].get("forecast_posted"), "hub": hub is not None},
        "headline": headline,
        "capacity": {"group": {g: _cap_out(c) for g, c in cap["group"].items()},
                     "tech": {t: _cap_out(c) for t, c in cap["tech"].items()}},
        "hourly": {"group": {g: _h_out(a) for g, a in by_g.items()}, "tech": {t: _h_out(a) for t, a in by_t.items()},
                   "category": {k: _h_out(a) for k, a in by_c.items()}, "fleet": _h_out(fleet),
                   **{t: {"avail": _rl(rn[t]["avail"]), "disp": _rl(rn[t]["disp"])} if rn[t]["n"] else None for t in C.RENEW},
                   "model": hourly_model,
                   **({"outage_pool": {"min": _rl(sum(pool["min"].values(), np.zeros(24))), "exp": _rl(sum(pool["exp"].values(), np.zeros(24))),
                                       "zones": {z: _rl(v) for z, v in pool["zones"].items()}, "days": pool["days"]}}
                      if pool else {})},
        "units": {"columns": UNIT_COLS, "rows": unit_rows},
        "unit_hours": {"series": UNIT_SERIES, "units": unit_hours},
        "renewables": {"columns": RENEW_COLS, "rows": renew_rows},
        # written to its own file by write_day (pipeline.forecast.stack), not into this one
        "_stack": STACK.build(date, ctx, commit, disp, GROUPS),
    }
    return out


def _cap0():
    return {"cap": 0.0, "on": 0.0, "off": 0.0, "out": 0.0, "unknown": 0.0, "min": 0.0, "exp": 0.0, "gwh": 0.0,
            "n_on": 0, "n_off": 0, "n_out": 0, "n_unknown": 0}


def _cap_out(c):
    return {k: (_r(val) if isinstance(val, float) else val) for k, val in c.items()}


def _h_out(a):
    return {k: _rl(val) for k, val in a.items()}


def write_day(date, ctx):
    day = build_day(date, ctx)
    STACK.write(date, day.pop("_stack"))
    write_json_gz(OUT_DIR / f"{date}.json.gz", day)
    return day


def forecast_days(ctx: C.Context) -> list:
    """Days a forecast can be made for: a day-ahead price source at the nodes and hub prices."""
    days = set(ctx.dam_days) | set(ctx.dam_nodes)
    return sorted(d for d in days if ctx.hub(d) is not None)


def write_index(ctx: C.Context, days, scores_summary=None):
    last = days[-1] if days else None
    edges, window = band_edges(ctx, last) if last else (None, None)
    write_json_gz(OUT_DIR / "index.json.gz", {
        "days": days, "format": FORMAT, "models": versions(), "bands": {"edges": edges, "window": window},
        "categories": CATEGORIES, "groups": GROUPS, "group_labels": GROUP_LABELS,
        "known_lag_days": C.LAG, "price_bins": C.BIN_LABELS,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
