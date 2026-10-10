"""Per-unit day files: every unit's status, limits and submitted offer curve at every SCED
run of one operating day, stored as change-of-value (COV) events.

Written by parse_60day for each 60-day disclosure day to
    {UNIT_DATA_DIR}/60d/{date}.json.gz
(UNIT_DATA_DIR from config; in GitHub Actions a checkout of the orphan `data` branch).

Schema
------
{
  "date": "YYYY-MM-DD",
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
      "out": [24 x hourly mean Telemetered Net Output, 0.1 MW, or null],
      "bp":  [24 x hourly mean Base Point, 0.1 MW, or null]
                              # hourly means over the runs the unit is present in, any status
    }, ...
  },
  "overrides_format": 2, # version of the override parsing below (reprocess redoes older files)
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
    oschd = None if rows.get("oschd") is None else np.round(take("oschd").astype(float), 1)
    P, M = take("tpo_p").astype(float), take("tpo_m").astype(float)
    valid = ~np.isnan(P) & ~np.isnan(M)
    P = np.where(valid, np.round(P, 2), np.nan)
    frac = np.isin(tech, FRAC_TECHS)
    with np.errstate(invalid="ignore", divide="ignore"):
        Mf = np.where(hsl_raw[:, None] > 0, M / hsl_raw[:, None], 0.0)
    M = np.where(valid, np.where(frac[:, None], np.round(Mf, 2), np.round(M, 1)), np.nan)

    first = np.r_[True, unit[1:] != unit[:-1]]
    gap = np.r_[False, (ri[1:] != ri[:-1] + 1) & ~first[1:]]   # unit was absent just before
    st_obj = status.astype(object)
    ch_status = first | gap | np.r_[True, st_obj[1:] != st_obj[:-1]]
    ch_lim = _changed(np.column_stack([hsl, lsl]), first)
    ch_curve = _changed(np.hstack([P, M]), first)
    ch_os = _changed(oschd, first) if oschd is not None else None

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
        if ch_os is not None:
            e["oschd"] = [[int(ri[i]), _f(oschd[i], 1)] for i in range(a, b) if ch_os[i]]
        h = hm.loc[name]
        e["out"] = [_f(h["out"].get(k, np.nan), 1) for k in range(24)]
        e["bp"] = [_f(h["bp"].get(k, np.nan), 1) for k in range(24)]
        n_events += len(st) + len(e["lim"]) + len(cv) + len(e.get("oschd", ()))
        units[name] = e

    day = {"date": date, "runs": run_sort["minutes"].astype(int).tolist()}
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
    """Per-run values of one unit: status (list), hsl, lsl, oschd (float arrays, NaN where
    unknown) and curve (list of (prices, MW) tuples or None).  Curve MW are in MW (fractions
    multiplied by that run's rounded HSL)."""
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
    if "oschd" in u:
        oi = _ffill_index(u["oschd"], n_runs)
        res["oschd"] = np.array([u["oschd"][i][1] if i >= 0 and u["oschd"][i][1] is not None else np.nan
                                 for i in oi], float)
    return res


def le0_share(u: dict, n_runs: int) -> np.ndarray:
    """Per run: share of HSL offered at or below $0 in the submitted curve, for online runs
    (status starting "ON") with HSL > 0 and a curve; NaN otherwise.  Same interpolation as the
    summary stats (curves.mw_at_prices, 0 MW below the first point), clipped to [0, HSL]."""
    si = _ffill_index(u["status"], n_runs)
    li = _ffill_index(u["lim"], n_runs)
    ci = _ffill_index(u["curve"], n_runs)
    out = np.full(n_runs, np.nan)
    cache = {}
    for r in range(n_runs):
        s = u["status"][si[r]][1] if si[r] >= 0 else None
        if not s or not s.startswith("ON") or li[r] < 0 or ci[r] < 0:
            continue
        key = (li[r], ci[r])
        if key not in cache:
            hsl = u["lim"][li[r]][1] or 0
            ev = u["curve"][ci[r]]
            if hsl <= 0 or ev[1] is None:
                cache[key] = np.nan
            else:
                m = np.array(ev[2], float) * (hsl if u.get("frac") else 1.0)
                mw0 = mw_at_prices(np.array([ev[1]], float), m[None, :], np.array([0.0]))[0, 0]
                cache[key] = min(max(mw0, 0.0), hsl) / hsl
        out[r] = cache[key]
    return out


def first_positive_price(u: dict, n_runs: int):
    """Mean over the day's online runs with a submitted curve of the first price above $0 on
    that curve: roughly where the unit starts pricing its energy at cost, skipping minimum
    output and other blocks priced at or below $0.  None if no run has a price above $0."""
    si = _ffill_index(u["status"], n_runs)
    ci = _ffill_index(u["curve"], n_runs)
    vals = []
    for r in range(n_runs):
        s = u["status"][si[r]][1] if si[r] >= 0 else None
        if not s or not s.startswith("ON") or ci[r] < 0:
            continue
        ev = u["curve"][ci[r]]
        if ev[1] is None:
            continue
        pos = [p for p in ev[1] if p > 0]
        if pos:
            vals.append(pos[0])
    return round(float(np.mean(vals)), 2) if vals else None
