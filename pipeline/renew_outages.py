"""Wind and solar outages: whole-unit outages from the 60-day telemetered status (OUT) and partial
derates from ERCOT's Unplanned Resource Outages report (NP1-346-ER, pipeline/outages.py), with an
estimate of the output each one took.  Needs no downloads.  Read by the Overview (wind and solar
bars to full potential) and the Unit page (outage banner, hour strip, outage table); the events
feed (pipeline/events.py) reads the spells.

Inputs
  {UNIT_DATA_DIR}/renew_hours_60d.json.gz   hourly states and HSL per unit (pipeline/intraday.py)
  data/outages/unplanned/<date>.json.gz     the report's daily snapshots (Wind and Solar rows)

What counts (Blair, Nov 5 2026: catch partial derates, with limits)
  - every hour the 60-day status is OUT for most of the hour's SCED runs (a full outage), except a
    run of OUT hours that falls only in hours the unit makes nothing (typical HSL under
    NIGHT_SHARE of capacity): some solar units telemeter OUT every night, which reads as offline;
  - a derate from the report when it takes at least DERATE_SHARE of the unit's max MW and at least
    DERATE_MW, for at least DERATE_HOURS (actual end, or its last planned end while open); a row
    with nothing left available always counts.  Smaller ones (a few turbines, one inverter) are
    left out.

Output each one took (MWh)
  typical HSL: for each unit, day and hour, the median of the unit's HSL at that hour over its
  TYP_DAYS nearest days (before or after) on which it was available that hour.  An OUT hour takes
  the typical HSL in full; a derate hour that is not OUT takes typical HSL x MW out / max MW (so a
  solar derate at night takes nothing).  Telemetered HSL already falls with a derate, so the
  derate's share comes out of what would otherwise read as "not available from the weather".

Potential (Blair, Nov 5 2026), for the hours a unit is in the data ("-" hours are left out):
  wind   its capacity every hour: the largest hourly HSL over the loaded days (the repository's
         CDR extract has no MW column); calm hours are weather;
  solar  a clear-sky envelope: per day and hour, the CLEAR_Q-th percentile of the unit's HSL at
         that hour over its CLEAR_DAYS nearest available days, never below that hour's HSL plus
         what outages took, capped at capacity.  Night and low sun are not counted as lost; the
         rest of the gap below the envelope is clouds.

Writes data/renew_outages_60d.json.gz
  {dates,
   cap:   {unit: MW},
   tech:  {unit: "wind"|"solar"},
   strips: {unit: one character per hour, 24 per day} only for units with any "o" hour or a
          counted derate: "-" no data, "r" available, "d" available but derated (counted), "o" OUT,
          "0" offline otherwise,
   days:  {date: {wind|solar: {pot: MWh potential, out: MWh outage took (OUT hours), der: MWh
          derates took, n: units with any outage hour or derate, top: [[unit, OUT hours, MWh
          (OUT + derate)], ...] largest TOP_UNITS]}},
   spells: [[unit, tech, kind "out"|"derate", start "YYYY-MM-DDTHH:MM", end (or null while
           open), MW out, max MW, report type or "OUT status", times the planned end moved], ...]}
"""
import datetime as dt

import numpy as np

from .config import DATA_DIR
from .intraday import RENEW_HOURS_PATH
from .outages import UNPLANNED_DIR
from .store import read_json_gz, write_json_gz

OUT_PATH = DATA_DIR / "renew_outages_60d.json.gz"
FUELS = {"Wind": "wind", "Solar": "solar"}
DERATE_SHARE = 0.10       # of the unit's max MW
DERATE_MW = 5.0
DERATE_HOURS = 4.0
CLEAR_DAYS = 30           # solar potential: nearest available days for the clear-sky envelope
CLEAR_Q = 95              # ... and the percentile of their HSL at the hour taken as clear sky
TYP_DAYS = 14             # nearest available days averaged for the typical HSL at an hour
TOP_UNITS = 8
NIGHT_SHARE = 0.05        # typical HSL under this share of capacity: the unit makes nothing then
OUT_SPELL_HOURS = 4       # a run of OUT hours this long or longer is listed as a spell


def _ts(s):
    return dt.datetime.fromisoformat(s) if s else None


