"""Thermal units' offer curves by hour, one file per 60-day operating day, for the Unit page's
"One day by hour" panel: the curve each unit submitted and the curve SCED dispatched against
(after ERCOT's extension to the unit's limits and mitigation), built from the per-unit day files
(pipeline/units.py), so it needs no downloads and fills in history on its first run.

Writes
  data/60d-curves/{date}.json.gz
    {
      "date": "YYYY-MM-DD",
      "format": FORMAT,
      "units": {
        "<Resource Name>": {
          "tech": "combined_cycle",
          "curves": [[[p1..pn], [mw1..mwn]], ...],   # each distinct curve of the day, once
          "sub":  [24 x index into curves, or -1],   # the submitted curve (SCED1)
          "used": [24 x index into curves, or -1],   # the curve SCED dispatched against (SCED2;
                                                     # -1 throughout on days before format 6)
          "lim":  [24 x [hsl, lsl] or null]          # mean limits over the hour's online runs (MW)
        }, ...
      }
    }
  An hour's curve is the one in force for the most of its online runs (ties to the later one);
  -1 where the unit is not online in any run of the hour or has no curve then.  Only thermal
  units (config.THERMAL_TECHS); wind, solar and storage would add about 240 KB a day.
"""
from collections import Counter

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz
from .units import _ffill_index, expand

FORMAT = 1
MAX_PER_RUN = 60      # days built per update run, newest first, so history fills in over a few runs
OUT_DIR = DATA_DIR / "60d-curves"
TECHS = ("coal", "combined_cycle", "gas_steam", "combustion_turbine", "nuclear")


def _hourly(events: list, on: np.ndarray, hr: np.ndarray, curves: list, key: dict) -> list:
    """Per hour: index into curves of the event in force for most online runs, or -1."""
    if not events:
        return [-1] * 24
    ei = _ffill_index(events, len(on))
    out = []
    for h in range(24):
        runs = np.flatnonzero((hr == h) & on)
        c = Counter(int(ei[r]) for r in runs if ei[r] >= 0 and events[ei[r]][1] is not None)
        if not c:
            out.append(-1)
            continue
        top = max(c.values())
        ev = events[max(i for i, n in c.items() if n == top)]
        k = (tuple(ev[1]), tuple(ev[2]))
        if k not in key:
            key[k] = len(curves)
            curves.append([list(ev[1]), list(ev[2])])
        out.append(key[k])
    return out


def unit_curves(u: dict, runs: list) -> dict | None:
    n = len(runs)
    e = expand(u, n)
    on = np.array([bool(s) and s.startswith("ON") for s in e["status"]])
    if not on.any():
        return None
    hr = np.minimum(np.array(runs, int) // 60, 23)
    curves, key = [], {}
    sub = _hourly(u.get("curve") or [], on, hr, curves, key)
    used = _hourly(u.get("curve2") or [], on, hr, curves, key)
    if not curves:
        return None
    lim = []
    for h in range(24):
        sel = (hr == h) & on
        if not sel.any() or not np.isfinite(e["hsl"][sel]).any():
            lim.append(None)
            continue
        lim.append([int(round(float(np.nanmean(e["hsl"][sel])))), int(round(float(np.nanmean(np.nan_to_num(e["lsl"][sel])))))])
    return {"tech": u["tech"], "curves": curves, "sub": sub, "used": used, "lim": lim}


def curve_day(ud: dict) -> dict:
    units = {}
    for name, u in sorted(ud["units"].items()):
        if u.get("tech") not in TECHS:
            continue
        c = unit_curves(u, ud["runs"])
        if c:
            units[name] = c
    return {"date": ud["date"], "format": FORMAT, "units": units}


def build_unit_curves(index: dict, limit: int = MAX_PER_RUN) -> None:
    """Write data/60d-curves/{date}.json.gz for every 60-day day that lacks it (or has an older
    format) and has a per-unit day file.  The page finds a day's file by trying to load it."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = skipped = 0
    for d in sorted(index["days"].get("60d", []), reverse=True):
        if done >= limit:
            break
        path = OUT_DIR / f"{d}.json.gz"
        cur = read_json_gz(path) if path.exists() else None
        if cur and cur.get("format") == FORMAT:
            continue
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not ud:
            skipped += 1
            continue
        write_json_gz(path, curve_day(ud))
        done += 1
    left = sum(1 for d in index["days"].get("60d", []) if not (OUT_DIR / f"{d}.json.gz").exists())
    print(f"unit curves: {done} day(s) written" + (f", {skipped} without a per-unit file" if skipped else "")
          + (f", {left} left for later runs" if left > skipped else ""))


if __name__ == "__main__":
    import json
    build_unit_curves(json.loads((DATA_DIR / "index.json").read_text()), limit=10_000)
