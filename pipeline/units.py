"""Per-unit day files: every unit's status, limits and submitted offer curve at every SCED
run of one operating day, stored as change-of-value (COV) events.

Written by parse_60day for each 60-day disclosure day to
    {UNIT_DATA_DIR}/60d/{date}.json.gz
(UNIT_DATA_DIR from config; in GitHub Actions a checkout of the orphan `data` branch).

Schema
------
{
  "date": "YYYY-MM-DD",
  "format": 7,                # UNIT_FORMAT below (7: diesel/recip "DSL" units are tech
                              # combustion_turbine, no longer "other"); update.reprocess_60d redoes older files
  "runs": [m0, m1, ...],      # SCED run timestamps, minutes after midnight (int, floor of the
                              # timestamp; +1440 if a run falls on the next calendar day), in
                              # time order.  A "run index" below is a position in this list.
  "dst_repeat": [i, ...],     # only on a fall-back day: run indices flagged "Repeated Hour Flag"
                              # = Y (the second 01:xx hour; same minutes as the first one)
  "units": {
    "<Resource Name>": {
      "type": "CCGT90",       # raw Resource Type
      "tech": "combined_cycle",   # config.TECH_OF_TYPE grouping ("other" if unmapped)
      "frac": true,           # only for tech wind/solar: curve MW are stored as fractions of HSL
      "status": [[run, "ON"], [run, "OFF"], [run, ""], [run, null], ...],   # "" = blank in ERCOT's file
                              # raw "Telemetered Resource Status" code whenever it changes;
                              # null = unit absent from that run onwards (until the next event)
      "lim":    [[run, hsl, lsl], ...],          # MW rounded to 1, when either changes
      "curve":  [[run, [p1..pn], [mw1..mwn]], [run, null], ...],
                              # submitted offer curve ("Submitted TPO" price/MW pairs, NaN
                              # padding dropped), prices rounded to 0.01 $/MWh, MW to 0.1
                              # (fractions of HSL rounded to 0.01 when "frac"; HSL <= 0 -> 0).
                              # null = no submitted curve.  Storage (ESR) MW are stored as-is,
                              # negative (charging) to positive.
      "oschd":  [[run, mw or null], ...],        # Output Schedule (MW, 0.1), only if the file
                              # has that column
      "curve2": [[run, [p1..pn], [mw1..mwn]], [run, null], ...],
                              # the SCED2 curve, encoded like "curve": the submitted curve
                              # after ERCOT's extension to the unit's limits and mitigation,
                              # i.e. what SCED dispatched against (format 6 on)
      "disp":   [[run, base point, hdl, ldl, as up, as down, mit bp, mit max], ...],
                              # when any changes: SCED's base point for the run (MW, 0.1), the
                              # ramp-limited range (HDL, LDL) it had to stay within, the
                              # ancillary service awarded in the run (up: Reg-Up, RRS, ECRS,
                              # Non-Spin; down: Reg-Down), which takes energy room from that
                              # range, and how far mitigation lowered the offer ($/MWh, 0.1):
                              # SCED1 minus SCED2 price at the base point, and the largest cut
                              # anywhere between LSL and HSL.  null where the file has no
                              # value.  Files from before format 4 lack this list; format 4
                              # files have the first four values, format 5 the first six.
      "soc":    [[run, soc, min soc, max soc], ...],   # storage (ESR) only, format 7 on: the
                              # telemetered state of charge and its limits (MWh, 0.1) when any
                              # changes; null where the file has no value.  Absent for other
                              # units and for ESR files without the columns (before Feb 2026)
      "ascap":  [[run, regup, regdn, rrs, ecrs, nspin], ...],
                              # storage only, format 7 on: the AS capability telemetered per
                              # service (MW, 0.1; RRS = PFR + FFR + UFR) when any changes
      "out": [24 x hourly mean Telemetered Net Output, 0.1 MW, or null],
      "bp":  [24 x hourly mean Base Point, 0.1 MW, or null]
                              # hourly means over the runs the unit is present in, any status
    }, ...
  },
  "overrides_format": 3, # version of the override parsing below (reprocess redoes older files)
  "overrides": {        # from the disclosure's HDL/LDL Manual Override Summary (empty if none that day;
                        # absent in files written before it was read)
    "<Resource Name>": [[minutes after midnight, HDL original, HDL manual, HDL final,
                         LDL original, LDL manual, LDL final, reason code], ...]
  }                     # SCED runs where an ERCOT operator changed the unit's dispatch limits
}
Every event list is sorted by run index and its first event is at the unit's first run, so the
value at run r is the last event with index <= r.  Runs where status is null carry no meaning
for the other lists.  `expand()` below reconstructs per-run arrays.
"""
import numpy as np
import pandas as pd

