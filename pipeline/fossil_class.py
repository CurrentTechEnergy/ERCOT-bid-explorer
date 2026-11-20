"""The Goal page's fossil classes: which coal, combined-cycle, gas steam and combustion turbine units
price can reach, and how much of each class runs in cheap hours.  Built inside pipeline/goal.py
(its decision table and train-hours), written to goal.json.gz under "classes".

Three classes, each unit judged on the last LOOKBACK calendar years of the record (a unit that
changed its habits, such as Jack County, is classed on what it does now):

  1 Price-sensitive: turns off when price says to.
  2 Price-insensitive, has shown it can shut down.
  3 Price-insensitive, has never shown it can shut down.

Combined cycle and gas steam use the decision table's windows where shutting pays (bucket "more":
the shutdown beats the restart, the make-whole and the AS it gives up; RUC-held windows are their
own bucket and outages are not windows), the same windows as Goal Q3's heatmap:
  1  turned off for RATE_CUT or more of them over the lookback (MIN_WIN or more windows);
  2  less often, but turned off where shutting paid EVER_MIN times or more since 2019, or had an off
     spell (goal._group: OUT_MIN_H offline-available hours or more, not mostly outage) in a
     lookback year;
  3  neither.
  With fewer than MIN_WIN windows over the lookback: daily cycling once a week or more (the
  lookback's group) is 1, any other off spell 2, none 3 (2 with EVER_MIN turn-offs).
Coal (out of the decision table): the share of its available cheap hours it ran through.
  1  under COAL_SENSITIVE over the lookback; 2  under COAL_SHOWN in any year since 2019 (the
  2023 to 2024 spring cycling); 3  otherwise.
Combustion turbines, and any CC or gas steam unit with no window at all: 1 online in under
CT_SENSITIVE of its available cheap hours over the lookback; 2 any off spell in a lookback year;
3 none.

Cheap hours as the rest of the Goal page (DA system lambda at goal.CHEAP or less).  The tally is
each class's minimum output (LSL of the running configurations) online in cheap hours, at minimum
(strip "m") or above it ("a"), by year and hour ending; RUC hours apart where the 60-day files
say (from Nov 2025).  Every year uses today's classes; units with no class (not run in the
lookback, mostly retired) are class 0.
"""
from collections import defaultdict

import numpy as np
import pandas as pd

LOOKBACK = 2            # calendar years a unit is judged on (the latest, part year included)
RATE_CUT = 0.25         # share of windows where shutting pays turned off: price-sensitive at or above
MIN_WIN = 8             # windows where shutting pays over the lookback before the rate is used
EVER_MIN = 2            # turn-offs where shutting paid, since 2019, that show a unit can shut down
COAL_SENSITIVE = 0.75   # coal: share of available cheap hours run through, under it price-sensitive
COAL_SHOWN = 0.85       # coal: under it in any year shows it can shut down
CT_SENSITIVE = 0.5      # CTs: share of available cheap hours online, under it price-sensitive
MIN_CHEAP_H = 20        # available cheap hours a share needs
TECHS = ("coal", "combined_cycle", "gas_steam", "combustion_turbine")
FAST = ("daily, over 2 a week", "daily, 1 to 2 a week")
CLASSES = {1: "Price-sensitive", 2: "Price-insensitive, has shown it can shut down",
           3: "Price-insensitive, never shown it can shut down", 0: "No class (not run in the lookback)"}


def year_facts(year, h, groups, ruc=None):
    """One year of goal._year's train-hours `h` (train, tech, date, he, state, lsl, cheap, w) and
    each train's group that year (`groups`, goal._group's label or None).  `ruc`: a frame of
    train, date, he, ruc for the hours the 60-day files cover, else None.
    Returns (facts, tally, hours):
      facts  [[year, train, tech, group, cheap_avail_h, cheap_run_h, median running LSL]]
      tally  [[year, train, he, min_mwh, above_mwh, ruc_min_mwh, ruc_above_mwh]]
      hours  [[year, he, cheap hours]]"""
    x = h[h["tech"].isin(TECHS)]
    c = x[x["cheap"]]
    w = c["w"]
    avail = c["state"].isin(["m", "a", "0"])
    run = c["state"].isin(["m", "a"])
    av = (w * avail).groupby(c["train"]).sum()
    rn = (w * run).groupby(c["train"]).sum()
    lsl = x[x["state"].isin(["m", "a"])].groupby("train")["lsl"].median()
    tech = x.groupby("train")["tech"].first()
    facts = [[year, tr, tech[tr], groups.get(tr), round(float(av.get(tr, 0.0)), 1), round(float(rn.get(tr, 0.0)), 1),
              None if tr not in lsl or not np.isfinite(lsl[tr]) else round(float(lsl[tr]), 1)] for tr in tech.index]
    r = c[run].copy()
    r["isruc"] = False
    if ruc is not None and len(ruc):
        k = ruc[ruc["ruc"]][["train", "date", "he"]].assign(isruc=True)
        r = r.drop(columns="isruc").merge(k, on=["train", "date", "he"], how="left")
        r["isruc"] = r["isruc"].fillna(False).astype(bool)
    mwh = r["lsl"].fillna(0.0) * r["w"]
    atm = r["state"] == "m"
    parts = pd.DataFrame({"train": r["train"], "he": r["he"].astype(int),
                          "min": mwh.where(atm & ~r["isruc"], 0.0), "above": mwh.where(~atm & ~r["isruc"], 0.0),
                          "rmin": mwh.where(atm & r["isruc"], 0.0), "rabove": mwh.where(~atm & r["isruc"], 0.0)})
    t = parts.groupby(["train", "he"]).sum()
    tally = [[year, tr, int(he), *(round(float(v), 1) for v in row)] for (tr, he), row in t.iterrows()]
    hu = h[h["cheap"]].drop_duplicates(["date", "he"])
    hours = [[year, int(he), round(float(v), 2)] for he, v in hu.groupby("he")["w"].sum().items()]
    return facts, tally, hours


