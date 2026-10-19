"""Unit calls through the loss window: verdict against whether the unit stayed online.

  python analysis/calls.py backtests/v1-vs-main/current

For every unit-day with a loss window, the share of window hours the unit was online (0.5 or more
counts as stayed on), cross-tabbed by the forecast verdict, with the LSL MW involved.  Outage days
are left out.  Hit rate counts "on"/"stay" verdicts that stayed on and "off" verdicts that went off.
"""
import pandas as pd
from _common import args, side, table, unit_hours, write

a = args(__doc__)
d = side(a.side)
x = unit_hours(d)
w = x[x.win & ~x.state.isin(["o", "-"])]
u = w.groupby(["date", "unit"]).agg(verdict=("verdict", "first"), tech=("tech", "first"), group=("group", "first"),
                                    p=("p", "mean"), online=("state", lambda s: float(s.isin(["m", "a"]).mean())))
u["stayed"] = u.online >= 0.5
t = u.groupby(["verdict", "stayed"]).size().unstack(fill_value=0)
t.columns = ["went off" if not c else "stayed on" for c in t.columns]
t.index.name = "verdict"
off = u.verdict == "off"
on = ~u.verdict.isin(["off", "maybe"])
hit = (int((off & ~u.stayed).sum()) + int((on & u.stayed).sum())) / max(1, int((off | on).sum()))
g = u.groupby("group").agg(days=("p", "size"), mean_p=("p", "mean"), stayed=("stayed", "mean"))
g.index.name = "group"
write(d, "calls", "\n".join([
    f"# Unit calls through the loss window: {d}", "",
    f"{len(u):,} unit-days with a window on {u.index.get_level_values(0).nunique()} as-of days; "
    f"hit rate on firm calls {hit:.1%}.", "", table(t), "", "## By group", "", table(g, "{:,.2f}"), ""]))
