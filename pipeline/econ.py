"""Plant economics: what each unit earned and what it cost to run, day by day, from the data
already loaded.  Needs no downloads.  Read by Fleet economics (fleet.html) and the Unit page.

For every unit in the per-unit day files (UNIT_DATA_DIR/60d/) and each 60-day date:

  mwh       energy produced (sum of hourly mean net output; storage: discharging only, with
            charging in `chg`, as positive MWh)
  rev_rt    output x the unit's resource-node price, hourly ($; null on days with no node
            prices; charging MWh count negative for storage)
  rev_lam   output x system lambda ($), always available, for comparison and as a fallback
  da_mwh    DAM energy award (MWh; null when the unit had no award column that day)
  rev_da    award x day-ahead price at the unit's settlement point ($)
  rev_da_rt award x the real-time node price ($): subtracting it from rev_da + rev_rt gives
            two-settlement energy revenue, DA award at the DA price plus the RT deviation at
            the RT price
  rev_as    ancillary service awards x their clearing prices, all services ($)
  cost_off  the cost implied by the unit's own DAM energy offer curve: the area under the
            hour's offer curve up to the hour's output ($; null without a DAM curve).  Offers
            are what the unit asked for, not a cost accounting, so this is an upper bound on
            what the unit itself thought its energy was worth
  cost_inc  output x the unit's incremental DAM offer price: the price its energy offer curve
            puts on the hour's output level, applied to all MWh that hour ($; null without a
            DAM curve).  Reads the curve above minimum as the unit's own marginal cost and
            ignores the minimum-energy price, which units set low to get committed
  mingen    DAM minimum-energy offer that day ($/MWh, null without one)
  start     [hot, intermediate, cold] DAM start-up offers ($ per start, null without one)
  starts    starts that day (telemetered status moving from not online to ON), counted for a
            combined-cycle train as a whole so configuration switches are not starts
  starts_inter, starts_cold
            of those, the starts after more than HOT_H hours offline (intermediate) and more than
            INTER_H (cold), timed from the SCED run it went offline in to the run it came back
            (carried across days); the rest are hot, and so is a start whose time offline isn't
            known (the first day loaded, or after a day missing).  Fleet economics prices each
            class at its own start offer
  hours_on  hours running (unit_hours_60d strips), thermal units only
  mmbtu     fuel burned (MMBtu), gas and coal units: each hour's output x the unit's heat rate at
            that output, a straight line from its measured heat rate at minimum (at or below its
            DAM LSL) to its full-load one (at its day's peak HSL) (pipeline/heat_rates: EPA hourly
            stack data against ERCOT net output; a CC configuration its train's; the technology
            median without one)
  fuel_meas fuel cost ($) at that burn: mmbtu x the unit's own hub gas price (gas_hub), or for
            coal its plant's delivered EIA-923 price that month (heat_rates.coal_price)

Prices are hourly means of the 15-minute (node) or 5-minute (lambda) values, so settlement
at the real intervals differs a little.  Written per technology to data/econ/<tech>.json.gz:
  {dates, gas: [Henry Hub $/MMBtu per date, last trading day carried forward, null before
   the first], units: {name: {type, sp, hsl, configs (combined cycle: the configuration names
   summed into this train, else null), fuel_hub ("waha" | "hsc" for gas-fired units, from
   fuel_hubs.json.gz: a train takes the hub most of its configurations got; null without one),
   fuel_hub_method, gas_hub, gas_own, series...}}}
`gas_own` (gas-fired units) is the day's gas bill at the unit's own hub per 1 MMBtu/MWh of heat
rate: mwh x that hub's price (last trading day carried forward), so fuel = gas_own x heat rate.
The hub prices are licensed (OilPriceAPI) and are not published themselves (pipeline/private.py);
`gas_hub` is the hub it was costed at: its fuel_hub (Houston Ship Channel without one), or "hh",
Henry Hub, when that hub has no prices loaded.  A day with no price is null.
`hsl` is the unit's capacity for capacity factors (MW): the 95th percentile, over the loaded days,
of each day's highest HSL in any SCED run the unit is present in (for a combined-cycle train, the
highest across its configurations).  Wind and solar HSL is weather-limited output, so a typical
HSL would measure availability rather than capacity; the daily peak reaches the rating on windy
or clear days, and the 95th percentile keeps a stray telemetry spike from setting it.
and an index data/econ_index.json.gz {dates, techs: {tech: [names]}, has_nodes, has_dam, gas_days}.
data/fuel_cost_60d.json.gz {dates, heat_rate: {tech: EIA MMBtu/MWh}, units: {configuration: [fuel
$/MWh per date: the EIA heat rate x its own hub's price, Henry Hub on a day the hub has none]}}
is the gas fuel cost the A day in ERCOT page takes off each unit's profit.
"""
import numpy as np

