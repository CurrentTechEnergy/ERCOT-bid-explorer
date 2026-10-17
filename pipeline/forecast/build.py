"""Assemble one forecast day from the models and write it.

data/forecast/<date>.json.gz
  date, format
  models            {model: version} for every model that contributed
  inputs            what the models saw: node price source ("dam" | "dam_nodes"), the last
                    known 60-day day and whether it is hindsight, the curve snapshot month,
                    availability sources, the month-to-date hub average
  headline          hub_avg, band (low | medium | high), band_edges [q25, q75], hub [24];
                    baseload / price_sensitive / peakers: {cap, on, exp, min, share, gwh,
                    n_on, n_units}; wind / solar: {nameplate, avail, disp, avail_gwh,
                    disp_gwh, curt_gwh}; storage: {peak_dis, peak_chg, gwh_dis, gwh_chg, eff,
                    known_through, capped} (fleet MW and GWh, pipeline.models.storage_habit),
                    null while fewer than a week of 2-day battery actuals is known
  capacity          group[g] and tech[t]: {cap, on, off, out, unknown, min, exp, gwh, n_on,
                    n_off, n_out, n_unknown} (MW; HSL of units in each state, on = p_on >= 0.5)
  hourly            group[g] / tech[t] / category[c] / fleet: {min, exp, hsl} [24]; wind /
                    solar: {avail, disp} [24]; storage: {dis, chg, soc} [24] (fleet discharging MW,
                    charging MW below zero, energy path MWh) or null; model: {series: "model version"}
  units             columns + rows, one per thermal train: unit, tech, group, hsl, lsl,
                    verdict (on | off | maybe | nocut | outage | peaker), p_on, loss, cutoff,
                    off_from, off_hours, reason, curve (1 if dispatched on its own curve),
                    model, version
  renewables        columns + rows, one per wind / solar unit: unit, tech, nameplate,
                    avail_mwh, disp_mwh, source, offer, model, version

Categories (one definition, used by the headline and the page): baseload = the never-off
group plus nuclear; price-sensitive = the seasonal, multi-day and daily groups and ungrouped
thermal units; peakers = combustion turbines.
"""
import datetime as dt

import numpy as np

from ..config import DATA_DIR
from ..store import read_json_gz, write_json_gz
from ..models import MODELS, versions
from . import context as C
from . import stack as STACK
from .groups import GROUPS as HISTORY_GROUPS, GROUP_LABELS as HISTORY_LABELS

# the six timescale groups plus one for thermal units with no hourly history yet (new units)
GROUPS = HISTORY_GROUPS + ["ungrouped"]
GROUP_LABELS = {**HISTORY_LABELS, "ungrouped": "Not yet grouped: no hourly history"}

OUT_DIR = DATA_DIR / "forecast"
FORMAT = 1
BAND_MONTHS = 12
UNIT_COLS = ["unit", "tech", "group", "hsl", "lsl", "verdict", "p_on", "loss", "cutoff", "off_from", "off_hours",
             "reason", "curve", "model", "version"]
RENEW_COLS = ["unit", "tech", "nameplate", "avail_mwh", "disp_mwh", "source", "offer", "model", "version"]
CATEGORIES = {
    "baseload": "the never-off group plus nuclear",
    "price_sensitive": "the seasonal, multi-day and daily groups (and thermal units with no group yet)",
    "peakers": "combustion turbines",
}


def category(tech, group):
    if tech == "combustion_turbine":
        return "peakers"
    if tech == "nuclear" or group == "never":
        return "baseload"
    return "price_sensitive"


