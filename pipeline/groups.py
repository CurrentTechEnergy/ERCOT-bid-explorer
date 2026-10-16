"""Flexibility timescale groups: every thermal unit (combined-cycle configurations merged into
their train) by the finest timescale it has shown it will shut down on, from the hourly
per-unit strips in data/unit_hours_60d.json.gz.  Needs no downloads.  Read by trends.html (the
cheap-stretches panel, its month grid and the floor chart's behaviour view) and by the
Commitment page, so both use one definition.

Writes data/groups_60d.json.gz:
  dates             the period the groups were judged on (unit_hours_60d dates)
  groups            [[id, label, rule], ...] in display order (GROUPS)
  out_min_h         OUT_MIN_H
  units: {unit or train: [tech, group, MW, shutdowns, shortest off spell h, p10 h, median h,
                          configuration shown in Unit detail, 1 if it ran at all]}
    MW is the largest of its configurations' median HSL while running.

Rules (the same as trends.js had in stretchBase before this module):
- A unit's hourly strip is "m"/"a" running, "0" offline but available, "o" outage, "-" no data;
  a combined-cycle train takes, each hour, the most-running state of its configurations.
- A single offline hour inside a combined-cycle train is a configuration change, not a shutdown.
- Any non-running spell that is mostly outage, or has fewer than OUT_MIN_H OFF hours before or
  around an outage, is an outage throughout (a unit returning from a refuelling outage can report
  OFF for days).
- Off spells are the offline hours after a running hour: shutdowns, with outage hours inside them
  (a maintenance window slotted into an economic shutdown), at least OUT_MIN_H hours OFF and no
  more missing hours than OFF hours (a missing hour inside a spell is usually the spring clock
  change).  A spell still open at the end of the period counts once it is a day long.
- daily needs two pure OFF spells under 24 h (one can be a trip and restart) and is split by
  shutdowns per week over the period; a lone short spell does not place a unit.  Otherwise the
  shortest spell of a day or more decides multi-day (under a week) or seasonal; no spell, never.
"""
import re

import numpy as np

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

OUT_MIN_H = 4
GROUPS = [
    ["never", "Never off", "no shutdown in the period"],
    ["seasonal", "Seasonal: off a week or more", "every off spell lasted 7 days or more"],
    ["multiday", "Multi-day: off 1–7 days", "shortest off spell between 24 h and 7 days"],
    ["daily1", "Daily, under 1 shutdown a week", "at least two off spells under 24 h, fewer than one shutdown a week"],
    ["daily2", "Daily, 1–2 a week", "one to two shutdowns a week"],
    ["daily3", "Daily, over 2 a week", "more than two shutdowns a week"],
]
GROUPED_TECHS = ("coal", "combined_cycle", "gas_steam", "combustion_turbine")
RANK = {"a": 4, "m": 3, "0": 2, "o": 1, "-": 0}
_TRAIN = re.compile(r"^(.*_CC\d+)_")


def train_of(name: str) -> str:
    m = _TRAIN.match(name)
    return m.group(1) if m else name


def key_of(name: str, tech: str) -> str:
    return train_of(name) if tech == "combined_cycle" else name


def merged_strips(uh: dict, tech_of: dict) -> tuple:
    """-> (N hours on a gap-free calendar, {key: {"tech", "st": list, "configs": [(name, run)], "mw"}})"""
    dates = uh.get("dates") or []
    if not dates:
        return 0, {}
    day_no = [int(np.datetime64(d).astype(int)) for d in dates]
    d0 = day_no[0]
    N = (day_no[-1] - d0 + 1) * 24
    units = {}
    for name, s in uh.get("units", {}).items():
        t = tech_of.get(name)
        if t not in GROUPED_TECHS:
            continue
        key = key_of(name, t)
        e = units.get(key)
        if e is None:
            e = units[key] = {"tech": t, "st": ["-"] * N, "configs": [], "mw": 0.0}
        st, run = e["st"], 0
        for i, dn in enumerate(day_no):
            base = (dn - d0) * 24
            for h in range(24):
                c = s[i * 24 + h] if i * 24 + h < len(s) else "-"
                k = base + h
                if RANK.get(c, 0) > RANK[st[k]]:
                    st[k] = c
                if c in "ma":
                    run += 1
        e["configs"].append((name, run))
        e["mw"] = max(e["mw"], float((uh.get("hsl") or {}).get(name) or 0))
    return N, units


