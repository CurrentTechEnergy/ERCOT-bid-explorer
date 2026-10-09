"""60-Day DAM Disclosure (NP3-966-ER) -> one day file of every generation resource's day-ahead
three-part offer, awards and prices, plus a small daily summary by technology.

Only the generation resource file (60d_DAM_Gen_Resource_Data-*.csv) is read.  It has one row
per resource and hour with the QSE's submitted energy offer curve, start-up costs (hot,
intermediate, cold, $ per start), minimum-energy cost ($/MWh), limits, DAM resource status,
the energy award, the settlement point and its DAM price, and ancillary service awards with
the market clearing prices for capacity (MCPC).

Writes data/dam/{date}.json.gz:
{
  "date", "source": "dam",
  "hours": 24,                      # 23 / 25 on daylight-saving days: hours are stored in
                                    # file order after the hour-ending column
  "mcpc": {"regup": [24], "regdn": [24], "rrs": [24], "ecrs": [24], "nspin": [24]},
                                    # $/MW per hour, null where the file has no column
  "units": {
    "<Resource Name>": {
      "type": "CCGT90", "tech": "combined_cycle",
      "sp": "SETTLEMENT_POINT",     # the unit's settlement point (resource node)
      "status": "ON",               # DAM resource status (the day's most common value)
      "hsl": 540, "lsl": 320,       # daily median MW
      "start": [hot, inter, cold],  # $ per start, daily median (null = not offered)
      "start_var": true,            # only when a start cost changed during the day
      "mingen": 22.5,               # minimum-energy cost $/MWh, daily median (null = none)
      "mingen_var": true,           # only when it changed during the day
      "award": [24],                # DAM energy award MW per hour (null = no award row)
      "spp": [24],                  # DAM settlement point price at the unit's node, $/MWh
      "as": {"regup": [24], ...},   # AS awards MW per hour; only services with an award
      "curves": [[[p1..pn], [mw1..mwn]], ...],   # distinct submitted offer curves this day
      "curve": [24]                 # index into "curves" per hour, null = no offer that hour
    }, ...
  }
}
and a summary entry: per technology, awarded MW by hour, units with a three-part offer, and
quartiles of start-up costs and minimum-energy cost (for trend charts).
"""
import io
import re

import numpy as np
import pandas as pd

from .config import SIXTY_DAY_TECHS, TECH_OF_TYPE
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs

GEN_FILE = "60d_dam_gen_resource_data"
AS_SERVICES = {
    # key -> candidate normalised award column names (summed when several match)
    "regup": ["regupawarded"],
    "regdn": ["regdownawarded", "regdnawarded"],
    "rrs": ["rrspfrawarded", "rrsffrawarded", "rrsufrawarded", "rrsawarded"],
    "ecrs": ["ecrssdawarded", "ecrsmdawarded", "ecrsawarded"],
    "nspin": ["nonspinawarded", "nspinawarded"],
}
MCPC_COLS = {
    "regup": ["regupmcpc"], "regdn": ["regdownmcpc", "regdnmcpc"], "rrs": ["rrsmcpc"],
    "ecrs": ["ecrsmcpc"], "nspin": ["nonspinmcpc", "nspinmcpc"],
}
THERMAL = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine")


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _pick(norm: dict, *cands):
    for c in cands:
        if c in norm:
            return norm[c]
    return None


def _hour_ending(s: pd.Series) -> np.ndarray:
    """'1'..'24', '01:00'..'24:00' or '2026-10-01 01:00' style -> 1..24 (0 where unreadable)."""
    txt = s.astype(str).str.strip()
    m = txt.str.extract(r"(\d{1,2})(?::\d{2})?\s*$")[0]
    return pd.to_numeric(m, errors="coerce").fillna(0).astype(int).values


def _f(x, nd=2):
    return None if x is None or (isinstance(x, float) and not np.isfinite(x)) else round(float(x), nd)


def _median_or_none(a: np.ndarray, nd=2):
    a = a[np.isfinite(a)]
    return None if a.size == 0 else round(float(np.median(a)), nd)


def _series(vals: np.ndarray, hrs: np.ndarray, n_hours: int, nd=2):
    out = [None] * n_hours
    for v, h in zip(vals, hrs):
        if 1 <= h <= n_hours and np.isfinite(v):
            out[h - 1] = round(float(v), nd)
    return out


