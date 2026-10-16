"""Commitment: which thermal units are expected on for the day, judged on the day's own
economics, never on a price level.

For every thermal train in the latest DAM disclosure (pipeline.forecast.context.Context.units):

  outage      its last known hourly state (the latest 60-day day public before the day's
              day-ahead market cleared, so about sixty days old) is outage and the outage had
              already lasted LONG_OUT days or more by then: expected off all day.  A shorter
              outage sixty days ago says little about today (most are over), so it is ignored
              and the unit is judged like any other
  nuclear     on (output at HSL) unless on outage
  never       the never-off group: on
  daily       loss = the worst contiguous window of (minimum-energy cost - day-ahead price at
              the unit's node) x LSL over the day, in $ (pipeline.decisions._window); cutoff =
              the unit's own loss cutoff fitted on its decision days before this day
              (pipeline.decisions._cutoff).  "off" for the window when the loss exceeds the
              cutoff and the unit rarely holds a day-ahead award over such a window, "maybe"
              when it often does (p_on = its award share), "on" at or below the cutoff.  A
              daily unit without a cutoff ("nocut") gets p_on = its share of days with any
              online hour.
  seasonal, multiday
              rule v0 (SEASONAL_VERSION): on when the unit was running at its last known hour
              and the month's day-ahead hub average to date is not below the lowest monthly
              hub average it has run through; off otherwise.  A placeholder until a
              multi-week economics rule exists.
  peakers     combustion turbines are not judged here (peaker_share, by hour); they get
              verdict "peaker" and p_on from that model.

p_on is the probability-like weight the dispatch model applies to the unit's MW: 1 for on,
0 for off, the award share for maybe, the history share for nocut.
"""
import numpy as np

from ..decisions import _window, _cutoff, HALF
from ..forecast import context as C

NAME = "thermal_cutoff"
VERSION = "v0"
SEASONAL_VERSION = "v0"
RUN_SHARE = 0.5          # a month the unit ran through: online at least this share of its hours
LONG_OUT = 21            # days an outage must already have lasted at the last known hour to carry forward


def _month_floor(ctx, key):
    """Lowest monthly mean day-ahead hub average over the months the unit ran through."""
    st = ctx.stats["states"].get(key)
    if st is None:
        return None
    tech, states = st
    dates, day0 = ctx.uh["dates"], ctx.stats["day0"]
    hub = ctx.hub_daily()
    by_month = {}
    for d in dates:
        dn = (C._d(d) - day0).days
        seg = states[dn * 24:(dn + 1) * 24]
        if d not in hub or seg.size < 24:
            continue
        m = by_month.setdefault(d[:7], [0, 0, []])
        m[0] += int(np.isin(seg, ["m", "a"]).sum()); m[1] += int((seg != "-").sum()); m[2].append(hub[d])
    ran = [float(np.mean(v[2])) for v in by_month.values() if v[1] and v[0] / v[1] >= RUN_SHARE]
    return min(ran) if ran else None


def _last_state(ctx, key, known):
    """(state char at the last hour with data of the known day, days the current outage had
    lasted by then) for a train ("-", 0 if none)."""
    st = ctx.stats["states"].get(key)
    if st is None or known is None:
        return "-", 0
    dn = (C._d(known) - ctx.stats["day0"]).days
    end = (dn + 1) * 24
    seg = st[1][:end]
    idx = np.where(seg != "-")[0]
    if not idx.size:
        return "-", 0
    last = idx[-1]
    if seg[last] != "o":
        return seg[last], 0
    k = last
    while k >= 0 and seg[k] in "o-":
        k -= 1
    return "o", (last - k) / 24.0


def _decision_rows(ctx, key, date):
    return [(r[2], r[5], r[6]) for r in ctx.decisions.get("days", []) if r[0] == key and r[1] < date]


