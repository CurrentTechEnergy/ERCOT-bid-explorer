"""Wind and solar: available MW, and the share that prices itself out at its own node.

For every wind and solar unit in the latest DAM disclosure:

  avail[h]  what the unit could produce: its own day-ahead HSL from the 60-day DAM disclosure
            when the day's disclosure is public (source "dam_cop": the QSE's own forecast,
            known at the time); else ERCOT's fleet forecast (STWPF for wind, STPPF for solar,
            data/renew_forecast.json.gz) spread over units in proportion to their mean HSL at
            that hour over the last 30 days with unit rows ("stwpf"); else nothing
  offer[h]  the price the unit offers at: for a unit whose offers follow a day-ahead price
            (pipeline.ppa, tier revealed or location unclear) a x DA(point, h) + b at its
            fitted settlement point; otherwise its usual floor offer
  priced out when offer[h] > the day-ahead price at its node (the hub average when the node
            has none): the day-ahead price stands in for the real-time price the offer will
            actually meet
  disp[h]   avail[h] where not priced out, else 0; curtailed = avail - disp

Fleet totals are the sums over units; nameplate (for the bars) is the largest HSL seen.
"""
import numpy as np

from ..forecast import context as C

NAME = "renewable_floor"
VERSION = "v0"
FC_KEY = {"wind": "wind", "solar": "solar"}


def _offer(ctx, date, name, node):
    u = ctx.ppa.get(name)
    if not u:
        return None, "none"
    if u.get("tier") in ("revealed", "unclear") and u.get("a") is not None:
        pt = u.get("point")
        da = node if pt == "node" else (ctx.dam_hubs.get(date) or {}).get(pt)
        if da is not None and len(da) >= 24 and all(v is not None for v in da[:24]):
            return u["a"] * np.array(da[:24], float) + u["b"], "formula"
    if u.get("floor") is not None:
        return np.full(24, float(u["floor"])), "floor"
    return None, "none"


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    dd = ctx.dam(date)
    hub = ctx.hub(date)
    fc = ctx.renew_fc.get(date) or {}
    stats = ctx.stats_at(date)["renew"]
    # fleet forecast spread by each unit's typical HSL at the hour
    weights = {}
    for t in C.RENEW:
        tot = np.zeros(24)
        for key, u in units.items():
            if u["tech"] == t and stats.get(key, {}).get("avail_by_hour"):
                tot += np.array(stats[key]["avail_by_hour"])
        weights[t] = tot
    rows, src_count = {}, {}
    for key, u in units.items():
        t = u["tech"]
        if t not in C.RENEW:
            continue
        avail, src = None, None
        if dd and key in dd["units"]:
            du = dd["units"][key]
            v = du.get("hsl_h") or ([du.get("hsl")] * 24 if du.get("hsl") is not None else None)
            if v and len(v) >= 24:
                avail = np.array([0.0 if x is None else float(x) for x in v[:24]]); src = "dam_cop"
        if avail is None and fc.get(FC_KEY[t]) and stats.get(key, {}).get("avail_by_hour") and weights[t].sum() > 0:
            f = np.array([0.0 if x is None else float(x) for x in fc[FC_KEY[t]][:24]])
            w = np.array(stats[key]["avail_by_hour"]) / np.maximum(weights[t], 1e-9)
            avail = f * w; src = "stwpf" if t == "wind" else "stppf"
        if avail is None:
            continue
        node = ctx.node_price(date, u["sp"], name=key) if u["sp"] else None
        ref = node if node is not None else hub
        offer, osrc = _offer(ctx, date, key, node)
        if offer is not None and ref is not None:
            out = offer > ref + 1e-9
        else:
            out = np.zeros(24, bool)
        disp = np.where(out, 0.0, avail)
        rows[key] = {"tech": t, "avail": np.round(avail, 1), "disp": np.round(disp, 1), "nameplate": stats.get(key, {}).get("hsl_max", 0.0) or u["hsl"],
                     "source": src, "offer": osrc, "node": node is not None, "model": NAME, "version": VERSION}
        src_count[src] = src_count.get(src, 0) + 1
    return {"rows": rows, "inputs": {"avail": src_count, "forecast_posted": fc.get("posted")}}
