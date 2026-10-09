"""Plant economics: what each unit earned and what it cost to run, day by day, from the data
already loaded.  Needs no downloads.  Read by economics.html.

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
  hours_on  hours running (unit_hours_60d strips), thermal units only

Prices are hourly means of the 15-minute (node) or 5-minute (lambda) values, so settlement
at the real intervals differs a little.  Written per technology to data/econ/<tech>.json.gz:
  {dates, gas: [Henry Hub $/MMBtu per date, last trading day carried forward, null before
   the first], units: {name: {type, sp, hsl (median HSL while running, MW), configs (combined
   cycle: the configuration names summed into this train, else null), series...}}}
and an index data/econ_index.json.gz {dates, techs: {tech: [names]}, has_nodes, has_dam}.
"""
import numpy as np

from .config import DATA_DIR, SIXTY_DAY_TECHS, UNIT_DATA_DIR
from .intraday import _online, train_of
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

SERIES = ("mwh", "chg", "rev_rt", "rev_lam", "da_mwh", "rev_da", "rev_da_rt", "rev_as", "cost_off", "cost_inc",
          "mingen", "start_hot", "start_inter", "start_cold", "starts", "hours_on")
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


def _hourly_online(u: dict, runs: list) -> np.ndarray:
    n = len(runs)
    hr = np.minimum(np.array(runs) // 60, 23)
    si = _ffill_index(u["status"], n)
    on = np.array([i >= 0 and _online(u["status"][i][1]) for i in si])
    return np.array([on[hr == h].mean() >= 0.5 if (hr == h).any() else False for h in range(24)])


def build_econ(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    D = len(dates)
    node_days = set(index["days"].get("nodes", []))
    dam_days = set(index["days"].get("dam", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    strips = (read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}).get("units", {})
    gas = read_json_gz(DATA_DIR / "gas.json.gz", default=None) or {}
    gas_by = dict(zip(gas.get("dates", []), gas.get("value", [])))
    gas_series, last = [], None
    for d in dates:
        last = gas_by.get(d, last)
        gas_series.append(last)

    units = {}      # name -> {"type", "tech", "sp", "hsl": [], series: [D]}
    starts = {}     # unit, or combined-cycle train -> [D]
    prev_last, prev_date = {}, None

    def rec(name, u):
        if name not in units:
            units[name] = {"type": u.get("type"), "tech": u.get("tech"), "sp": None, "hsl": [],
                           **{k: [None] * D for k in SERIES}}
        return units[name]

    for di, d in enumerate(dates):
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not ud:
            continue
        nodes = (read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz") or {}).get("points") if d in node_days else None
        dam = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") if d in dam_days else None
        dam_units = (dam or {}).get("units") or {}
        mcpc = (dam or {}).get("mcpc") or {}
        lam = (prices.get(d) or {}).get("lambda") or []
        lam = np.array([np.nan if v is None else v for v in lam[:24]] + [np.nan] * (24 - len(lam[:24])), float)
        runs = ud["runs"]
        # starts: status events of a day, combined-cycle configurations merged into their train;
        # a start in the day's first run counts only when the previous day is known
        if prev_date is None or (np.datetime64(d) - np.datetime64(prev_date)).astype(int) != 1:
            prev_last = {}
        evs = {}
        for name, u in ud["units"].items():
            key = train_of(name) if u.get("tech") == "combined_cycle" else name
            evs.setdefault(key, []).extend(ev for ev in u["status"] if ev[1])
        for key, ev in evs.items():
            cnt, prev = 0, prev_last.get(key)
            for _, st in sorted(ev, key=lambda e: e[0]):
                if prev is not None and not _online(prev) and _online(st):
                    cnt += 1
                prev = st
            starts.setdefault(key, [None] * D)[di] = cnt
            if prev is not None:
                prev_last[key] = prev
        prev_date = d
        for name, u in ud["units"].items():
            if not u.get("out"):
                continue
            r = rec(name, u)
            out = np.array([np.nan if v is None else v for v in u["out"]], float)
            out = np.where(np.isfinite(out), out, 0.0)
            pos, neg = np.clip(out, 0, None), np.clip(out, None, 0)
            r["mwh"][di] = _r(pos.sum())
            if u.get("tech") == "storage":
                r["chg"][di] = _r(-neg.sum())
            r["rev_lam"][di] = _r(np.nansum(out * lam))
            on = _hourly_online(u, runs)
            if on.any():
                li = _ffill_index(u["lim"], len(runs))
                hsl = [u["lim"][i][1] for i in li if i >= 0 and u["lim"][i][1] is not None]
                if hsl:
                    r["hsl"].append(float(np.median(hsl)))
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
            s = strips.get(name)
            if s and len(s) >= (di + 1) * 24:
                r["hours_on"][di] = sum(1 for c in s[di * 24:(di + 1) * 24] if c in "ma")

    # a combined-cycle train is one plant registered as several configurations; its economics
    # are summed over them, with the DAM costs of the configuration that produced most that day
    ADD = ("mwh", "chg", "rev_rt", "rev_lam", "da_mwh", "rev_da", "rev_da_rt", "rev_as", "cost_off", "cost_inc", "hours_on")
    merged = {}
    for name, r in units.items():
        key = train_of(name) if r["tech"] == "combined_cycle" else name
        if key not in merged:
            merged[key] = r
            r["configs"] = [name] if key != name else None
            continue
        m = merged[key]
        m["configs"].append(name)
        m["hsl"] = m["hsl"] + r["hsl"]
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
    by_tech = {}
    for name, r in units.items():
        t = r["tech"] if r["tech"] in SIXTY_DAY_TECHS else "other"
        r["hsl"] = _r(np.median(r["hsl"])) if r["hsl"] else None
        by_tech.setdefault(t, {})[name] = r
    out_dir = DATA_DIR / "econ"
    for t in SIXTY_DAY_TECHS:
        us = by_tech.get(t, {})
        write_json_gz(out_dir / f"{t}.json.gz", {"dates": dates, "gas": gas_series, "units": dict(sorted(us.items()))})
    write_json_gz(DATA_DIR / "econ_index.json.gz", {
        "dates": dates, "techs": {t: sorted(by_tech.get(t, {})) for t in SIXTY_DAY_TECHS},
        "has_nodes": [d in node_days for d in dates], "has_dam": [d in dam_days for d in dates],
        "gas_days": sum(1 for g in gas_series if g is not None),
    })
    print(f"econ: {D} days, {len(units)} units, {sum(1 for d in dates if d in node_days)} days with node prices, "
          f"{sum(1 for d in dates if d in dam_days)} with DAM")