def rewrite_outages(e: dict) -> list:
    """The unit's strip with configuration changes filled and outage-like spells' OFF hours set
    to "o" (in place; returned for convenience)."""
    st, N = e["st"], len(e["st"])
    if e["tech"] == "combined_cycle":
        for k in range(1, N - 1):
            if st[k] == "0" and st[k - 1] in "ma" and st[k + 1] in "ma":
                st[k] = "m"
    k = 0
    while k < N:
        if st[k] in "ma":
            k += 1
            continue
        j, off, out = k, 0, 0
        while j < N and st[j] not in "ma":
            if st[j] == "0":
                off += 1
            elif st[j] == "o":
                out += 1
            j += 1
        if out and (off < OUT_MIN_H or out > off):
            for i in range(k, j):
                if st[i] == "0":
                    st[i] = "o"
        k = j
    return st


def classify(e: dict, N: int) -> dict:
    """Shutdowns and group of one merged unit whose strip has been through rewrite_outages."""
    st = e["st"]
    offs, short, long_ = [], 0, []
    k = 0
    while k < N:
        if st[k] == "0" and k > 0 and st[k - 1] in "ma":
            j, off, out, gap = k, 0, 0, 0
            while j < N and st[j] in "0o-":
                if st[j] == "0":
                    off += 1
                elif st[j] == "o":
                    out += 1
                else:
                    gap += 1
                j += 1
            if gap <= off and off >= OUT_MIN_H and (j < N or j - k >= 24):
                offs.append(j - k)
                if j - k >= 24:
                    long_.append(j - k)
                elif not out:
                    short += 1
            k = j
        else:
            k += 1
    per_week = len(offs) / (N / 168) if N else 0.0
    if short >= 2:
        group = "daily1" if per_week < 1 else "daily2" if per_week <= 2 else "daily3"
    elif long_:
        group = "multiday" if min(long_) < 168 else "seasonal"
    else:
        group = "never"
    o = sorted(offs)
    q = (lambda p: float(np.quantile(o, p))) if o else (lambda p: None)
    return {"group": group, "shut": len(offs), "off_min": o[0] if o else None,
            "off_p10": q(0.1), "off_med": q(0.5),
            "pick": sorted(e["configs"], key=lambda c: -c[1])[0][0],
            "ran": any(c in "ma" for c in st)}


def assign_groups(uh: dict, tech_of: dict) -> tuple:
    """-> (N, {key: merged unit dict with its classify() fields added})"""
    N, units = merged_strips(uh, tech_of)
    for e in units.values():
        rewrite_outages(e)
        e.update(classify(e, N))
    return N, units


def _r(x):
    return None if x is None else round(x, 1)


def build_groups(index: dict) -> dict:
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    tech_of = {u["unit"]: u["tech"] for u in tr.get("units", [])}
    N, units = assign_groups(uh, tech_of)
    out = {key: [e["tech"], e["group"], round(e["mw"]), e["shut"], e["off_min"], _r(e["off_p10"]),
                 _r(e["off_med"]), e["pick"], int(e["ran"])]
           for key, e in sorted(units.items())}
    write_json_gz(DATA_DIR / "groups_60d.json.gz", {
        "dates": uh.get("dates") or [], "groups": GROUPS, "out_min_h": OUT_MIN_H, "units": out})
    counts = {g[0]: sum(1 for v in out.values() if v[1] == g[0]) for g in GROUPS}
    print(f"groups_60d: {len(out)} units or trains: {counts}")
    return {key: e["group"] for key, e in units.items()}