def read_dam_gen(csv_bytes: bytes) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(csv_bytes), low_memory=False)
    df.columns = [c.strip() for c in df.columns]
    return df


def parse_dam_frame(df: pd.DataFrame):
    norm = {_norm(c): c for c in df.columns}
    col = {
        "date": _pick(norm, "deliverydate"), "he": _pick(norm, "hourending"),
        "unit": _pick(norm, "resourcename"), "type": _pick(norm, "resourcetype"),
        "hot": _pick(norm, "startuphot"), "inter": _pick(norm, "startupinter", "startupintermediate"),
        "cold": _pick(norm, "startupcold"), "mingen": _pick(norm, "mingencost", "minimumenergycost"),
        "hsl": _pick(norm, "hsl"), "lsl": _pick(norm, "lsl"), "status": _pick(norm, "resourcestatus"),
        "award": _pick(norm, "awardedquantity", "energyaward"), "sp": _pick(norm, "settlementpointname", "settlementpoint"),
        "spp": _pick(norm, "energysettlementpointprice", "settlementpointprice"),
    }
    missing = [k for k in ("date", "he", "unit", "type") if col[k] is None]
    if missing:
        raise ValueError(f"DAM generation resource file lacks columns for {missing}; header: {list(df.columns)[:12]}")
    for k in ("hot", "inter", "cold", "mingen", "award", "spp", "sp", "status", "hsl", "lsl"):
        if col[k] is None:
            warn(f"DAM file: no column found for {k}")
    curve_mw, curve_pr = {}, {}
    for n, c in norm.items():
        m = re.fullmatch(r"qsesubmittedcurvemw(\d+)", n)
        if m:
            curve_mw[int(m.group(1))] = c
        m = re.fullmatch(r"qsesubmittedcurveprice(\d+)", n)
        if m:
            curve_pr[int(m.group(1))] = c
    pts = sorted(set(curve_mw) & set(curve_pr))
    if not pts:
        warn("DAM file: no submitted energy offer curve columns found")
    as_cols = {k: [norm[c] for c in cands if c in norm] for k, cands in AS_SERVICES.items()}
    mcpc_cols = {k: _pick(norm, *cands) for k, cands in MCPC_COLS.items()}
    known_as = {c for cs in as_cols.values() for c in cs} | {c for c in mcpc_cols.values() if c} | {col["award"]}
    unknown_as = [c for n, c in norm.items() if ("awarded" in n or "mcpc" in n) and c not in known_as]
    if unknown_as:
        warn(f"DAM file: ancillary service columns not read: {unknown_as}")

    dates = to_iso_date(df[col["date"]])
    date = dates.value_counts().idxmax()
    if (dates != date).any():
        warn(f"DAM file for {date} also carries rows for {sorted(set(dates[dates != date]))[:3]}; they are dropped")
        df = df[dates == date]
    he = _hour_ending(df[col["he"]])
    n_hours = int(max(24, he.max())) if len(he) else 24
    if (he == 0).any():
        warn(f"DAM {date}: {(he == 0).sum()} rows with an unreadable hour ending were dropped")
        df, he = df[he > 0], he[he > 0]

    def num(k):
        return df[col[k]].astype(float).values if col[k] else np.full(len(df), np.nan)

    names = df[col["unit"]].astype(str).str.strip().values
    rtype = df[col["type"]].astype(str).str.strip().values
    hot, inter, cold, mingen = num("hot"), num("inter"), num("cold"), num("mingen")
    hsl, lsl, award, spp = num("hsl"), num("lsl"), num("award"), num("spp")
    status = df[col["status"]].fillna("").astype(str).str.strip().values if col["status"] else np.full(len(df), "")
    sp = df[col["sp"]].fillna("").astype(str).str.strip().values if col["sp"] else np.full(len(df), "")
    cp = df[[curve_pr[i] for i in pts]].astype(float).values if pts else np.zeros((len(df), 0))
    cm = df[[curve_mw[i] for i in pts]].astype(float).values if pts else np.zeros((len(df), 0))
    as_mw = {k: (df[cs].astype(float).fillna(0).sum(axis=1).values if cs else None) for k, cs in as_cols.items()}

    mcpc = {}
    for k, c in mcpc_cols.items():
        mcpc[k] = _series(df[c].astype(float).values, he, n_hours) if c else [None] * n_hours

    order = np.lexsort((he, names))
    units, unknown_types = {}, set()
    tech_rows = []
    i = 0
    while i < len(order):
        j = i
        name = names[order[i]]
        while j < len(order) and names[order[j]] == name:
            j += 1
        idx = order[i:j]
        i = j
        t = TECH_OF_TYPE.get(rtype[idx[0]])
        if t is None:
            unknown_types.add(rtype[idx[0]])
            t = "other"
        h = he[idx]
        start = [_median_or_none(hot[idx]), _median_or_none(inter[idx]), _median_or_none(cold[idx])]
        u = {"type": rtype[idx[0]], "tech": t, "sp": sp[idx[0]],
             "hsl": _median_or_none(hsl[idx], 1), "lsl": _median_or_none(lsl[idx], 1),
             "start": start, "mingen": _median_or_none(mingen[idx])}
        st = [s for s in status[idx] if s]
        u["status"] = max(set(st), key=st.count) if st else ""
        if any(np.nanmax(a[idx]) - np.nanmin(a[idx]) > 0.005 * max(1.0, abs(np.nanmax(a[idx])))
               for a in (hot, inter, cold) if np.isfinite(a[idx]).any()):
            u["start_var"] = True
        if np.isfinite(mingen[idx]).any() and np.nanmax(mingen[idx]) - np.nanmin(mingen[idx]) > 0.01:
            u["mingen_var"] = True
        u["award"] = _series(award[idx], h, n_hours, 1)
        u["spp"] = _series(spp[idx], h, n_hours)
        as_out = {}
        for k, a in as_mw.items():
            if a is not None and (a[idx] > 0).any():
                as_out[k] = _series(a[idx], h, n_hours, 1)
        if as_out:
            u["as"] = as_out
        curves, cidx, seen = [], [None] * n_hours, {}
        for r, hh in zip(idx, h):
            p, m = cp[r], cm[r]
            ok = np.isfinite(p) & np.isfinite(m)
            if not ok.any() or not (1 <= hh <= n_hours):
                continue
            key = tuple(np.round(p[ok], 2)) + ("|",) + tuple(np.round(m[ok], 1))
            if key not in seen:
                seen[key] = len(curves)
                curves.append([[round(float(x), 2) for x in p[ok]], [round(float(x), 1) for x in m[ok]]])
            cidx[hh - 1] = seen[key]
        if curves:
            u["curves"], u["curve"] = curves, cidx
        units[name] = u
        tech_rows.append((t, u, idx))
    if unknown_types:
        warn(f"DAM {date}: resource types grouped as 'other': {sorted(unknown_types)}")

    day = {"date": date, "source": "dam", "hours": n_hours, "mcpc": mcpc, "units": units}
    summary = _summary(tech_rows, award, n_hours, he)
    return date, day, summary


