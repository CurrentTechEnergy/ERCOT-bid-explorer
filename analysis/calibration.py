"""Calibration of the hourly on weight: does a unit held at p turn out online p of the time?

  python analysis/calibration.py backtests/v1-vs-main/current [--cheap]

Bins every unit-hour (cheap hours only with --cheap) by the weight the dispatch model applied and
compares the mean weight with the share actually online, overall and for daily-group units inside
their loss window, where the model's call matters.  Units on outage or with no data are left out.
"""
import numpy as np
import pandas as pd
from _common import args, side, table, unit_hours, write

a = args(__doc__, {"--cheap": dict(action="store_true", help="cheap hours only")})
d = side(a.side)
x = unit_hours(d, cheap_only=a.cheap)
x = x[~x.state.isin(["o", "-"]) & (x.tech != "nuclear")]
x["on"] = x.state.isin(["m", "a"]).astype(float)     # online by the merged hourly state
bins = [-0.01, 0.05, 0.2, 0.4, 0.6, 0.8, 0.95, 1.0]


def cal(y):
    g = y.groupby(pd.cut(y.p, bins), observed=True)
    t = pd.DataFrame({"unit-hours": g.size(), "mean p": g.p.mean(), "online share": g.on.mean()})
    t.index = t.index.astype(str)
    t.index.name = "p"
    return t


daily = x[x.group.str.startswith("daily") & x.win]
brier = lambda y: float(((y.p - y.on) ** 2).mean())
write(d, "calibration" + ("-cheap" if a.cheap else ""), "\n".join([
    f"# On-weight calibration{' (cheap hours)' if a.cheap else ''}: {d}", "",
    f"Brier score: all {brier(x):.3f}, daily units in window {brier(daily):.3f}.", "",
    "## All units", "", table(cal(x), "{:,.2f}"), "",
    "## Daily-group units, inside the loss window", "", table(cal(daily), "{:,.2f}"), ""]))