from .curves import mw_at_prices

FRAC_TECHS = ("wind", "solar")
UNIT_FORMAT = 7      # bump when the day file gains something a reprocess of history should fill in


# ------------------------------------------------------------------ encoding --
def _changed(a: np.ndarray, first: np.ndarray) -> np.ndarray:
    """Row i differs from row i-1 (NaN == NaN), or starts a new unit."""
    a = a.reshape(len(a), -1)
    prev = np.vstack([a[:1], a[:-1]])
    same = (a == prev) | (pd.isna(a) & pd.isna(prev))
    return first | ~same.all(axis=1)


def _f(x, nd):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


def _int(x):
    return None if np.isnan(x) else int(x)


def build_unit_day(date: str, run_sort: pd.DataFrame, rows: dict) -> dict:
    """run_sort: one row per run with columns key, minutes, repeat (bool), order (sort key).
    rows: per-row arrays: run (run key), unit, type, tech, status, hsl, lsl, bp, out, hour,
          oschd (or None), tpo_p, tpo_m (2-D, NaN padded)."""
    run_sort = run_sort.sort_values(["order", "repeat"], ascending=[True, False]).reset_index(drop=True)
    run_idx = {k: i for i, k in enumerate(run_sort["key"])}
    n_runs = len(run_sort)

    ri = np.array([run_idx[k] for k in rows["run"]], dtype=int)
    unit = np.asarray(rows["unit"], dtype=object)
    order = np.lexsort((ri, unit))
    # one row per (unit, run)
    u_s, r_s = unit[order], ri[order]
    keep = np.r_[True, (u_s[1:] != u_s[:-1]) | (r_s[1:] != r_s[:-1])]
    order = order[keep]

    def take(name):
        return np.asarray(rows[name])[order]

    unit, ri = unit[order], ri[order]
    tech, rtype, status = take("tech"), take("type"), take("status")
    hsl_raw = take("hsl").astype(float)
    hsl, lsl = np.round(hsl_raw), np.round(take("lsl").astype(float))
    bp, out, hour = take("bp").astype(float), take("out").astype(float), take("hour").astype(int)
    hdl = take("hdl").astype(float) if rows.get("hdl") is not None else np.full(len(bp), np.nan)
    ldl = take("ldl").astype(float) if rows.get("ldl") is not None else np.full(len(bp), np.nan)
    asup = take("asup").astype(float) if rows.get("asup") is not None else np.full(len(bp), np.nan)
    asdn = take("asdn").astype(float) if rows.get("asdn") is not None else np.full(len(bp), np.nan)
    mit_bp = take("mit_bp").astype(float) if rows.get("mit_bp") is not None else np.full(len(bp), np.nan)
    mit_max = take("mit_max").astype(float) if rows.get("mit_max") is not None else np.full(len(bp), np.nan)
    disp = np.round(np.column_stack([bp, hdl, ldl, asup, asdn, mit_bp, mit_max]), 1)
    # storage only (format 7): state of charge and AS capability, NaN rows for every other unit
    has_soc = rows.get("soc") is not None
    if has_soc:
        soc = np.round(np.column_stack([take("soc"), take("soc_min"), take("soc_max")]).astype(float), 1)
        ascap = np.round(take("ascap").astype(float), 1) if rows.get("ascap") is not None else np.full((len(bp), 5), np.nan)
    oschd = None if rows.get("oschd") is None else np.round(take("oschd").astype(float), 1)
    P, M = take("tpo_p").astype(float), take("tpo_m").astype(float)
    valid = ~np.isnan(P) & ~np.isnan(M)
    P = np.where(valid, np.round(P, 2), np.nan)
    frac = np.isin(tech, FRAC_TECHS)
    with np.errstate(invalid="ignore", divide="ignore"):
        Mf = np.where(hsl_raw[:, None] > 0, M / hsl_raw[:, None], 0.0)
    M = np.where(valid, np.where(frac[:, None], np.round(Mf, 2), np.round(M, 1)), np.nan)
    # the SCED2 curve (what SCED dispatched against), encoded the same way
    has2 = rows.get("s2_p") is not None
    if has2:
        P2, M2 = take("s2_p").astype(float), take("s2_m").astype(float)
        valid2 = ~np.isnan(P2) & ~np.isnan(M2)
        P2 = np.where(valid2, np.round(P2, 2), np.nan)
        with np.errstate(invalid="ignore", divide="ignore"):
            M2f = np.where(hsl_raw[:, None] > 0, M2 / hsl_raw[:, None], 0.0)
        M2 = np.where(valid2, np.where(frac[:, None], np.round(M2f, 2), np.round(M2, 1)), np.nan)

    first = np.r_[True, unit[1:] != unit[:-1]]
    gap = np.r_[False, (ri[1:] != ri[:-1] + 1) & ~first[1:]]   # unit was absent just before
    st_obj = status.astype(object)
    ch_status = first | gap | np.r_[True, st_obj[1:] != st_obj[:-1]]
    ch_lim = _changed(np.column_stack([hsl, lsl]), first)
    ch_curve = _changed(np.hstack([P, M]), first)
    ch_curve2 = _changed(np.hstack([P2, M2]), first) if has2 else None
    ch_os = _changed(oschd, first) if oschd is not None else None
    ch_disp = _changed(disp, first)
    if has_soc:
        ch_soc = _changed(soc, first)
        ch_cap = _changed(ascap, first)

    # hourly means of output and base point over the runs each unit is present in
    hm = pd.DataFrame({"u": unit, "h": hour, "out": out, "bp": bp}).groupby(["u", "h"]).mean()

    units = {}
    starts = np.flatnonzero(first)
    ends = np.r_[starts[1:], len(unit)]
    n_events = 0
    for a, b in zip(starts, ends):
        name = unit[a]
        e = {"type": rtype[a], "tech": tech[a]}
        if frac[a]:
            e["frac"] = True
        st = []
        for i in range(a, b):
            if gap[i]:
                st.append([int(ri[i - 1]) + 1, None])
            if ch_status[i]:
                st.append([int(ri[i]), status[i]])
        if ri[b - 1] < n_runs - 1:
            st.append([int(ri[b - 1]) + 1, None])
        e["status"] = st
        e["lim"] = [[int(ri[i]), _int(hsl[i]), _int(lsl[i])] for i in range(a, b) if ch_lim[i]]
        cv = []
        for i in np.flatnonzero(ch_curve[a:b]) + a:
            v = valid[i]
            if v.any():
                cv.append([int(ri[i]), [float(x) for x in P[i][v]],
                           [float(x) for x in M[i][v]]])
            else:
                cv.append([int(ri[i]), None])
        e["curve"] = cv
        if has2:
            cv2 = []
            for i in np.flatnonzero(ch_curve2[a:b]) + a:
                v = valid2[i]
                cv2.append([int(ri[i]), [float(x) for x in P2[i][v]], [float(x) for x in M2[i][v]]] if v.any() else [int(ri[i]), None])
            e["curve2"] = cv2
        if ch_os is not None:
            e["oschd"] = [[int(ri[i]), _f(oschd[i], 1)] for i in range(a, b) if ch_os[i]]
        e["disp"] = [[int(ri[i])] + [_f(v, 1) for v in disp[i]] for i in range(a, b) if ch_disp[i]]
        if has_soc and not np.isnan(soc[a:b]).all():
            e["soc"] = [[int(ri[i])] + [_f(v, 1) for v in soc[i]] for i in range(a, b) if ch_soc[i]]
        if has_soc and not np.isnan(ascap[a:b]).all():
            e["ascap"] = [[int(ri[i])] + [_f(v, 1) for v in ascap[i]] for i in range(a, b) if ch_cap[i]]
        h = hm.loc[name]
        e["out"] = [_f(h["out"].get(k, np.nan), 1) for k in range(24)]
        e["bp"] = [_f(h["bp"].get(k, np.nan), 1) for k in range(24)]
        n_events += (len(st) + len(e["lim"]) + len(cv) + len(e.get("curve2", ())) + len(e.get("oschd", ())) + len(e["disp"])
                     + len(e.get("soc", ())) + len(e.get("ascap", ())))
        units[name] = e

    day = {"date": date, "format": UNIT_FORMAT, "runs": run_sort["minutes"].astype(int).tolist()}
    rep = np.flatnonzero(run_sort["repeat"].values).tolist()
    if rep:
        day["dst_repeat"] = rep
    day["units"] = dict(sorted(units.items()))
    return day, n_events


