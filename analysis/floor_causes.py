"""Committed-minimum error on cheap hours, split by cause.

  python analysis/floor_causes.py backtests/v1-vs-main/current

The error is the forecast committed minimum less the online LSL, summed over units each hour and
averaged over the cheap hours (MW; positive = forecast too high).  Each unit-hour falls in one cause:

  outage       forecast held MW, the unit was out (outage state that hour)
  on, was off  forecast held MW, the unit was off and not on outage
  off, was on  the unit was online and the forecast held less than half its LSL weight (p < 0.5)
  partial      both on: the forecast minimum differs from the online LSL (mostly a CC train running
               a different configuration)

Then the outage and on-was-off causes by group, to show which units carry them.
"""
import pandas as pd
from _common import args, side, table, unit_hours, write

a = args(__doc__)
d = side(a.side)
x = unit_hours(d, cheap_only=True)
nh = x.groupby(["date", "h"]).ngroups
x["err"] = x.exp - x.act
x["cause"] = "partial"
x.loc[(x.act == 0) & (x.state == "o"), "cause"] = "outage"
x.loc[(x.act == 0) & (x.state != "o"), "cause"] = "on, was off"
x.loc[(x.act > 0) & (x.p < 0.5), "cause"] = "off, was on"
hour = x.groupby(["date", "h"]).err.sum()
by = (x.groupby("cause").err.sum() / nh).to_frame("MW per cheap hour")
by.index.name = "cause"
tg = (x[x.cause.isin(["outage", "on, was off"])].groupby(["group", "cause"]).err.sum() / nh).unstack(fill_value=0)
tg.index.name = "group"
write(d, "floor_causes", "\n".join([
    f"# Cheap-hour floor error by cause: {d}", "",
    f"{nh} cheap hours on {x.date.nunique()} as-of days. Floor MAE {hour.abs().mean():,.0f} MW, bias {hour.mean():,.0f} MW.", "",
    table(by), "", "## Outage and on-was-off by group (MW per cheap hour)", "", table(tg), ""]))
