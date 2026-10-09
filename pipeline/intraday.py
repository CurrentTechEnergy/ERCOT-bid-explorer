"""Within-day thermal operations from the per-unit day files: how much thermal output sits at
minimum in cheap hours, when units shut down and restart, and an hour-by-hour state for each
unit.  Needs no downloads.  Read by trends.html.

Writes
  data/intraday_60d.json.gz
    dates            the 60-day dates (same list as trends_60d)
    lambda           [day][24] hourly system lambda (null where missing)
    tech[t]          for each thermal technology, [day][24] arrays (null where the day has no
                     per-unit file):
                       at_min  MW of output up to each running unit's LSL
                       above   MW of output above LSL
                       n       units running
                     and cap_<group>: [day] average MW of capacity (HSL) in each status group
                     (STATUS_GROUPS, see status_group)
    above_units      units that ran above minimum in cheap hours, all days together:
                     [unit, tech, threshold, hours running, hours above minimum, MWh above minimum]
                     for each threshold in CHEAP (hours with lambda below it)
    spells           off spells of thermal units (combined cycle by train, configurations merged):
                     [unit or train, tech, shutdown date, "HH:MM",
                     hours off (null if not back on within the loaded days), mean lambda over the
                     first 4 hours off, mean lambda while off (first 24 h), 1 if the unit went
                     on outage (OUT) during the spell]
  data/unit_hours_60d.json.gz
    dates, units: {unit: "one character per hour, 24 per day"}:
      "-" no data, "0" offline, "o" on outage, "m" running at minimum, "a" running above minimum
    hsl: {unit: median HSL in the hours it ran (MW)}

A unit runs in an hour when most of its SCED runs in that hour have an online status (ON...);
an hour it does not run counts as an outage when most of its runs that hour are OUT.
"At minimum" means hourly output no more than ABOVE_EPS of HSL above the hour's LSL.
"""
import re

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz
from .trends import UNIT_TECHS
from .units import expand

ABOVE_EPS = 0.05          # share of HSL above LSL that still counts as "at minimum"
CHEAP = [0, 10]           # $/MWh thresholds for the above-minimum table
SHUT_TO = ("OFF", "SHUTDOWN", "OFFQS")   # an online unit going to one of these is a shutdown
NEXT_H = 4                # hours after a shutdown averaged for "price when it went off"
MAX_OFF_H = 24            # hours of an off spell averaged for "price while off"


# A combined-cycle train is registered as one resource per configuration, and each SCED run lists
# exactly one of them, so a train's status sequence is its configurations' events put together.
_TRAIN = re.compile(r"^(.*_CC\d+)_")


def train_of(name: str) -> str:
    m = _TRAIN.match(name)
    return m.group(1) if m else name


def _spell_units(units: dict) -> dict:
    """{key: (tech, status events)} for off-spell tracking: thermal units by name, combined-cycle
    configurations merged into their train (absent runs (None) dropped, events in run order)."""
    out, merged = {}, {}
    for name, u in units.items():
        t = u["tech"]
        if t not in UNIT_TECHS:
            continue
        if t == "combined_cycle":
            merged.setdefault(train_of(name), []).extend(ev for ev in u["status"] if ev[1] is not None)
        else:
            out[name] = (t, u["status"])
    for key, evs in merged.items():
        out[key] = ("combined_cycle", sorted(evs, key=lambda ev: ev[0]))
    return out


def _online(s):
    return bool(s) and s.startswith("ON")


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# capacity (HSL) by status group, from the raw "Telemetered Resource Status" codes
STATUS_GROUPS = ["offer", "schedule", "ruc", "other_on", "off", "out"]


def status_group(s):
    """offer: ON (running on its offer curve); schedule: ONOS (running to an output schedule);
    ruc: ONRUC/ONOPTOUT (committed by ERCOT's RUC); other_on: any other online or transitional
    state (ONTEST, ONHOLD, ONREG, ONEMR, EMR, EMRSWGR, STARTUP, SHUTDOWN, ...); off: OFF...
    (offline but available); out: OUT (outage).  None for blank or absent."""
    if not s:
        return None
    if s == "ON":
        return "offer"
    if s == "ONOS":
        return "schedule"
    if s in ("ONRUC", "ONOPTOUT"):
        return "ruc"
    if s == "OUT":
        return "out"
    if s.startswith("OFF"):
        return "off"
    return "other_on"