# ------------------------------------------------------------------ decoding --
def _ffill_index(events, n):
    """For each run 0..n-1, the index of the event in force (-1 before the first)."""
    at = np.array([ev[0] for ev in events], dtype=int)
    return np.searchsorted(at, np.arange(n), side="right") - 1


def expand(u: dict, n_runs: int) -> dict:
    """Per-run values of one unit: status (list), hsl, lsl, oschd, bp / hdl / ldl / asup / asdn
    when the file has "disp", soc / soc_min / soc_max and cap_<service> for storage from format
    7 (float arrays, NaN where unknown) and curve (list of (prices, MW) tuples or None).  Curve MW are in MW (fractions multiplied by that run's rounded HSL)."""
    si = _ffill_index(u["status"], n_runs)
    status = [u["status"][i][1] if i >= 0 else None for i in si]
    li = _ffill_index(u["lim"], n_runs)
    hsl = np.array([u["lim"][i][1] if i >= 0 and u["lim"][i][1] is not None else np.nan for i in li], float)
    lsl = np.array([u["lim"][i][2] if i >= 0 and u["lim"][i][2] is not None else np.nan for i in li], float)
    ci = _ffill_index(u["curve"], n_runs)
    curve = []
    for r, i in enumerate(ci):
        ev = u["curve"][i] if i >= 0 else None
        if ev is None or ev[1] is None:
            curve.append(None)
            continue
        m = np.array(ev[2], float)
        if u.get("frac"):
            m = m * (hsl[r] if not np.isnan(hsl[r]) else 0.0)
        curve.append((np.array(ev[1], float), m))
    res = {"status": status, "hsl": hsl, "lsl": lsl, "curve": curve}
    if u.get("disp"):
        di = _ffill_index(u["disp"], n_runs)
        for j, k in enumerate(("bp", "hdl", "ldl", "asup", "asdn", "mit_bp", "mit_max"), 1):
            res[k] = np.array([u["disp"][i][j] if i >= 0 and j < len(u["disp"][i]) and u["disp"][i][j] is not None
                               else np.nan for i in di], float)
    for key, names in (("soc", ("soc", "soc_min", "soc_max")), ("ascap", ("cap_regup", "cap_regdn", "cap_rrs", "cap_ecrs", "cap_nspin"))):
        if u.get(key):
            ki = _ffill_index(u[key], n_runs)
            for j, k in enumerate(names, 1):
                res[k] = np.array([u[key][i][j] if i >= 0 and j < len(u[key][i]) and u[key][i][j] is not None
                                   else np.nan for i in ki], float)
    if "oschd" in u:
        oi = _ffill_index(u["oschd"], n_runs)
        res["oschd"] = np.array([u["oschd"][i][1] if i >= 0 and u["oschd"][i][1] is not None else np.nan
                                 for i in oi], float)
    return res


