"""Timescale groups: how often each thermal unit has shown it will shut down, from the hourly
states in data/unit_hours_60d.json.gz.  A port of the grouping trends.js uses for its
cheap-stretches panel (ST_GROUPS / stretchBase), so the pipeline and the page agree.

Combined-cycle configurations are merged into their train (the "best" state of any
configuration in the hour; a single offline hour between online hours is a configuration
change).  A non-running spell that is mostly outage, or has fewer than OUT_MIN_H OFF hours
before the outage, is an outage throughout; for coal (OUT_ANY_TECHS) any outage hour makes it
one.  An off spell is the offline hours after a running hour with at least OUT_MIN_H hours OFF
and no more missing hours than OFF hours; a spell still open at the end of the period counts
once it is a day long.

  never     no shutdown on price in the period (always on when available: off only for outages)
  seasonal  every off spell lasted 7 days or more
  multiday  shortest off spell between 24 h and 7 days
  daily1    at least two off spells under 24 h, fewer than one shutdown a week
  daily2    one to two shutdowns a week
  daily3    more than two shutdowns a week
  never_on  no running hour in at least NEVER_ON_DAYS days of hourly states (mothballed or on a
            long outage).  Units outside the trends units list (no offers or output in the
            window) are grouped only once they are never_on: with a shorter record they stay
            ungrouped, as before, since an idle peaker a few months into the window looks the
            same.  Listed units with a short all-outage record are never, as before

The Commitment build (PR 1, branch commitment-pipeline) writes the same groups to
data/groups_60d.json.gz from pipeline/groups.py (units: {unit or train: [tech, group, ...]}).
unit_groups() reads that file whenever it exists and falls back to the port below, so the two
builds agree whichever lands first.
"""
import datetime as dt

import numpy as np

from ..config import DATA_DIR
from ..groups import OUT_ANY_TECHS
from ..intraday import train_of
from ..store import read_json_gz
from ..trends import UNIT_TECHS, listed_units, unit_techs

OUT_MIN_H = 4
NEVER_ON_DAYS = 120
GROUPS = ["never", "seasonal", "multiday", "daily1", "daily2", "daily3", "never_on"]
GROUP_LABELS = {
    "never": "Always on when available", "seasonal": "Seasonal: off a week or more", "multiday": "Multi-day: off 1–7 days",
    "daily1": "Daily, under 1 shutdown a week", "daily2": "Daily, 1–2 a week", "daily3": "Daily, over 2 a week",
    "never_on": "Never on: no running hour in the period",
}
RANK = {"a": 4, "m": 3, "0": 2, "o": 1, "-": 0}


def merged_states(uh: dict, techs: dict, rewrite: bool = True) -> dict:
    """{train: (tech, state array over the whole period, one char per hour, days in calendar
    order with gaps as "-")} for thermal units, configurations merged, outage spells rewritten
    (unless rewrite is False: the raw merged states, for reading the state at a past hour
    without the later hours of its spell).  Also returns the period length in hours and the
    first date."""
    dates = uh.get("dates", [])
    if not dates:
        return {}, 0, None
    day0 = dt.date.fromisoformat(dates[0])
    day_no = [(dt.date.fromisoformat(d) - day0).days for d in dates]
    N = (day_no[-1] + 1) * 24
    rank = np.vectorize(RANK.get)
    by = {}
    for name, s in uh.get("units", {}).items():
        t = techs.get(name)
        if t not in UNIT_TECHS or t == "nuclear":     # nuclear never cycles; it is "never" by definition
            continue
        key = train_of(name) if t == "combined_cycle" else name
        a = np.frombuffer(s.encode(), dtype="S1").astype(str)
        e = by.get(key)
        if e is None:
            e = by[key] = (t, np.full(N, "-"))
        st = e[1]
        for i, dn in enumerate(day_no):
            seg = a[i * 24:(i + 1) * 24]
            if seg.size < 24:
                seg = np.concatenate([seg, np.full(24 - seg.size, "-")])
            cur = st[dn * 24:(dn + 1) * 24]
            pick = rank(seg) > rank(cur)
            cur[pick] = seg[pick]
    for key, (t, st) in by.items():
        if not rewrite:
            continue
        if t == "combined_cycle":
            run = np.isin(st, ["m", "a"])
            gap = (~run[1:-1]) & run[:-2] & run[2:] & (st[1:-1] == "0")
            st[1:-1][gap] = "m"
        run = np.isin(st, ["m", "a"])
        k = 0
        while k < N:
            if run[k]:
                k += 1
                continue
            j = k
            while j < N and not run[j]:
                j += 1
            seg = st[k:j]
            off, out = int((seg == "0").sum()), int((seg == "o").sum())
            if out and (off < OUT_MIN_H or out > off or t in OUT_ANY_TECHS):
                seg[seg == "0"] = "o"
            k = j
    return by, N, day0