def _summary(tech_rows, award, n_hours, he):
    """Per technology: awarded MW by hour, units, units with a three-part offer, and
    [p25, median, p75] of hot / intermediate / cold start cost and minimum-energy cost."""
    out = {}
    for t in SIXTY_DAY_TECHS:
        rows = [(u, idx) for tt, u, idx in tech_rows if tt == t]
        aw = np.zeros(n_hours)
        for u, idx in rows:
            a = award[idx]
            h = he[idx]
            for v, hh in zip(a, h):
                if np.isfinite(v) and 1 <= hh <= n_hours:
                    aw[hh - 1] += v
        with_offer = [u for u, _ in rows if u["mingen"] is not None]

        def q(vals):
            v = np.array([x for x in vals if x is not None], float)
            return None if v.size == 0 else [round(float(np.percentile(v, p)), 1) for p in (25, 50, 75)]

        out[t] = {
            "award": [round(float(x)) for x in aw],
            "n": len(rows), "n_offer": len(with_offer),
            "start_hot": q(u["start"][0] for u in with_offer),
            "start_inter": q(u["start"][1] for u in with_offer),
            "start_cold": q(u["start"][2] for u in with_offer),
            "mingen": q(u["mingen"] for u in with_offer),
        }
    return out


def has_dam_gen(names) -> bool:
    return any(n.lower().startswith(GEN_FILE) for n in names)


def parse_dam_zip(blob: bytes):
    """-> (date, day file, summary entry)"""
    frames = []
    for name, data in iter_csvs(blob, "x.zip"):
        if name.lower().startswith(GEN_FILE):
            frames.append(read_dam_gen(data))
    if not frames:
        raise ValueError("No DAM generation resource file in the 60-day DAM zip")
    return parse_dam_frame(pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0])