def band_edges(ctx: C.Context, date):
    """[q25, q75] of the daily hub averages over the BAND_MONTHS months before `date`
    (all available days when the history is shorter), and the window used."""
    daily = ctx.hub_daily()
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
    commit = m["thermal_cutoff"].forecast(date, ctx)
    peak = m["peaker_share"].forecast(date, ctx)
    disp = m["thermal_dispatch"].forecast(date, ctx, commit, peak)
    renew = m["renewable_floor"].forecast(date, ctx)
    stor = m["storage_habit"].forecast(date, ctx)
    hub = ctx.hub(date)
    edges, window = band_edges(ctx, date)
    hub_avg = _r(hub.mean(), 2) if hub is not None else None

    # ---- aggregates ----
    def blank():
        return {"min": np.zeros(24), "exp": np.zeros(24), "hsl": np.zeros(24)}
    by_g = {g: blank() for g in GROUPS}
    by_t = {t: blank() for t in C.THERMAL}
    by_c = {k: blank() for k in CATEGORIES}
    cap = {"group": {g: _cap0() for g in GROUPS}, "tech": {t: _cap0() for t in C.THERMAL}}
    cat = {k: {"cap": 0.0, "on": 0.0, "min": 0.0, "exp": 0.0, "gwh": 0.0, "n_on": 0, "n_units": 0} for k in CATEGORIES}
    unit_rows = []
    for key, row in sorted(commit["rows"].items()):
        d = disp["rows"][key]
        g = "never" if row["tech"] == "nuclear" else (row["group"] or "ungrouped")
        hsl, lsl = d["hsl"], float(row["lsl"] or 0.0)
        floor = float(d.get("floor", lsl))     # the minimum the dispatch model holds the unit at when on
        p_day = float(np.mean(d["p"]))
        state = ("out" if row["verdict"] == "outage" else "unknown" if row["verdict"] == "nocut"
                 else "on" if p_day >= 0.5 else "off")
        exp_mean = float(d["exp"].mean())
        for tgt in ((cap["group"][g] if g in cap["group"] else None), cap["tech"][row["tech"]]):
            if tgt is None:
                continue
            tgt["cap"] += hsl; tgt[state] += hsl; tgt["n_" + state] += 1
            tgt["exp"] += exp_mean; tgt["gwh"] += float(d["exp"].sum()) / 1000.0
            if state == "on":
                tgt["min"] += floor
        for agg in ((by_g[g] if g in by_g else None), by_t[row["tech"]]):
            if agg is None:
                continue
            agg["min"] += d["min"]; agg["exp"] += d["exp"]
            if state != "out":
                agg["hsl"] += hsl
        ck = category(row["tech"], g)
        by_c[ck]["min"] += d["min"]; by_c[ck]["exp"] += d["exp"]
        if state != "out":
            by_c[ck]["hsl"] += hsl
        c = cat[ck]
        c["cap"] += hsl; c["exp"] += exp_mean; c["gwh"] += float(d["exp"].sum()) / 1000.0; c["n_units"] += 1
        if state == "on":
            c["on"] += hsl; c["min"] += floor; c["n_on"] += 1
        p_on = round(p_day, 2) if row["tech"] == "combustion_turbine" else row["p_on"]
        unit_rows.append([key, row["tech"], g, _r(hsl), _r(lsl), row["verdict"], p_on, row["loss"], row["cutoff"],
                          row["off_from"], row["off_hours"], row["reason"], int(d["curve"]),
                          row["model"] if row["tech"] != "combustion_turbine" else peak["rows"].get(key, {}).get("model", row["model"]),
                          row["version"] if row["tech"] != "combustion_turbine" else peak["rows"].get(key, {}).get("version", row["version"])])
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
                "hub": _rl(hub, 2) if hub is not None else None}
    for k, c in cat.items():
        headline[k] = {"cap": _r(c["cap"]), "on": _r(c["on"]), "min": _r(c["min"]), "exp": _r(c["exp"]),
                       "share": _r(c["on"] / c["cap"], 3) if c["cap"] else None, "gwh": _r(c["gwh"], 1),
                       "n_on": c["n_on"], "n_units": c["n_units"]}
    for t in C.RENEW:
        r = rn[t]
        headline[t] = {"nameplate": _r(r["nameplate"]), "avail": _r(r["avail"].mean()), "disp": _r(r["disp"].mean()),
                       "avail_gwh": _r(r["avail"].sum() / 1000, 2), "disp_gwh": _r(r["disp"].sum() / 1000, 2),
                       "curt_gwh": _r((r["avail"] - r["disp"]).sum() / 1000, 2), "n_units": r["n"]} if r["n"] else None
    sr = stor["rows"]
    headline["storage"] = ({k: sr[k] for k in ("peak_dis", "peak_chg", "gwh_dis", "gwh_chg")}
                           | {k: stor["inputs"].get(k) for k in ("eff", "known_through", "capped")}) if sr else None
    v = versions()
    hourly_model = {**{g: f"{v['thermal_cutoff']} / {v['thermal_dispatch']}" for g in GROUPS},
                    **{t: f"{v['thermal_cutoff']} / {v['thermal_dispatch']}" for t in C.THERMAL},
                    "combustion_turbine": f"{v['peaker_share']} / {v['thermal_dispatch']}",
                    "fleet": f"{v['thermal_cutoff']} / {v['peaker_share']} / {v['thermal_dispatch']}",
                    "wind": v["renewable_floor"], "solar": v["renewable_floor"], "storage": v["storage_habit"] if sr else None}
    out = {
        "date": date, "format": FORMAT,
        "models": {k: val for k, val in v.items()},
        "inputs": {**commit["inputs"], **disp["inputs"], "avail": renew["inputs"]["avail"],
                   "forecast_posted": renew["inputs"].get("forecast_posted"), "hub": hub is not None,
                   "storage": stor["inputs"]},
        "headline": headline,
        "capacity": {"group": {g: _cap_out(c) for g, c in cap["group"].items()},
                     "tech": {t: _cap_out(c) for t, c in cap["tech"].items()}},
        "hourly": {"group": {g: _h_out(a) for g, a in by_g.items()}, "tech": {t: _h_out(a) for t, a in by_t.items()},
                   "category": {k: _h_out(a) for k, a in by_c.items()}, "fleet": _h_out(fleet),
                   **{t: {"avail": _rl(rn[t]["avail"]), "disp": _rl(rn[t]["disp"])} if rn[t]["n"] else None for t in C.RENEW},
                   "storage": {k: sr[k] for k in ("dis", "chg", "soc")} if sr else None, "model": hourly_model},
        "units": {"columns": UNIT_COLS, "rows": unit_rows},
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
