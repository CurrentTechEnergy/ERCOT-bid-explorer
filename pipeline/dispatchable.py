"""Dispatchable offer curves: each technology's hourly curves with every unit's minimum output
(LSL) taken out, so they show only the MW SCED can actually move by price.

SCED dispatches a unit between its LSL and HSL.  The part of its offer curve below LSL (ERCOT
fills it at -$20/-$50 in the curve it dispatches against; many submitted curves start at 0 MW at
-$250) is minimum output: it runs however low the price goes and never sets the price.  The
"curves" and "submitted" blocks of a 60-day day file sum the whole curves, so around -$20 they
carry a step of ~10-15 GW that cannot respond.  The "dispatchable" block built here holds the
same two curves with each online unit's LSL subtracted (MW above LSL offered at or below each
price, clipped at 0).  Storage is left as it is: its whole charging-to-discharging range is
dispatchable.  Units with no offer curve contribute nothing, as in the main curves.

parse_60day writes the block for new days from the raw disclosure rows.  build_dispatchable fills
it in for days already in data/ from their per-unit day files (pipeline/units.py, format 6 and
later, which carry the SCED2 curve), so history needs no re-download.  The Day page's marginal
charts, the Trends marginal-supply-by-settled-price chart (pipeline/marginal.py) and the thermal
offer-price quantiles (pipeline/curve_trends.py) read it where a day has it.
"""
import numpy as np

from .config import DATA_DIR, PRICE_GRID, SIXTY_DAY_TECHS, UNIT_DATA_DIR
from .curves import mw_at_prices
from .store import read_json_gz, write_json_gz, _round
from .units import _ffill_index

TECH_INDEX = {t: i for i, t in enumerate(SIXTY_DAY_TECHS)}
KEYS = {"curves": "curve2", "submitted": "curve"}     # day-file block -> per-unit curve list
# the block is written for the technologies where it differs from the main curves: wind and
# solar have no minimum output to speak of and storage is left whole, so the site reads the
# main curve for any technology the block leaves out
DISP_TECHS = [t for t in SIXTY_DAY_TECHS if t not in ("wind", "solar", "storage")]


def block_from_arrays(curves: dict) -> dict:
    """{"curves": (T, 24, G), "submitted": (T, 24, G)} -> the day file's "dispatchable" block."""
    return {k: {t: [_round(row) for row in v[TECH_INDEX[t]]] for t in DISP_TECHS} for k, v in curves.items()}


def above_lsl(mw: np.ndarray, lsl: np.ndarray, is_esr) -> np.ndarray:
    """Curve MW (rows x grid, already clipped to the unit's limits) with LSL taken out: MW above
    LSL at or below each price.  Storage rows (is_esr, scalar or per row) are left unchanged."""
    out = np.maximum(mw - np.asarray(lsl, float)[:, None], 0.0)
    return np.where(np.asarray(is_esr, bool)[:, None] if np.ndim(is_esr) else is_esr, mw, out)


def _unit_rows(u: dict, evs: list, hsl: np.ndarray, lsl: np.ndarray, subtract: bool) -> np.ndarray:
    """A unit's curves on the price grid, one row per (curve event, limits) combination, evaluated
    as parse_60day does: 0 MW below the first point, clipped to [0, HSL] (storage: the first
    point's MW below it, clipped to [LSL, HSL], so a storage unit with no curve sits at its
    charging LSL), then LSL taken out unless storage or not `subtract`."""
    esr = u["tech"] == "storage"
    k = max((len(ev[1]) for ev in evs if ev is not None and ev[1] is not None), default=1)
    P, M = np.full((len(evs), k), np.nan), np.full((len(evs), k), np.nan)
    for i, ev in enumerate(evs):
        if ev is not None and ev[1] is not None:
            P[i, :len(ev[1])] = ev[1]
            M[i, :len(ev[2])] = np.array(ev[2], float) * (hsl[i] if u.get("frac") else 1.0)
    rows = mw_at_prices(P, M, PRICE_GRID, "first" if esr else "zero")
    if esr:
        return np.clip(rows, lsl[:, None], hsl[:, None])
    rows = np.minimum(np.maximum(rows, 0.0), hsl[:, None])
    return np.maximum(rows - lsl[:, None], 0.0) if subtract else rows


def tech_curves(ud: dict, subtract: bool = True) -> dict:
    """{"curves": (T, 24, G), "submitted": (T, 24, G)} technology curves from a per-unit day file:
    the sum over online units, averaged over each hour's SCED runs (NaN in hours with no run).
    With subtract=False this reproduces the day file's own "curves"/"submitted" blocks (to within
    the per-unit file's rounding), which is how the builder is checked."""
    n = len(ud["runs"])
    hr = np.minimum(np.array(ud["runs"], int) // 60, 23)
    n_hr = np.bincount(hr, minlength=24).astype(float)
    T, G = len(SIXTY_DAY_TECHS), PRICE_GRID.size
    acc = {k: np.zeros((T, 24, G)) for k in KEYS}
    for u in ud["units"].values():
        si = _ffill_index(u["status"], n)
        online = np.array([si[r] >= 0 and bool(u["status"][si[r]][1]) and u["status"][si[r]][1].startswith("ON")
                           for r in range(n)])
        if not online.any():
            continue
        ti = TECH_INDEX.get(u["tech"], TECH_INDEX["other"])
        li = _ffill_index(u["lim"], n)
        for key, cname in KEYS.items():
            cv = u.get(cname) or (u["curve"] if cname == "curve2" else None)
            if not cv:
                continue
            ci = _ffill_index(cv, n)
            # one row per distinct (limits, curve) pair the unit had while online, weighted by
            # how many of each hour's runs it was in force
            combo = np.where(online, li * (len(cv) + 1) + ci + 1, -1)
            codes, inv = np.unique(combo[online], return_inverse=True)
            i_l, i_c = np.divmod(codes, len(cv) + 1)
            i_c = i_c - 1
            hsl = np.array([float(u["lim"][i][1] or 0.0) if i >= 0 else 0.0 for i in i_l])
            lsl = np.array([float(u["lim"][i][2] or 0.0) if i >= 0 else 0.0 for i in i_l])
            rows = _unit_rows(u, [cv[i] if i >= 0 else None for i in i_c], hsl, lsl, subtract)
            weight = np.zeros((len(codes), 24))
            np.add.at(weight, (inv, hr[online]), 1.0)
            acc[key][ti] += weight.T @ rows
    with np.errstate(invalid="ignore", divide="ignore"):
        return {k: v / np.where(n_hr > 0, n_hr, np.nan)[None, :, None] for k, v in acc.items()}


def dispatchable_block(ud: dict) -> dict:
    return block_from_arrays(tech_curves(ud, subtract=True))


def build_dispatchable(index: dict) -> None:
    """Add the "dispatchable" block to every 60-day day file that lacks it and has a per-unit
    day file with the SCED2 curve (format 6+)."""
    done = skipped = 0
    for d in sorted(index["days"].get("60d", [])):
        path = DATA_DIR / "60d" / f"{d}.json.gz"
        day = read_json_gz(path)
        if not day or "dispatchable" in day:
            continue
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not ud or (ud.get("format") or 0) < 6:
            skipped += 1
            continue
        day["dispatchable"] = dispatchable_block(ud)
        write_json_gz(path, day)
        done += 1
    print(f"dispatchable curves: {done} day(s) filled from per-unit files"
          + (f", {skipped} without a usable per-unit file" if skipped else ""))