def unit_hours(u: dict, runs: list) -> tuple:
    """Per hour of the day: state char, output, LSL, HSL (NaN where not running); and the
    expanded per-run values (units.expand)."""
    n = len(runs)
    e = expand(u, n)
    hr = np.minimum(np.array(runs) // 60, 23)
    on = np.array([_online(s) for s in e["status"]])
    is_out = np.array([s == "OUT" for s in e["status"]])
    present = np.array([s is not None for s in e["status"]])
    out = np.array([np.nan if v is None else v for v in u["out"]], float)
    states, lsl_h, hsl_h = [], np.full(24, np.nan), np.full(24, np.nan)
    for h in range(24):
        idx = hr == h
        if not idx.any() or not present[idx].any():
            states.append("-")
            continue
        if on[idx].mean() < 0.5 or np.isnan(out[h]):
            states.append("o" if is_out[idx & present].mean() > 0.5 else "0")
            continue
        sel = idx & on
        lsl, hsl = np.nanmean(e["lsl"][sel]), np.nanmean(e["hsl"][sel])
        lsl = 0.0 if np.isnan(lsl) else lsl
        lsl_h[h], hsl_h[h] = lsl, hsl
        above = out[h] - lsl > ABOVE_EPS * (hsl if hsl > 0 else 1.0)
        states.append("a" if above else "m")
    return "".join(states), out, lsl_h, hsl_h, e


def build_intraday(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    D = len(dates)
    lam = []
    for d in dates:
        v = (prices.get(d) or {}).get("lambda") or []
        lam.append([_r(v[h], 2) if h < len(v) and v[h] is not None else None for h in range(24)])
    lam_arr = np.array([[np.nan if x is None else x for x in row] for row in lam], float)
    day_no = {d: int(np.datetime64(d).astype(int)) for d in dates}
    date_idx = {d: i for i, d in enumerate(dates)}

    tech = {t: {k: [None] * D for k in ["at_min", "above", "n"] + ["cap_" + g for g in STATUS_GROUPS]}
            for t in UNIT_TECHS}
    strips = {}
    hsl_run = {}              # unit -> list of hourly HSL while running
    above_acc = {}            # (unit, thr) -> [tech, hours running, hours above, MWh above]
    spells = []
    pending = {}              # unit -> open spell (dict) carried across consecutive days
    last_status = {}          # unit -> last non-blank status of the previous day
    prev_day = None
    n_files = 0

    def lam_window(abs_min, hours):
        """Mean hourly lambda over `hours` hours from an absolute minute (days since epoch)."""
        vals = []
        for k in range(hours):
            m = abs_min + 60 * k
            dn, h = divmod(m, 1440)
            d = str(np.datetime64(int(dn), "D"))
            i = date_idx.get(d)
            if i is not None and np.isfinite(lam_arr[i, h // 60]):
                vals.append(lam_arr[i, h // 60])
        return _r(np.mean(vals), 2) if vals else None

    def close(name, sp, end_min):
        off_h = None if end_min is None else (end_min - sp["start"]) / 60
        span = MAX_OFF_H if off_h is None else max(1, min(MAX_OFF_H, int(np.ceil(off_h))))
        spells.append([name, sp["tech"], sp["date"], sp["hhmm"], _r(off_h),
                       lam_window(sp["start"], NEXT_H), lam_window(sp["start"], span), sp["out"]])

    for di, d in enumerate(dates):
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        consecutive = prev_day is not None and day_no[d] == day_no[prev_day] + 1
        if not consecutive:
            for name, sp in pending.items():
                close(name, sp, None)
            pending, last_status = {}, {}
        if not ud:
            prev_day = None
            for name in strips:
                strips[name].append("-" * 24)
            continue
        n_files += 1
        prev_day = d
        runs = ud["runs"]
        acc = {t: (np.zeros(24), np.zeros(24), np.zeros(24)) for t in UNIT_TECHS}
        cap = {t: dict.fromkeys(STATUS_GROUPS, 0.0) for t in UNIT_TECHS}
        seen, new_last = set(), {}
        for name, u in ud["units"].items():
            t = u["tech"]
            if t not in UNIT_TECHS:
                continue
            seen.add(name)
            st, out, lsl, hsl, e = unit_hours(u, runs)
            sacc = cap[t]
            for s_, h_ in zip(e["status"], e["hsl"]):
                g = status_group(s_)
                if g and np.isfinite(h_):
                    sacc[g] += h_
            strips.setdefault(name, ["-" * 24] * di).append(st)
            hsl_run.setdefault(name, []).extend(v for v in hsl if np.isfinite(v))
            a_min, a_above, a_n = acc[t]
            for h, c in enumerate(st):
                if c in "ma":
                    lo = min(out[h], lsl[h])
                    a_min[h] += max(lo, 0.0)
                    a_above[h] += max(out[h] - lsl[h], 0.0)
                    a_n[h] += 1
                    for thr in CHEAP:
                        if np.isfinite(lam_arr[di, h]) and lam_arr[di, h] < thr:
                            r = above_acc.setdefault((name, thr), [t, 0, 0, 0.0])
                            r[1] += 1
                            if c == "a":
                                r[2] += 1
                                r[3] += out[h] - lsl[h]
        # off spells from status changes, run by run; a spell open at the end of yesterday
        # and yesterday's last status carry over when the days are consecutive
        for name, (t, events) in _spell_units(ud["units"]).items():
            seen.add(name)
            sp = pending.pop(name, None)
            prev = last_status.get(name)
            for r_i, s in events:
                if not s:
                    continue
                m = day_no[d] * 1440 + runs[r_i]
                if sp is not None:
                    if _online(s):
                        close(name, sp, m)
                        sp = None
                    elif s == "OUT":
                        sp["out"] = 1
                elif _online(prev) and s in SHUT_TO:
                    mm = runs[r_i] % 1440
                    sp = {"tech": t, "date": d, "hhmm": f"{mm // 60:02d}:{mm % 60:02d}", "start": m, "out": 0}
                prev = s
            if sp is not None:
                pending[name] = sp
            if prev is not None:
                new_last[name] = prev
        for name in list(pending):
            if name not in seen:          # unit missing from this day's file
                close(name, pending.pop(name), None)
        for name in strips:
            if len(strips[name]) < di + 1:
                strips[name].append("-" * 24)
        last_status = new_last
        for t in UNIT_TECHS:
            a_min, a_above, a_n = acc[t]
            tech[t]["at_min"][di] = [round(float(v)) for v in a_min]
            tech[t]["above"][di] = [round(float(v)) for v in a_above]
            tech[t]["n"][di] = [int(v) for v in a_n]
            for g in STATUS_GROUPS:
                tech[t]["cap_" + g][di] = round(cap[t][g] / len(runs))
    for name, sp in pending.items():
        close(name, sp, None)

    above_units = [[u, r[0], thr, r[1], r[2], round(r[3])] for (u, thr), r in sorted(above_acc.items())]
    write_json_gz(DATA_DIR / "intraday_60d.json.gz", {
        "dates": dates, "lambda": lam, "techs": UNIT_TECHS, "tech": tech, "cheap": CHEAP,
        "above_eps": ABOVE_EPS, "next_h": NEXT_H, "max_off_h": MAX_OFF_H,
        "above_units": above_units, "spells": sorted(spells, key=lambda s: (s[2], s[3], s[0])),
    })
    write_json_gz(DATA_DIR / "unit_hours_60d.json.gz", {
        "dates": dates, "units": {k: "".join(v) for k, v in sorted(strips.items())},
        "hsl": {k: round(float(np.median(v))) for k, v in sorted(hsl_run.items()) if v},
    })
    print(f"intraday_60d: {D} days, {n_files} per-unit day file(s), {len(spells)} off spells, "
          f"{len(strips)} unit strips")

