"""Thermal dispatch stack from the units actually online: for each hour of a 60-day day, the MW
the thermal units online in that hour offered at or below each price, by timescale group and by
technology.  Read by the Real-time offers page; the page draws it and computes nothing.  Replaces
the forecast's expected stack (pipeline/forecast/stack.py, removed with the forecasts in #202).

From the per-unit day file (pipeline/units.py), for every SCED run a thermal unit is online
(status "ON..."), its SCED2 curve (what SCED dispatched against; the submitted curve before
format 6) evaluated on PRICES the way parse_60day evaluates curves (0 MW below the first point,
clipped to [0, HSL]), then raised to its LSL, since SCED cannot take it below that:

  mw(P) = clamp(curve(P), LSL, HSL)       a unit with a curve
        = its hourly mean output          a unit online without one (runs whatever the price)

averaged over each hour's runs.  So at the bottom of the grid the stack is the minimum output
online, and at the top it is the online maximum.

data/stack/<date>.json.gz
  date, format
  prices        the price grid ($/MWh)
  groups, techs the keys below, in display order
  group[g] / tech[t]: {mw: [24][len(prices)], min: [24], max: [24], n: [24] units online}
  fleet         {mw, min, max, n} for all thermal units online
Days are written once (all of them again when FORMAT changes) and pruned with the 60-day data.  Groups are
groups_60d.json.gz's (by train); nuclear, which groups.py leaves out, counts as "never".
"""
import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .curves import mw_at_prices
from .groups import train_of
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

OUT_DIR = DATA_DIR / "stack"
FORMAT = 1
PRICES = np.concatenate([
    [-250, -100, -75, -50, -40, -30, -25, -20, -15, -10, -5],
    np.arange(0, 100, 2.5),
    np.arange(100, 200, 10),
    [200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000],
]).astype(float)
TECHS = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"]
GROUPS = ["never", "seasonal", "multiday", "daily1", "daily2", "daily3", "never_on", "ungrouped"]


def _r(a, nd=1):
    return [None if not np.isfinite(v) else round(float(v), nd) for v in np.ravel(a)]


def day_stack(ud: dict, group_of: dict) -> dict:
    n = len(ud["runs"])
    hr = np.minimum(np.array(ud["runs"], int) // 60, 23)
    n_hr = np.bincount(hr, minlength=24).astype(float)
    G = PRICES.size
    acc = {("group", g): [np.zeros((24, G)), np.zeros(24), np.zeros(24), np.zeros(24)] for g in GROUPS}
    acc.update({("tech", t): [np.zeros((24, G)), np.zeros(24), np.zeros(24), np.zeros(24)] for t in TECHS})
    for name, u in ud["units"].items():
        if u["tech"] not in TECHS:
            continue
        si = _ffill_index(u["status"], n)
        online = np.array([si[r] >= 0 and bool(u["status"][si[r]][1]) and u["status"][si[r]][1].startswith("ON")
                           for r in range(n)])
        if not online.any():
            continue
        li = _ffill_index(u["lim"], n)
        hsl = np.array([float(u["lim"][i][1] or 0.0) if i >= 0 else 0.0 for i in li])
        lsl = np.array([float(u["lim"][i][2] or 0.0) if i >= 0 else 0.0 for i in li])
        cv = u.get("curve2") or u.get("curve") or []
        ci = _ffill_index(cv, n) if cv else np.full(n, -1)
        rows = np.zeros((n, G))
        has = np.array([ci[r] >= 0 and cv[ci[r]][1] is not None for r in range(n)])
        idx = np.where(online & has)[0]
        if idx.size:
            # one evaluation per distinct (curve, limits) pair in force while online
            combo = ci[idx] * (len(u["lim"]) + 1) + li[idx] + 1
            codes, inv = np.unique(combo, return_inverse=True)
            k = max(len(cv[c // (len(u["lim"]) + 1)][1]) for c in codes)
            P, M = np.full((len(codes), k), np.nan), np.full((len(codes), k), np.nan)
            for j, c in enumerate(codes):
                ev = cv[c // (len(u["lim"]) + 1)]
                r0 = idx[np.argmax(inv == j)]
                P[j, :len(ev[1])] = ev[1]
                M[j, :len(ev[2])] = np.array(ev[2], float) * (hsl[r0] if u.get("frac") else 1.0)
            rows[idx] = np.clip(mw_at_prices(P, M, PRICES, "zero")[inv], lsl[idx][:, None], np.maximum(hsl[idx], lsl[idx])[:, None])
        out = u.get("out") or [None] * 24
        flat = np.array([out[h] or 0.0 for h in hr])         # a unit without a curve: its output
        rows[online & ~has] = flat[online & ~has][:, None]
        lo_r, hi_r = np.where(has, lsl, flat), np.where(has, np.maximum(hsl, lsl), flat)
        w = np.zeros((24, n))
        w[hr[online], np.where(online)[0]] = 1.0
        mw, mn, mx, cnt = w @ rows, w @ lo_r, w @ hi_r, (w.sum(1) > 0).astype(float)
        g = group_of.get(name) or group_of.get(train_of(name)) or ("never" if u["tech"] == "nuclear" else "ungrouped")
        for key in (("group", g if g in GROUPS else "ungrouped"), ("tech", u["tech"])):
            a = acc[key]
            a[0] += mw; a[1] += mn; a[2] += mx; a[3] += cnt
    div = np.where(n_hr > 0, n_hr, np.nan)
    blk = lambda a: {"mw": [_r(row) for row in a[0] / div[:, None]], "min": _r(a[1] / div), "max": _r(a[2] / div), "n": [int(v) for v in a[3]]}
    fleet = [sum(acc[("tech", t)][i] for t in TECHS) for i in range(4)]
    return {"date": ud.get("date"), "format": FORMAT, "prices": PRICES.tolist(), "groups": GROUPS, "techs": TECHS,
            "group": {g: blk(acc[("group", g)]) for g in GROUPS}, "tech": {t: blk(acc[("tech", t)]) for t in TECHS},
            "fleet": blk(fleet)}


def build_actual_stack(index: dict) -> int:
    days = sorted(index["days"].get("60d", []))
    gr = read_json_gz(DATA_DIR / "groups_60d.json.gz", default={}) or {}
    group_of = {k: v[1] for k, v in (gr.get("units") or {}).items()}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    keep = set(days)
    for p in OUT_DIR.glob("*.json.gz"):
        if p.name[:10] not in keep:
            p.unlink()
    done = 0
    for d in days:
        path = OUT_DIR / f"{d}.json.gz"
        old = read_json_gz(path, default=None) if path.exists() else None
        if old and old.get("format") == FORMAT:
            continue
        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz", default=None)
        if not ud:
            continue
        write_json_gz(path, day_stack(ud, group_of))
        done += 1
    have = sorted(p.name[:10] for p in OUT_DIR.glob("*.json.gz"))
    write_json_gz(DATA_DIR / "stack_index.json.gz", {"format": FORMAT, "days": have})
    print(f"actual stack: {done} day(s) built, {len(have)} on hand", flush=True)
    return done