def report_spells(dates: list, units: set) -> list:
    """Wind and solar outage rows from every stored snapshot, one per (unit, start), taking each
    one's latest snapshot: [unit, tech, start, end, open, mw_out, mw_max, type, planned-end moves,
    full]."""
    seen = {}
    snaps = sorted(UNPLANNED_DIR.glob("*.json.gz")) if UNPLANNED_DIR.exists() else []
    last_snap = None
    for p in snaps:
        d = read_json_gz(p, default=None)
        if not d or not d.get("rows"):
            continue
        ci = {c: i for i, c in enumerate(d["columns"])}
        last_snap = max(last_snap or d["date"], d["date"])
        for r in d["rows"]:
            tech = FUELS.get(r[ci["fuel"]])
            u = r[ci["unit"]]
            if not tech or not r[ci["start"]] or u not in units:
                continue
            k = (u, r[ci["start"]])
            e = seen.get(k)
            pe = r[ci["planned_end"]]
            if e is None:
                e = seen[k] = {"unit": u, "tech": tech, "start": r[ci["start"]], "moves": 0, "pe": pe, "snap": d["date"]}
            elif pe and e["pe"] and pe != e["pe"] and d["date"] >= e["snap"]:
                e["moves"] += 1
            if d["date"] >= e["snap"]:
                e.update(pe=pe or e["pe"], snap=d["date"], ae=r[ci["actual_end"]], mw_out=r[ci["mw_out"]],
                         mw_max=r[ci["mw_max"]], mw_avail=r[ci["mw_avail"]], type=r[ci["type"]])
    out = []
    for e in seen.values():
        if e["ae"]:
            end, open_ = e["ae"], False
        else:
            # gone from later snapshots without an actual end: over by the end of its last snapshot
            open_ = e["snap"] == last_snap
            end = e["pe"] if open_ else f"{e['snap']}T23:59"
            if e["pe"] and not open_:
                end = min(end, e["pe"])
        mw_max, mw_out = float(e.get("mw_max") or 0), float(e.get("mw_out") or 0)
        full = mw_max > 0 and (float(e.get("mw_avail") or 0) <= 0 or mw_out >= mw_max * 0.999)
        out.append([e["unit"], e["tech"], e["start"], end, open_, mw_out, mw_max, e["type"], e["moves"], full])
    return out


def counts(sp) -> bool:
    """A report row the site counts: a full outage, or a derate past the limits."""
    unit, tech, start, end, open_, mw_out, mw_max, typ, moves, full = sp
    if full:
        return True
    a, b = _ts(start), _ts(end)
    hours = (b - a).total_seconds() / 3600 if a and b else 0
    return mw_max > 0 and mw_out >= max(DERATE_MW, DERATE_SHARE * mw_max) and hours >= DERATE_HOURS


def _hsl_matrix(hsl_days: list, D: int) -> np.ndarray:
    m = np.full((D, 24), np.nan)
    for i, row in enumerate(hsl_days):
        if row:
            m[i] = [np.nan if v is None else v for v in row]
    return m


def near_stat(m: np.ndarray, k: int, q: float) -> np.ndarray:
    """[D, 24]: per day and hour, the q-th percentile of the unit's HSL at that hour over the k
    nearest days (before or after) on which it was available then; 0 where it never was."""
    D = m.shape[0]
    out = np.full((D, 24), np.nan)
    for h in range(24):
        avail = np.flatnonzero(np.isfinite(m[:, h]))
        if not len(avail):
            continue
        for i in range(D):
            near = avail[np.argsort(np.abs(avail - i), kind="stable")[:k]]
            out[i, h] = np.percentile(m[near, h], q)
    return np.nan_to_num(out)


def typical_hsl(hsl_days: list, D: int) -> np.ndarray:
    """[D, 24] typical HSL: per hour, the median over the TYP_DAYS nearest days available then."""
    return near_stat(_hsl_matrix(hsl_days, D), TYP_DAYS, 50)


def _daylight_runs(o: np.ndarray, typ: np.ndarray, cap: float) -> np.ndarray:
    """OUT hours that count: whole runs of OUT hours with at least one hour whose typical HSL is
    over NIGHT_SHARE of capacity.  Some solar units telemeter OUT every night; a run that only
    covers hours when the unit makes nothing anyway is not an outage (it reads as offline)."""
    flat, t = o.ravel(), typ.ravel()
    keep = np.zeros_like(flat)
    k = 0
    while k < len(flat):
        if not flat[k]:
            k += 1
            continue
        j = k
        while j < len(flat) and flat[j]:
            j += 1
        if (t[k:j] > NIGHT_SHARE * cap).any():
            keep[k:j] = True
        k = j
    return keep.reshape(o.shape)