from . import heat_rates, memo, private
from .config import DATA_DIR, SIXTY_DAY_TECHS, UNIT_DATA_DIR
from .intraday import _online, train_of
from .parse_prices import node_hourly
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

SERIES = ("mwh", "chg", "rev_rt", "rev_lam", "da_mwh", "rev_da", "rev_da_rt", "rev_as", "cost_off", "cost_inc",
          "mingen", "start_hot", "start_inter", "start_cold", "starts", "starts_inter", "starts_cold", "hours_on", "mmbtu")
HOT_H, INTER_H = 8, 24     # hours offline: a hot start at most HOT_H, intermediate at most INTER_H, else cold (as wear.py)
FUEL_TECHS = ("combined_cycle", "combustion_turbine", "gas_steam", "coal")
GAS_TECHS = ("combined_cycle", "combustion_turbine", "gas_steam")
# EIA average tested heat rates (Electric Power Annual table 8.2, 2024, MMBtu/MWh), as the site uses
EIA_HR = {"combined_cycle": 7.548, "combustion_turbine": 10.999, "gas_steam": 10.337}
AS_KEYS = ("regup", "regdn", "rrs", "ecrs", "nspin")


def _r(x, nd=0):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def curve_cost(prices, mws, q: float) -> float:
    """Area under a piecewise-linear offer curve (price at MW points) from 0 to q MW.  Below
    the first point the first price applies; above the last the last price."""
    p, m = np.asarray(prices, float), np.asarray(mws, float)
    if q <= 0 or len(p) == 0:
        return 0.0
    cost, prev_m, prev_p = 0.0, 0.0, p[0]
    for pi, mi in zip(p, m):
        if mi <= prev_m:
            prev_p = pi
            continue
        top = min(mi, q)
        if top > prev_m:
            # linear price between the points
            frac = (top - prev_m) / (mi - prev_m)
            p_top = prev_p + (pi - prev_p) * frac
            cost += (prev_p + p_top) / 2 * (top - prev_m)
        prev_m, prev_p = mi, pi
        if mi >= q:
            return cost
    return cost + prev_p * (q - prev_m)


def curve_price(prices, mws, q: float) -> float:
    """Price a piecewise-linear offer curve puts on output q MW: the first price below the first
    point, the last price above the last, linear between."""
    p, m = np.asarray(prices, float), np.asarray(mws, float)
    if len(p) == 0:
        return float("nan")
    if q <= m[0]:
        return float(p[0])
    if q >= m[-1]:
        return float(p[-1])
    return float(np.interp(q, m, p))


def _peak_hsl(u: dict, n: int):
    """The day's highest HSL over the runs the unit is present in (MW), or None."""
    si, li = _ffill_index(u["status"], n), _ffill_index(u["lim"], n)
    hsl = [u["lim"][j][1] for i, j in zip(si, li)
           if i >= 0 and u["status"][i][1] is not None and j >= 0 and u["lim"][j][1] is not None]
    return max(hsl) if hsl else None


HR_MIN_UNITS, HR_CARRY_DAYS = 10, 14