# SCED dispatches a unit only between its LSL and HSL, so the part of an offer curve below LSL
# (minimum output) never decides anything.  The unit-level offer metrics below therefore read
# the submitted curve over the LSL-to-HSL range only: a curve that starts at 0 MW at -$250 and
# climbs to HSL puts MW "at or below $0" by interpolation, but all of it below LSL.
LSL_TOL = 0.5     # MW: a curve point this close below LSL counts as at LSL (rounding)


def le0_above_lsl(u: dict, n_runs: int) -> tuple:
    """Per run, for online runs (status starting "ON") with HSL > 0 and a submitted curve:
    MW offered at or below $0 above LSL, and the dispatchable range HSL - LSL (NaN otherwise).
    Same interpolation as the summary stats (curves.mw_at_prices, 0 MW below the first point),
    clipped to [0, HSL] before LSL is taken off."""
    si = _ffill_index(u["status"], n_runs)
    li = _ffill_index(u["lim"], n_runs)
    ci = _ffill_index(u["curve"], n_runs)
    mw, rng = np.full(n_runs, np.nan), np.full(n_runs, np.nan)
    cache = {}
    for r in range(n_runs):
        s = u["status"][si[r]][1] if si[r] >= 0 else None
        if not s or not s.startswith("ON") or li[r] < 0 or ci[r] < 0:
            continue
        key = (li[r], ci[r])
        if key not in cache:
            hsl, lsl = u["lim"][li[r]][1] or 0, u["lim"][li[r]][2] or 0
            ev = u["curve"][ci[r]]
            if hsl <= 0 or ev[1] is None:
                cache[key] = (np.nan, np.nan)
            else:
                m = np.array(ev[2], float) * (hsl if u.get("frac") else 1.0)
                mw0 = mw_at_prices(np.array([ev[1]], float), m[None, :], np.array([0.0]))[0, 0]
                cache[key] = (max(min(mw0, hsl) - lsl, 0.0), max(hsl - lsl, 0.0))
        mw[r], rng[r] = cache[key]
    return mw, rng