def classify(table, facts):
    """{train: [tech, class, lsl_mw, windows, turned_off, ever_off, cheap_run_share, lowest yearly
    cheap_run_share, its year, latest group]} from the decision table and year_facts' facts."""
    F = pd.DataFrame(facts, columns=["year", "train", "tech", "group", "avail", "run", "lsl"])
    if F.empty:
        return {}, []
    recent = sorted(F["year"].unique())[-LOOKBACK:]
    R = F[F["year"].isin(recent)]
    ran = R[R["group"].notna()]                       # ran at some hour in a lookback year
    more = table[(table["bucket"] == "more") & table["tech"].isin(["combined_cycle", "gas_steam"])] if table is not None else None
    out = {}
    for tr, g in ran.groupby("train"):
        tech = g["tech"].iat[-1]
        grp = g.sort_values("year")["group"].iat[-1]
        cycled = any(x not in (None, "never off") for x in g["group"])
        fast = any(x in FAST for x in g["group"])
        av, rn = float(g["avail"].sum()), float(g["run"].sum())
        share = rn / av if av >= MIN_CHEAP_H else None
        allf = F[F["train"] == tr]
        yr = allf[allf["avail"] >= MIN_CHEAP_H]
        ys = (yr["run"] / yr["avail"]) if len(yr) else pd.Series(dtype=float)
        low = float(ys.min()) if len(ys) else None
        low_y = int(yr["year"].iat[int(np.argmin(ys.to_numpy()))]) if len(ys) else None
        lsl = g["lsl"].dropna()
        lsl = float(lsl.iat[-1]) if len(lsl) else None
        n = off = ever = None
        if more is not None and tech in ("combined_cycle", "gas_steam"):
            m = more[more["train"] == tr]
            if len(m):
                mr = m[m["year"].isin(recent)]
                n, off, ever = int(len(mr)), int(mr["shut"].sum()), int(m["shut"].sum())
                if len(mr):
                    lsl = float(mr["lsl"].median())
        if n is not None:                             # CC or gas steam with windows where shutting pays
            if n >= MIN_WIN:
                cls = 1 if off / n >= RATE_CUT else 2 if (ever >= EVER_MIN or cycled) else 3
            else:
                cls = 1 if fast else 2 if (cycled or ever >= EVER_MIN) else 3
        elif tech == "coal":
            cls = 1 if (share is not None and share < COAL_SENSITIVE) else 2 if (low is not None and low < COAL_SHOWN) else 3
        else:
            cls = 1 if (share is not None and share < CT_SENSITIVE) else 2 if cycled else 3
        out[tr] = [tech, cls, None if lsl is None else round(lsl), n, off, ever,
                   None if share is None else round(share, 3), None if low is None else round(low, 3), low_y, grp]
    return out, [int(y) for y in recent]


def build(table, facts, tally, hours):
    """goal.json.gz's "classes" block:
      {"lookback": [years], "classes": {class: label}, "rules": {...},
       "units": [[train, tech, class, lsl_mw, windows, turned_off, ever_off, cheap_run_share,
                  lowest_yearly_cheap_run_share, its_year, latest_group]],
       "hours": [[year, he, cheap hours]],
       "mw": [[year, tech, class (0 to 3, or "ruc"), he, min_mwh, above_mwh]]}
    MWh sums over the year's cheap hours: the page divides by "hours" for the mean."""
    units, recent = classify(table, facts)
    tech = {f[1]: f[2] for f in facts}
    agg = defaultdict(lambda: [0.0, 0.0])
    for year, tr, he, mn, ab, rmn, rab in tally:
        t = units[tr][0] if tr in units else tech.get(tr)
        k = (year, t, units[tr][1] if tr in units else 0, he)
        agg[k][0] += mn
        agg[k][1] += ab
        if rmn or rab:
            a = agg[(year, t, "ruc", he)]
            a[0] += rmn
            a[1] += rab
    mw = [[y, t, c, he, round(a), round(b)] for (y, t, c, he), (a, b) in sorted(agg.items(), key=lambda kv: tuple(map(str, kv[0])))
          if a or b]
    return {"lookback": recent, "classes": {str(k): v for k, v in CLASSES.items()},
            "rules": {"rate_cut": RATE_CUT, "min_win": MIN_WIN, "ever_min": EVER_MIN, "coal_sensitive": COAL_SENSITIVE,
                      "coal_shown": COAL_SHOWN, "ct_sensitive": CT_SENSITIVE, "min_cheap_h": MIN_CHEAP_H},
            "units": [[tr, *v] for tr, v in sorted(units.items())], "hours": hours, "mw": mw}
