"""How much of the cheap-hour overstatement the unplanned outage report would have caught.

  python analysis/outage_catch.py backtests/v1-vs-main/current [--lag 4]

For each as-of day D, reads the NP1-346-ER snapshot posted on D minus --lag days (4 by default:
public before D's day-ahead market cleared) from site/data/outages/unplanned/, and takes off the
committed minimum of every unit listed as out at the start of D and not yet back:

  non-CC units  matched by unit name; removed when the listed outage is at least half its max MW
  CC trains     the report names the site, not the train, so each train at the site is scaled
                down by the site's MW out over its total MW (pro rata)

Prints the floor MAE and bias with and without the cut, and the MW removed by what the unit
actually did (on = removed wrongly).
"""
import datetime as dt
import gzip
import json
import numpy as np
import pandas as pd
from _common import args, side, table, unit_hours, write

a = args(__doc__, {"--lag": dict(type=int, default=4, help="days before D the snapshot was posted")})
d = side(a.side)
from pipeline.config import DATA_DIR

x = unit_hours(d, cheap_only=True).copy()
nh = x.groupby(["date", "h"]).ngroups
G = json.load(gzip.open(DATA_DIR / "groups_60d.json.gz"))["units"]
site_of = lambda k: k.rsplit("_CC", 1)[0]
site_mw = {}
for k, v in G.items():
    if v[0] == "combined_cycle":
        site_mw[site_of(k)] = site_mw.get(site_of(k), 0) + (v[2] or 0)
snaps = {}


def snap(day):
    if day not in snaps:
        p = DATA_DIR / "outages" / "unplanned" / f"{day}.json.gz"
        snaps[day] = json.load(gzip.open(p)) if p.exists() else None
    return snaps[day]


share, missing = {}, set()
for date, k, tech in x[["date", "unit", "tech"]].drop_duplicates().itertuples(index=False):
    s = snap((dt.date.fromisoformat(date) - dt.timedelta(days=a.lag)).isoformat())
    if not s:
        missing.add(date)
        share[(date, k)] = 0.0
        continue
    c = {n: i for i, n in enumerate(s["columns"])}
    t0 = date + "T00:00"
    live = [r for r in s["rows"] if not (r[c["actual_end"]] and r[c["actual_end"]] < t0)
            and not (r[c["planned_end"]] and r[c["planned_end"]] < t0)]
    if tech == "combined_cycle":
        out = sum((r[c["mw_out"]] or 0) for r in live if r[c["resource"]] == site_of(k))
        share[(date, k)] = min(1.0, out / site_mw[site_of(k)]) if site_mw.get(site_of(k)) else 0.0
    else:
        mine = [r for r in live if r[c["unit"]] == k]
        mx = max([r[c["mw_max"]] or 0 for r in mine] or [0])
        share[(date, k)] = 1.0 if mx and sum((r[c["mw_out"]] or 0) for r in mine) >= 0.5 * mx else 0.0
x["s"] = [share[(dd, k)] for dd, k in zip(x.date, x.unit)]
cut_all = x.exp * (1 - x.s)
cut_noncc = np.where(x.tech == "combined_cycle", x.exp, cut_all)


def mae(e):
    h = (e - x.act).groupby([x.date, x.h]).sum()
    return h.abs().mean(), h.mean()


rows = {"forecast": mae(x.exp), "outage cut, non-CC only": mae(cut_noncc), "outage cut, with CC pro rata": mae(cut_all)}
m = pd.DataFrame(rows, index=["floor MAE", "bias"]).T
m.index.name = "cheap hours"
truth = np.where(x.act > 0, "on", np.where(x.state == "o", "outage", "off"))
rm = ((x.exp - cut_all).groupby([truth, np.where(x.tech == "combined_cycle", "CC", "non-CC")]).sum() / nh).unstack(fill_value=0)
rm.index.name = "actually"
write(d, f"outage_catch-lag{a.lag}", "\n".join([
    f"# Outage report catch on cheap hours (snapshot D-{a.lag}): {d}", "",
    f"{nh} cheap hours on {x.date.nunique()} as-of days"
    + (f"; no snapshot for {len(missing)} day(s)" if missing else "") + ".", "",
    table(m), "", "## MW removed per cheap hour, by what the unit did", "", table(rm), ""]))