def le0_share(u: dict, n_runs: int) -> np.ndarray:
    """Per run: share of the dispatchable range (HSL - LSL) offered at or below $0 in the
    submitted curve (le0_above_lsl); NaN where the range is under 1 MW or the unit is not
    online with a curve."""
    mw, rng = le0_above_lsl(u, n_runs)
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(rng >= 1.0, mw / rng, np.nan)


def le20_sced_runs(u: dict, n_runs: int) -> np.ndarray:
    """Per run: MW at or below -$20 in the curve SCED dispatched against (SCED2 from format 6,
    else the submitted curve) for runs the unit is online with HSL > 0 (0 when it has no usable
    curve or HSL); NaN for runs it is not online.  Same evaluation as the technology series
    (curves.mw_at_prices, 0 MW below the first point, clipped to [0, HSL]), so the per-unit
    values sum to it."""
    si = _ffill_index(u["status"], n_runs)
    li = _ffill_index(u["lim"], n_runs)
    cv = u.get("curve2") or u["curve"]
    ci = _ffill_index(cv, n_runs)
    out, cache = np.full(n_runs, np.nan), {}
    for r in range(n_runs):
        s = u["status"][si[r]][1] if si[r] >= 0 else None
        if not (s and s.startswith("ON")):
            continue
        if li[r] < 0 or ci[r] < 0:
            out[r] = 0.0
            continue
        key = (li[r], ci[r])
        if key not in cache:
            hsl = u["lim"][li[r]][1] or 0
            ev = cv[ci[r]]
            if hsl <= 0 or ev[1] is None:
                cache[key] = 0.0
            else:
                m = np.array(ev[2], float) * (hsl if u.get("frac") else 1.0)
                mw = mw_at_prices(np.array([ev[1]], float), m[None, :], np.array([-20.0]))[0, 0]
                cache[key] = float(min(max(mw, 0.0), hsl))
        out[r] = cache[key]
    return out


def first_positive_price(u: dict, n_runs: int):
    """Mean over the day's online runs with a submitted curve of the price of the first curve
    point at or above LSL that is priced above $0: roughly where the unit starts pricing its
    dispatchable energy at cost, skipping minimum output (which SCED cannot back down) and
    other blocks priced at or below $0.  None if no run has such a point."""
    si = _ffill_index(u["status"], n_runs)
    li = _ffill_index(u["lim"], n_runs)
    ci = _ffill_index(u["curve"], n_runs)
    vals = []
    for r in range(n_runs):
        s = u["status"][si[r]][1] if si[r] >= 0 else None
        if not s or not s.startswith("ON") or ci[r] < 0:
            continue
        ev = u["curve"][ci[r]]
        if ev[1] is None:
            continue
        lsl = (u["lim"][li[r]][2] or 0) if li[r] >= 0 else 0
        hsl = (u["lim"][li[r]][1] or 0) if li[r] >= 0 else 0
        scale = hsl if u.get("frac") else 1.0
        pos = [p for p, m in zip(ev[1], ev[2]) if p > 0 and m * scale >= lsl - LSL_TOL]
        if pos:
            vals.append(pos[0])
    return round(float(np.mean(vals)), 2) if vals else None