def forecast(date, ctx: C.Context) -> dict:
    units = ctx.units(date)
    known, hindsight = ctx.known_date(date)
    mtd, month = ctx.month_to_date_hub(date)
    node_src = ctx.node_source(date)
    rows = {}
    for key, u in units.items():
        t = u["tech"]
        if t not in C.THERMAL:
            continue
        g = "never" if t == "nuclear" else ctx.groups.get(key)
        last, out_days = _last_state(ctx, key, known)
        if last == "o" and out_days < LONG_OUT:
            last = "0"       # a short outage sixty days ago: treated as off then, judged normally
        row = {"tech": t, "group": g, "hsl": u["hsl"], "lsl": u["lsl"], "outage": last == "o",
               "verdict": None, "p_on": 0.0, "loss": None, "cutoff": None, "off_from": None, "off_hours": 0,
               "reason": "", "model": NAME, "version": VERSION}
        if last == "o":
            row.update(verdict="outage", reason=f"on outage for {out_days:.0f} days at the last known hour ({known})")
        elif t == "nuclear" or g == "never":
            row.update(verdict="on", p_on=1.0, reason="never off" if g == "never" else "nuclear")
        elif t == "combustion_turbine":
            row.update(verdict="peaker", reason="judged by hour (peaker_share)")
        elif g in ("seasonal", "multiday"):
            floor = _month_floor(ctx, key)
            running = last in "ma"
            row["version"] = f"{VERSION}+seasonal-{SEASONAL_VERSION}"
            if mtd is None:
                row.update(verdict="nocut", p_on=1.0 if running else 0.0, reason="no hub prices for the month")
            elif running and (floor is None or mtd >= floor):
                row.update(verdict="on", p_on=1.0,
                           reason=f"running at {known}; {month} hub ${mtd:.0f} vs lowest month run through ${floor:.0f}" if floor is not None else f"running at {known}")
            elif running:
                row.update(verdict="off", p_on=0.0, off_from=1, off_hours=24,
                           reason=f"{month} hub ${mtd:.0f} below the lowest month it ran through (${floor:.0f})")
            else:
                row.update(verdict="off", p_on=0.0, off_from=1, off_hours=24, reason=f"off at {known}")
        elif g is None:
            s = ctx.stats["units"].get(key)
            row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0, reason="no hourly history")
        else:   # daily groups: the stay-on loss at the node against the unit's own cutoff
            prices = ctx.node_price(date, u["sp"], name=u["configs"][0]) if u["sp"] else None
            if prices is None or u["mingen"] is None or not u["lsl"]:
                s = ctx.stats["units"].get(key)
                row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0,
                           reason="no day-ahead price at its node" if prices is None else "no costs")
                rows[key] = row
                continue
            loss, bs, nh = _window((u["mingen"] - prices) * u["lsl"])
            days = _decision_rows(ctx, key, date)
            c = _cutoff(days) if days else None
            aw = float(np.mean([d[1] >= HALF for d in days])) if days else 0.0
            row["loss"] = round(float(loss))
            if c is None:
                s = ctx.stats["units"].get(key)
                row.update(verdict="nocut", p_on=round(s["on_days"], 2) if s else 0.0,
                           reason=f"too few decision days ({len(days)}) for a cutoff; loss ${loss:,.0f}")
            else:
                cut = c[0]
                row["cutoff"] = round(float(cut))
                if loss <= cut:
                    row.update(verdict="on", p_on=1.0, reason=f"loss ${loss:,.0f} at or below its cutoff ${cut:,.0f}")
                elif aw >= HALF:
                    row.update(verdict="maybe", p_on=round(aw, 2), off_from=bs + 1, off_hours=nh,
                               reason=f"loss ${loss:,.0f} above its cutoff ${cut:,.0f}, but an award usually covers the window ({aw:.0%} of days)")
                else:
                    row.update(verdict="off", p_on=0.0, off_from=bs + 1, off_hours=nh,
                               reason=f"loss ${loss:,.0f} above its cutoff ${cut:,.0f} over HE {bs + 1}-{bs + nh}")
            if u["est"] == 2:
                row["reason"] += " (generic costs)"
        rows[key] = row
    return {"rows": rows, "inputs": {"known_date": known, "hindsight": hindsight, "node_prices": node_src,
                                     "month": month, "month_hub": None if mtd is None else round(mtd, 2)}}