def build_implied_hr(hub_files: dict, hh: dict, fh: dict) -> None:
    """The heat rate gas units' offers imply, for Real-time offers, across days (realtime-range.js), written to
    data/implied_hr_60d.json.gz {dates (trends_60d's), techs: {tech: [MMBtu/MWh or null]}}.

    Each unit's first offer price above $0 at or above LSL (trends_60d "first") over the gas at its
    own hub (fuel_hubs.json.gz; Houston Ship Channel without one, then Henry Hub when the hub has no
    prices) on the last trading day before the day, as gas trades the day before it flows.  Each day
    takes every unit's most recent value from the last HR_CARRY_DAYS days and the median across
    units, blank with fewer than HR_MIN_UNITS.  Built here, not in the browser, because the hub
    prices are licensed and not published (pipeline/private.py)."""
    import datetime as dt
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    days = tr.get("dates") or []
    src = {k: v for k, v in hub_files.items() if v.get("dates")}
    if hh.get("dates"):
        src["hh"] = hh
    on_hub = {}

    def gas_for(hub):
        key = hub if hub in src else "hsc" if "hsc" in src else "hh" if "hh" in src else None
        if key is None:
            return {}
        if key not in on_hub:
            g, out, j, last = src[key], {}, 0, None
            for d in days:
                while j < len(g["dates"]) and g["dates"][j] < d:
                    if g["value"][j] is not None:
                        last = g["value"][j]
                    j += 1
                out[d] = last
            on_hub[key] = out
        return on_hub[key]

    t0 = [dt.date.fromisoformat(d).toordinal() for d in days]
    techs = {}
    for t in GAS_TECHS:
        us = [u for u in tr.get("units", []) if u.get("tech") == t]
        gas = [gas_for((fh.get(u["unit"]) or {}).get("hub") or "hsc") for u in us]
        last_hr, last_t, vals = [None] * len(us), [None] * len(us), []
        for i, d in enumerate(days):
            v = []
            for k, u in enumerate(us):
                p, g = u["first"][i], gas[k].get(d)
                if p is not None and g is not None and g > 0:
                    last_hr[k], last_t[k] = p / g, t0[i]
                if last_hr[k] is not None and t0[i] - last_t[k] <= HR_CARRY_DAYS:
                    v.append(last_hr[k])
            vals.append(round(float(np.median(v)), 3) if len(v) >= HR_MIN_UNITS else None)
        techs[t] = vals
    write_json_gz(DATA_DIR / "implied_hr_60d.json.gz", {"dates": days, "techs": techs})


def day_units(ud):
    """What build_econ takes from one per-unit day file (memo.per_day caches it), or None without
    one: per unit or combined-cycle train with status events [key, first status, starts after
    the first event, last status, [[minute of the start, minute it went offline that day or None
    when it was offline since before the day], ...] for those starts, minute of the day it last
    went offline (None without one), minute of its first event] (None and 0 without events; a start at the first event depends
    on the day before, which build_econ adds), and per unit with output [name, type, tech,
    hourly output (None as None), peak HSL]."""
    if not ud:
        return None
    runs = ud.get("runs") or []
    minute = lambda r: runs[r] if 0 <= r < len(runs) else None
    evs = {}
    for name, u in ud["units"].items():
        key = train_of(name) if u.get("tech") == "combined_cycle" else name
        evs.setdefault(key, []).extend(ev for ev in u["status"] if ev[1])
    starts = []
    for key, ev in evs.items():
        ev = sorted(ev, key=lambda e: e[0])
        seq = [st for _, st in ev]
        cnt, offs, off_at = 0, [], None
        for (_, a), (r, b) in zip(ev, ev[1:]):
            if _online(a) and not _online(b):
                off_at = minute(r)
            elif not _online(a) and _online(b):
                cnt += 1
                offs.append([minute(r), off_at])      # off_at None: offline since before the day
        starts.append([key, seq[0] if seq else None, cnt, seq[-1] if seq else None, offs, off_at,
                       minute(ev[0][0]) if ev else None])
    units = [[name, u.get("type"), u.get("tech"), u["out"], _peak_hsl(u, len(ud["runs"]))]
             for name, u in ud["units"].items() if u.get("out")]
    return {"starts": starts, "units": units}