def off_spells(st: np.ndarray):
    """[(start hour index, length, pure OFF)] off spells of a merged state array."""
    N, k, out = len(st), 0, []
    while k < N:
        if st[k] == "0" and k > 0 and st[k - 1] in "ma":
            j, off, outg, gap = k, 0, 0, 0
            while j < N and st[j] in "0o-":
                if st[j] == "0":
                    off += 1
                elif st[j] == "o":
                    outg += 1
                else:
                    gap += 1
                j += 1
            if gap <= off and off >= OUT_MIN_H and (j < N or j - k >= 24):
                out.append((k, j - k, outg == 0))
            k = j
        else:
            k += 1
    return out


def lead_off(st: np.ndarray) -> int:
    """Length of the off stretch open at the window start when it lasts a week or more (else 0).
    It is not a shutdown, but a unit that started late is seasonal rather than always-on."""
    N, j, off, gap = len(st), 0, 0, 0
    while j < N and st[j] in "0o-":
        off += st[j] == "0"
        gap += st[j] == "-"
        j += 1
    return j if j >= 168 and gap <= off and off >= OUT_MIN_H else 0


def group_of(st: np.ndarray, N: int) -> str:
    if not np.isin(st, ["m", "a"]).any() and (st != "-").sum() >= NEVER_ON_DAYS * 24:
        return "never_on"
    spells = off_spells(st)
    short = sum(1 for _, n, pure in spells if n < 24 and pure)
    long = [n for _, n, _ in spells if n >= 24] + [n for n in [lead_off(st)] if n]
    per_week = len(spells) / (N / 168.0)
    if short >= 2:
        return "daily1" if per_week < 1 else "daily2" if per_week <= 2 else "daily3"
    if long:
        return "multiday" if min(long) < 168 else "seasonal"
    return "never"


GROUP_FILE = DATA_DIR / "groups_60d.json.gz"


def listed_keys(tr: dict, techs: dict) -> set:
    """{train or unit} of the trends units list, the units grouped whatever their record."""
    return {train_of(n) if techs.get(n) == "combined_cycle" else n for n in listed_units(tr)}


def groups_of(by: dict, N: int, listed: set = None) -> dict:
    """{train: group} from merged states; with `listed`, a unit outside it is kept only as
    never_on (see the module docstring)."""
    out = {}
    for key, (t, st) in by.items():
        g = group_of(st, N)
        if listed is None or key in listed or g == "never_on":
            out[key] = g
    return out


def unit_groups(uh: dict = None, techs: dict = None, listed: set = None) -> dict:
    """{train: group} for every thermal unit or train with hourly states, from the pipeline's
    group file when it exists (PR 1), else computed here.  techs maps unit name to technology
    (default: trends_60d, its first_seen units included); listed the keys grouped whatever
    their record (default: the trends units list, see listed_keys)."""
    g = read_json_gz(GROUP_FILE, default=None)
    if g and isinstance(g.get("units"), dict):
        return {k: v[1] for k, v in g["units"].items() if v and len(v) > 1 and v[1] in GROUPS}
    if uh is None:
        uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    if techs is None or listed is None:
        tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
        techs = techs if techs is not None else unit_techs(tr)
        listed = listed if listed is not None else listed_keys(tr, techs)
    by, N, _ = merged_states(uh, techs)
    return groups_of(by, N, listed)


if __name__ == "__main__":
    from collections import Counter
    g = unit_groups()
    print(len(g), Counter(g.values()))
