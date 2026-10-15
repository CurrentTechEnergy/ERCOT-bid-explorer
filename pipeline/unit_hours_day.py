"""Per-unit hourly rows for the Day page's Units table (its "Selected hour" view), one file per
60-day operating day, built from the per-unit day files (pipeline/units.py), so it needs no
downloads and fills in history on its first run.

Writes
  data/60d-units/{date}.json.gz
    {
      "date": "YYYY-MM-DD",
      "format": FORMAT,
      "columns": [...COLUMNS],          # the measures in each row, in this order
      "units": [[name, type, tech], ...],
      "rows": [[unit index, hour ending, ...one value per column], ...]
    }
  A row is written for each hour a unit is online in at least one SCED run.  Values are means
  over the unit's online runs in the hour unless noted:
    online_share    share of the hour's SCED runs with an online status (ON...)
    hsl, lsl        High / Low Sustained Limit (MW)
    base_point      SCED base point (MW)
    output          telemetered net output, hourly mean over the runs the unit is present in (MW)
    pinned_share    share of online runs with the base point at minimum output (as parse_60day)
    floor_mw        MW at or below -$249 in the curve SCED dispatched against (SCED2)
    le0_sced        MW at or below $0 in that curve
    le0_submitted   MW above LSL at or below $0 in the submitted curve (units.le0_above_lsl)
    min_sub_price   lowest price of the first submitted point at or above LSL (null without a curve)
    no_offer_share  share of online runs without a submitted curve
The daily Units table (the day file's "units" block, from parse_60day) reads the raw disclosure;
these rows read the per-unit file (curves of wind and solar as fractions of HSL to 0.01) and are
rounded to whole MW, shares to 0.01 and prices to $0.1.
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .curves import mw_at_prices
from .store import read_json_gz, write_json_gz
from .units import LSL_TOL, _ffill_index, expand

FORMAT = 1
MAX_PER_RUN = 60      # days built per update run, newest first (~10 s each), so history fills in
                      # over a few runs instead of slowing one down
OUT_DIR = DATA_DIR / "60d-units"
COLUMNS = ["online_share", "hsl", "lsl", "base_point", "output", "pinned_share", "floor_mw", "le0_sced",
           "le0_submitted", "min_sub_price", "no_offer_share"]
_GRID = np.array([-249.0, 0.0])


def _r(x, nd=0):
    """Rounded for the file (MW to whole MW, which keeps a day near 180 KB); None if missing."""
    if x is None or not np.isfinite(x):
        return None
    return int(round(float(x))) if nd == 0 else round(float(x), nd)


def _curve_at(u: dict, cv: list, on: np.ndarray, hsl: np.ndarray) -> np.ndarray:
    """Per run: MW at or below -$249 and $0 in curve list cv (unclipped), for online runs with a
    curve; 0 for online runs without one, NaN otherwise.  All runs are evaluated in one batch."""
    n = len(on)
    out = np.where(on[:, None], 0.0, np.nan) * np.ones((1, 2))
    if not cv:
        return out
    ci = _ffill_index(cv, n)
    runs = [r for r in range(n) if on[r] and ci[r] >= 0 and cv[ci[r]][1] is not None and np.isfinite(hsl[r])]
    if not runs:
        return out
    k = max(len(cv[ci[r]][1]) for r in runs)
    P, M = np.full((len(runs), k), np.nan), np.full((len(runs), k), np.nan)
    for i, r in enumerate(runs):
        ev = cv[ci[r]]
        P[i, :len(ev[1])] = ev[1]
        M[i, :len(ev[2])] = np.array(ev[2], float) * (hsl[r] if u.get("frac") else 1.0)
    out[runs] = mw_at_prices(P, M, _GRID, "first" if u["tech"] == "storage" else "zero")
    return out


def unit_rows(u: dict, runs: list) -> list:
    """[(hour ending, [values in COLUMNS order]), ...] for the hours the unit is online."""
    n = len(runs)
    e = expand(u, n)
    hr = np.minimum(np.array(runs, int) // 60, 23)
    on = np.array([bool(s) and s.startswith("ON") for s in e["status"]])
    if not on.any():
        return []
    hsl, lsl = np.nan_to_num(e["hsl"]), np.nan_to_num(e["lsl"])
    bp = e.get("bp")
    at = _curve_at(u, u.get("curve2") or u["curve"], on, e["hsl"])
    if u["tech"] == "storage":
        at = np.clip(at, lsl[:, None], hsl[:, None])
    else:
        at = np.minimum(np.maximum(at, 0.0), hsl[:, None])
    # MW above LSL at or below $0 in the submitted curve, evaluated as parse_60day does for the
    # daily Units table (0 without a curve; storage clipped to its charging-to-discharging range)
    sub = np.nan_to_num(_curve_at(u, u["curve"], on, e["hsl"])[:, 1])
    lo = lsl if u["tech"] == "storage" else 0.0
    le0_sub = np.where(on, np.maximum(np.clip(sub, lo, hsl) - lsl, 0.0), np.nan)
    # price of the first submitted point at or above LSL, per run
    first = np.full(n, np.nan)
    for r, c in enumerate(e["curve"]):
        if on[r] and c is not None:
            ok = c[1] >= lsl[r] - LSL_TOL
            if ok.any():
                first[r] = c[0][np.argmax(ok)]
    no_curve = np.array([c is None for c in e["curve"]])
    out_h = [np.nan if v is None else v for v in (u.get("out") or [None] * 24)]
    bp_h = [np.nan if v is None else v for v in (u.get("bp") or [None] * 24)]
    rows = []
    for h in range(24):
        idx = hr == h
        sel = idx & on
        if not sel.any():
            continue
        with np.errstate(invalid="ignore"):
            b = np.nanmean(bp[sel]) if bp is not None and np.isfinite(bp[sel]).any() else bp_h[h]
            pinned = np.nanmean([(lsl[r] > 0) and (bp is not None and bp[r] <= lsl[r] + max(1.0, 0.01 * lsl[r]))
                                 for r in np.flatnonzero(sel)]) if bp is not None else np.nan
            fp = first[sel]
            rows.append((h + 1, [
                _r(sel.sum() / idx.sum(), 2), _r(hsl[sel].mean()), _r(lsl[sel].mean()), _r(b), _r(out_h[h]),
                _r(pinned, 2), _r(at[sel, 0].mean()), _r(at[sel, 1].mean()),
                _r(np.nanmean(le0_sub[sel]) if np.isfinite(le0_sub[sel]).any() else np.nan),
                _r(np.nanmin(fp), 1) if np.isfinite(fp).any() else None,
                _r(no_curve[sel].mean(), 2),
            ]))
    return rows


def unit_hour_day(ud: dict) -> dict:
    units, rows = [], []
    for name, u in sorted(ud["units"].items()):
        rs = unit_rows(u, ud["runs"])
        if not rs:
            continue
        i = len(units)
        units.append([name, u.get("type"), u.get("tech")])
        rows.extend([i, he, *vals] for he, vals in rs)
    return {"date": ud["date"], "format": FORMAT, "columns": COLUMNS, "units": units, "rows": rows}


def build_unit_hour_days(index: dict) -> None:
    """Write data/60d-units/{date}.json.gz for every 60-day day that lacks it (or has an older
    format) and has a per-unit day file.  The page finds a day's file by trying to load it."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = skipped = 0
    for d in sorted(index["days"].get("60d", []), reverse=True):
        if done >= MAX_PER_RUN:
            break
        path = OUT_DIR / f"{d}.json.gz"
        cur = read_json_gz(path) if path.exists() else None
        if cur and cur.get("format") == FORMAT:
            continue
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not ud:
            skipped += 1
            continue
        write_json_gz(path, unit_hour_day(ud))
        done += 1
    left = sum(1 for d in index["days"].get("60d", []) if not (OUT_DIR / f"{d}.json.gz").exists())
    print(f"unit hours: {done} day(s) written" + (f", {skipped} without a per-unit file" if skipped else "")
          + (f", {left} left for later runs" if left > skipped else ""))