def build_econ(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    D = len(dates)
    node_days = set(index["days"].get("nodes", []))
    dam_days = set(index["days"].get("dam", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    strips = (read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}).get("units", {})
    def carried(src):
        """{dates, value} -> one price per loaded date, the last trading day carried forward."""
        by = dict(zip(src.get("dates", []), src.get("value", [])))
        out, last = [], None
        for d in dates:
            last = by.get(d, last)
            out.append(last)
        return out

    gas_series = carried(read_json_gz(DATA_DIR / "gas.json.gz", default=None) or {})
    hub_files = (private.read("gas_hubs.json.gz", default=None) or {}).get("hubs", {})
    hubs = {h: carried(v) for h, v in hub_files.items()}

    units = {}      # name -> {"type", "tech", "sp", "hsl": [D] daily peak HSL, series: [D]}
    starts = {}     # unit, or combined-cycle train -> [D]
    s_inter, s_cold = {}, {}     # of those, intermediate and cold starts -> [D]
    prev_last, prev_date = {}, None
    off_since = {}  # key -> absolute minute (day number x 1440 + minute) it last went offline

    def rec(name, u):
        if name not in units:
            units[name] = {"type": u.get("type"), "tech": u.get("tech"), "sp": None, "hsl": [None] * D,
                           **{k: [None] * D for k in SERIES}}
        return units[name]

    for di, d in enumerate(dates):
        uf = UNIT_DATA_DIR / "60d" / f"{d}.json.gz"
        ud = memo.per_day("econ", d, [uf], lambda: day_units(read_json_gz(uf)), __name__)
        if not ud:
            continue
        nodes = node_hourly(read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz")) if d in node_days else None
        dam = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") if d in dam_days else None
        dam_units = (dam or {}).get("units") or {}
        mcpc = (dam or {}).get("mcpc") or {}
        lam = (prices.get(d) or {}).get("lambda") or []
        lam = np.array([np.nan if v is None else v for v in lam[:24]] + [np.nan] * (24 - len(lam[:24])), float)
        # starts: status events of a day, combined-cycle configurations merged into their train;
        # a start in the day's first run counts only when the previous day is known
        if prev_date is None or (np.datetime64(d) - np.datetime64(prev_date)).astype(int) != 1:
            prev_last, off_since = {}, {}
        base = int(np.datetime64(d).astype("datetime64[D]").astype(int)) * 1440
        for key, first, cnt, last, *more in ud["starts"]:
            offs, off_at, first_min = more if len(more) == 3 else ([], None, None)
            prev, carried = prev_last.get(key), off_since.get(key)
            # hours offline before each start: from the run it went offline (that day, or carried
            # from an earlier one) to the run it came back; None when not known
            hours = [(m - o) / 60 if m is not None and o is not None
                     else (base + m - carried) / 60 if m is not None and carried is not None else None
                     for m, o in offs]
            if first is not None and prev is not None and not _online(prev) and _online(first):
                cnt += 1
                hours.append(None if carried is None or first_min is None else (base + first_min - carried) / 60)
            starts.setdefault(key, [None] * D)[di] = cnt
            s_inter.setdefault(key, [None] * D)[di] = sum(1 for h in hours if h is not None and HOT_H < h <= INTER_H)
            s_cold.setdefault(key, [None] * D)[di] = sum(1 for h in hours if h is not None and h > INTER_H)
            if last is not None and _online(last):
                off_since.pop(key, None)
            elif off_at is not None:
                off_since[key] = base + off_at
            elif last is not None and prev is not None and _online(prev) and first is not None and not _online(first):
                off_since[key] = base + (first_min or 0)     # went offline at the turn of the day
            if last is not None:
                prev_last[key] = last
        prev_date = d
        for name, typ, tech, u_out, peak in ud["units"]:
            r = rec(name, {"type": typ, "tech": tech})
            out = np.array([np.nan if v is None else v for v in u_out], float)
            out = np.where(np.isfinite(out), out, 0.0)
            pos, neg = np.clip(out, 0, None), np.clip(out, None, 0)
            r["mwh"][di] = _r(pos.sum())
            if tech == "storage":
                r["chg"][di] = _r(-neg.sum())
            r["rev_lam"][di] = _r(np.nansum(out * lam))
            r["hsl"][di] = peak
            du = dam_units.get(name)
            sp = (du or {}).get("sp")
            if sp:
                r["sp"] = sp
            node = None
            if nodes:
                npts = nodes.get(sp or r["sp"] or "")
                node = np.array([np.nan if v is None else v for v in npts], float) if npts else None
                if node is not None:
                    r["rev_rt"][di] = _r(np.nansum(out * node))
            if du:
                aw = du.get("award")
                if aw and any(a is not None for a in aw):
                    a = np.array([0.0 if v is None else v for v in aw[:24]], float)
                    spp = np.array([np.nan if v is None else v for v in (du.get("spp") or [None] * 24)[:24]], float)
                    r["da_mwh"][di] = _r(a.sum())
                    r["rev_da"][di] = _r(np.nansum(a * spp))
                    if node is not None:
                        r["rev_da_rt"][di] = _r(np.nansum(a * node))
                as_rev = 0.0
                for k, v in (du.get("as") or {}).items():
                    p = mcpc.get(k)
                    if p and v:
                        as_rev += float(np.nansum(np.array([0.0 if x is None else x for x in v[:24]], float)
                                                  * np.array([np.nan if x is None else x for x in p[:24]], float)))
                r["rev_as"][di] = _r(as_rev)
                r["mingen"][di] = du.get("mingen")
                st = du.get("start") or [None, None, None]
                r["start_hot"][di], r["start_inter"][di], r["start_cold"][di] = st[0], st[1], st[2]
                curves, idx = du.get("curves") or [], du.get("curve") or []
                if curves and idx:
                    cost = inc = 0.0
                    for h in range(min(24, len(idx))):
                        ci = idx[h]
                        if ci is None or ci < 0 or ci >= len(curves) or pos[h] <= 0:
                            continue
                        cost += curve_cost(curves[ci][0], curves[ci][1], pos[h])
                        inc += pos[h] * curve_price(curves[ci][0], curves[ci][1], pos[h])
                    r["cost_off"][di] = _r(cost)
                    r["cost_inc"][di] = _r(inc)
            t = tech
            if t in FUEL_TECHS:
                hr = heat_rates.curve(t, train_of(name) if t == "combined_cycle" else name)
                lsl = (du or {}).get("lsl")
                r["mmbtu"][di] = _r(sum(q * heat_rates.at_load(hr, q, lsl, r["hsl"][di]) for q in pos if q > 0), 1)
            s = strips.get(name)
            if s and len(s) >= (di + 1) * 24:
                r["hours_on"][di] = sum(1 for c in s[di * 24:(di + 1) * 24] if c in "ma")

    # a combined-cycle train is one plant registered as several configurations; its economics
    # are summed over them, with the DAM costs of the configuration that produced most that day
    ADD = ("mwh", "chg", "rev_rt", "rev_lam", "da_mwh", "rev_da", "rev_da_rt", "rev_as", "cost_off", "cost_inc", "hours_on", "mmbtu")
    # each gas and coal configuration's fuel cost per MWh at its measured heat rate (the day's burn
    # over its output; a day it did not run, its full-load value), before the trains are merged
    units_tech = {n: r["tech"] for n, r in units.items()}
    eff = {n: [None if not m or b is None else b / m for m, b in zip(r["mwh"], r["mmbtu"])]
           for n, r in units.items() if r["tech"] in FUEL_TECHS}
    merged = {}
    for name, r in units.items():
        key = train_of(name) if r["tech"] == "combined_cycle" else name
        if key not in merged:
            merged[key] = r
            r["configs"] = [name] if key != name else None
            continue
        m = merged[key]
        m["configs"].append(name)
        m["hsl"] = [max(a, b) if a is not None and b is not None else (a if b is None else b)
                    for a, b in zip(m["hsl"], r["hsl"])]
        m["sp"] = m["sp"] or r["sp"]
        for di in range(D):
            for k in ADD:
                if r[k][di] is not None:
                    m[k][di] = (m[k][di] or 0) + r[k][di]
            if (r["mwh"][di] or 0) > (m["mwh"][di] or 0) - (r["mwh"][di] or 0) or m["mingen"][di] is None:
                for k in ("mingen", "start_hot", "start_inter", "start_cold"):
                    if r[k][di] is not None:
                        m[k][di] = r[k][di]
    units = merged
    for key, r in units.items():
        if r["tech"] in SIXTY_DAY_TECHS and r["tech"] not in ("wind", "solar", "storage", "hydro", "other") and key in starts:
            r["starts"] = starts[key]
            r["starts_inter"] = s_inter[key]
            r["starts_cold"] = s_cold[key]
    fh = (read_json_gz(DATA_DIR / "fuel_hubs.json.gz", default=None) or {}).get("units", {})
    for name, r in units.items():
        got = [fh[c] for c in (r.get("configs") or [name]) if c in fh]
        if got:
            votes = [g["hub"] for g in got]
            hub = max(set(votes), key=votes.count)
            r["fuel_hub"] = hub
            r["fuel_hub_method"] = next(g["method"] for g in got if g["hub"] == hub)
    by_tech = {}
    for name, r in units.items():
        t = r["tech"] if r["tech"] in SIXTY_DAY_TECHS else "other"
        peaks = [v for v in r["hsl"] if v is not None]
        r["hsl"] = _r(np.percentile(peaks, 95)) if peaks else None
        if t in GAS_TECHS:
            hub = r.get("fuel_hub") or "hsc"
            own = hubs.get(hub)
            r["gas_hub"] = hub if own and any(v is not None for v in own) else "hh"
            g = own if r["gas_hub"] != "hh" else gas_series
            r["gas_own"] = [None if m is None or p is None else _r(m * p, 1) for m, p in zip(r["mwh"], g)]
            r["fuel_meas"] = [None if b is None or p is None else _r(b * p, 1) for b, p in zip(r["mmbtu"], g)]
        elif t == "coal":
            r["fuel_meas"] = [None if b is None else _r(b * heat_rates.coal_price(name, d)[0], 1) for b, d in zip(r["mmbtu"], dates)]
        by_tech.setdefault(t, {})[name] = r
    out_dir = DATA_DIR / "econ"
    for t in SIXTY_DAY_TECHS:
        us = by_tech.get(t, {})
        write_json_gz(out_dir / f"{t}.json.gz", {"dates": dates, "gas": gas_series,
                                                     "units": dict(sorted(us.items()))})
    memo.prune("econ", dates)
    write_json_gz(DATA_DIR / "econ_index.json.gz", {
        "dates": dates, "techs": {t: sorted(by_tech.get(t, {})) for t in SIXTY_DAY_TECHS},
        "has_nodes": [d in node_days for d in dates], "has_dam": [d in dam_days for d in dates],
        "gas_days": sum(1 for g in gas_series if g is not None),
    })
    # each gas and coal configuration's fuel cost per MWh at its measured heat rate (eff above) and
    # its own hub (Henry Hub where its hub has no price that day) or its plant's coal price, for the
    # A day in ERCOT page's unit profit and the Units table (overview.js)
    fuel = {}
    for name, e in sorted(eff.items()):
        t = units_tech[name]
        hr = heat_rates.curve(t, train_of(name) if t == "combined_cycle" else name)
        if t == "coal":
            px = [heat_rates.coal_price(name, d)[0] for d in dates]
        else:
            src = hubs.get((fh.get(name) or {}).get("hub") or "hsc") or [None] * D
            px = [h if h is not None else hh for h, hh in zip(src, gas_series)]
        fuel[name] = [None if p is None else round((h if h is not None else hr[1]) * p, 2) for h, p in zip(e, px)]
    write_json_gz(DATA_DIR / "fuel_cost_60d.json.gz", {"dates": dates, "basis": "measured", "heat_rate": EIA_HR, "units": fuel})
    build_implied_hr(hub_files, read_json_gz(DATA_DIR / "gas.json.gz", default=None) or {}, fh)
    print(f"econ: {D} days, {len(units)} units, {sum(1 for d in dates if d in node_days)} days with node prices, "
          f"{sum(1 for d in dates if d in dam_days)} with DAM")