def build_renew_outages(index: dict = None) -> None:
    rh = read_json_gz(RENEW_HOURS_PATH, default=None)
    if not rh or not rh.get("dates"):
        print("renew_outages: no renew_hours_60d yet (pipeline/intraday.py)")
        return
    dates, tech, strips, hsl = rh["dates"], rh["tech"], rh["units"], rh["hsl"]
    D = len(dates)
    didx = {d: i for i, d in enumerate(dates)}
    rep = [s for s in report_spells(dates, set(strips)) if counts(s)]

    # derate share per unit, day and hour (largest active counted row)
    der = {}
    for unit, t, start, end, open_, mw_out, mw_max, typ, moves, full in rep:
        a, b = _ts(start), _ts(end)
        if not a or not b or mw_max <= 0:
            continue
        frac = 1.0 if full else min(1.0, mw_out / mw_max)
        cur = a.replace(minute=0, second=0)
        while cur < b:
            i = didx.get(cur.date().isoformat())
            if i is not None:
                arr = der.setdefault(unit, np.zeros((D, 24)))
                arr[i, cur.hour] = max(arr[i, cur.hour], frac)
            cur += dt.timedelta(hours=1)

    cap, out_strips = {}, {}
    days = {d: {} for d in dates}
    spells = []
    for unit, s in strips.items():
        t = tech[unit]
        hs = [v for row in hsl[unit] if row for v in row if v is not None]
        c = max(hs) if hs else 0.0
        if c <= 0:
            continue
        cap[unit] = round(c, 1)
        st = np.array(list(s)).reshape(D, 24)
        typ = typical_hsl(hsl[unit], D)
        dr = der.get(unit)
        o = _daylight_runs(st == "o", typ, c)
        st = np.where((st == "o") & ~o, "0", st)
        d_on = (dr > 0) & (st == "r") if dr is not None else np.zeros((D, 24), bool)
        out_mwh = np.where(o, typ, 0.0)
        der_mwh = np.where(d_on, typ * (dr if dr is not None else 0), 0.0)
        if t == "solar":
            # clear-sky envelope: what the unit makes on a clear day at that hour and season;
            # never below what it had available or what an outage took that hour
            m = _hsl_matrix(hsl[unit], D)
            env = np.maximum(near_stat(m, CLEAR_DAYS, CLEAR_Q), np.nan_to_num(m))
            env = np.maximum(env, out_mwh + np.nan_to_num(m) + der_mwh)
            pot = np.where(st != "-", np.minimum(env, c), 0.0).sum(axis=1)
        else:
            pot = (st != "-").sum(axis=1) * c
        for i, d in enumerate(dates):
            if not pot[i]:
                continue
            x = days[d].setdefault(t, {"pot": 0.0, "out": 0.0, "der": 0.0, "n": 0, "top": []})
            x["pot"] += pot[i]
            om, dm = float(out_mwh[i].sum()), float(der_mwh[i].sum())
            if o[i].any() or d_on[i].any():
                x["out"] += om
                x["der"] += dm
                x["n"] += 1
                x["top"].append([unit, int(o[i].sum()), round(om + dm)])
        if o.any() or d_on.any():
            strip = st.copy()
            strip[d_on] = "d"
            out_strips[unit] = "".join(strip.ravel())
        # OUT spells from the status (cross days), so the Unit page and events have them without the report
        flat = o.ravel()
        k = 0
        while k < len(flat):
            if not flat[k]:
                k += 1
                continue
            j = k
            while j < len(flat) and flat[j]:
                j += 1
            if j - k >= OUT_SPELL_HOURS:
                a = f"{dates[k // 24]}T{k % 24:02d}:00"
                b = f"{dates[(j - 1) // 24]}T{(j - 1) % 24 + 1:02d}:00".replace("T24:00", "T23:59") if j < len(flat) else None
                spells.append([unit, t, "out", a, b, cap[unit], cap[unit], "OUT status", 0])
            k = j
    w0, w1 = f"{dates[0]}T00:00", f"{dates[-1]}T23:59"
    for unit, t, start, end, open_, mw_out, mw_max, typ, moves, full in rep:
        if full or start > w1 or (end and end < w0):
            continue           # whole-unit outages come from the OUT status above; derates outside the period are left out
        spells.append([unit, t, "derate", start, None if open_ else end, round(mw_out, 1), round(mw_max, 1), typ, moves])
    # the report's planned-end moves on a full outage go on the matching OUT spell
    full_rows = [r for r in rep if r[9]]
    for sp in spells:
        if sp[2] != "out":
            continue
        a = _ts(sp[3])
        for unit, t, start, end, open_, mw_out, mw_max, typ, moves, full in full_rows:
            if unit == sp[0] and abs((_ts(start) - a).total_seconds()) <= 36 * 3600:
                sp[7], sp[8] = typ, moves
                break
    for d in dates:
        for x in days[d].values():
            x["top"].sort(key=lambda r: -r[2])
            x["top"] = x["top"][:TOP_UNITS]
            for k in ("pot", "out", "der"):
                x[k] = round(x[k])
    spells.sort(key=lambda r: (r[3], r[0]))
    write_json_gz(OUT_PATH, {"dates": dates, "cap": dict(sorted(cap.items())), "tech": {u: tech[u] for u in sorted(cap)},
                             "strips": dict(sorted(out_strips.items())), "days": days, "spells": spells,
                             "limits": {"share": DERATE_SHARE, "mw": DERATE_MW, "hours": DERATE_HOURS}})
    print(f"renew_outages_60d: {len(cap)} units, {len(out_strips)} with outages, {len(spells)} spells "
          f"({sum(1 for s in spells if s[2] == 'derate')} derates)")


if __name__ == "__main__":
    build_renew_outages()
