"""PPA guesser: what each wind and solar unit's real-time offers reveal about its hedge.  Needs no
downloads beyond the DA hub prices (pipeline/dam_prices.py).

A plant hedged on a contract for differences settled on day-ahead prices for the energy it
actually generates earns, per MWh, roughly

    RT node price + share x (strike - DA price at the settlement point) + any per-MWh credit

so it should run only when the RT price is above share x DA - (share x strike + credit), and a
QSE that bids the contract offers exactly that.  The offer then moves hour by hour with the DA
price at the settlement point, with slope = share and intercept = -(share x strike + credit).
Outpost Solar during Winter Storm Fern is the worked case: 0.84 x DA(HB_SOUTH) - $64.28 in every
repriced hour.

Method, per unit:
  1. Hourly offer: the median over the hour's SCED runs of the submitted curve's price at half
     its MW (wind and solar curves are usually one price).  Only hours with HSL >= 2 MW, and
     only hours where the offer did not move within the hour (a DA-based price is hourly).
  2. Formula days: days with at least 4 such hours at 4 or more distinct prices, after
     dropping hours at the unit's usual floor offer or at $0, and the day's lowest and highest
     price when either repeats (a floor or cap the formula is clamped to).
  3. For every candidate settlement point (the unit's own node DA price, every hub and load
     zone), fit offer = a x DA + b on each formula day; the point's (a, b) is the median over
     days, and its hit rate is the share of formula-day hours that (a, b) predicts within
     HIT_USD.  The best point has the highest hit rate.
  4. Tier:
       revealed          >= 3 formula days, >= 24 hours, hit >= 0.8, 0.2 <= a <= 1.3, and the
                         next point's hit rate at least 0.1 lower
       location unclear  the same, but other points fit about as well (node and hub price alike)
       partial           >= 2 formula days, hit >= 0.5, 0.2 <= a <= 1.3
       hints only        everything else: floor offer and day-ahead habit only
  Every unit also gets its usual floor offer and its day-ahead habit (DAM award as a share of
  its real-time base point energy, and the share of days with any award).

Inferred strike: -b / a if the intercept is all strike; (-b - CREDIT) / a if the operator also
counts a per-MWh credit worth CREDIT (the PTC is about $30/MWh) in its break-even.  Neither the
share nor the strike is a disclosed term: the slope is the share of the bidder's exposure tied
to that DA price, which can differ from the contracted share (offers can track 100% of a hub
while only part of the output is contracted).

Per-day hourly offers are cached in UNIT_DATA_DIR/ppa/{date}.json.gz (rebuilt when the per-unit
day file or this module's CACHE_FORMAT changes).

Writes data/ppa.json.gz:
  updated, hit_usd, credit, points (candidate settlement points), n_days (60-day days scanned),
  first, last (date range scanned), tiers {tier: label}
  units: [{name, tech, sp, tier, floor, da_share, da_days, avail_days,
           and when a formula was found: point, a, b, hit, alt [[point, hit], ...] (next best),
           near [points within 0.1 of the best hit rate], days (formula days), hours, first,
           last, strike_hi, strike_lo, group (units sharing point, a and b),
           daily [[date, a, b, rmse, hours], ...]}]
  fits: {name: [[date index, DA price at the best point, offer], ...]}   (revealed / partial)
  dates: the dates the fit date indices refer to
"""
import datetime as dt
from collections import Counter

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .dam_prices import load as load_dam_prices
from .intraday import _online
from .nodes import hourly_hsl
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

CACHE_FORMAT = 1
TECHS = ("wind", "solar")
MIN_HSL = 2.0          # MW: hours with less available output are ignored
FLAT_USD = 0.5         # an hour counts only if its offer moved less than this within the hour
HIT_USD = 2.0          # a formula "hits" an hour when it predicts the offer within this
CREDIT = 30.0          # $/MWh: about the PTC, for the lower strike estimate
SLOPE = (0.2, 1.3)
MAX_FIT_POINTS = 800   # per unit in the output, for the scatter chart
TIERS = {"revealed": "Revealed", "unclear": "Revealed, location unclear", "partial": "Partial",
         "hints": "Hints only"}


def _r(x, nd=2):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _mid_price(p, mw) -> float:
    """Price at half the curve's MW (its single price for a one-price curve)."""
    p = np.asarray(p, float)
    mw = np.asarray(mw, float)
    top = mw.max() if len(mw) else np.nan
    if not np.isfinite(top) or top <= 0 or np.any(np.diff(mw) < 0):
        return float(np.median(p)) if len(p) else np.nan
    return float(np.interp(0.5 * top, mw, p))


def hourly_offers(ud: dict) -> dict:
    """{unit: {tech, offer [24], spread [24], hsl [24], bp [24]}} for wind and solar units."""
    runs = ud["runs"]
    n = len(runs)
    hr = np.minimum(np.array(runs) // 60, 23)
    out = {}
    for name, u in ud["units"].items():
        if u.get("tech") not in TECHS:
            continue
        si = _ffill_index(u["status"], n)
        ci = _ffill_index(u.get("curve") or [], n)
        cache, pr = {}, np.full(n, np.nan)
        for r in range(n):
            i, s = ci[r], si[r]
            if i < 0 or s < 0 or not _online(u["status"][s][1]):
                continue
            ev = u["curve"][i]
            if ev[1] is None:
                continue
            if i not in cache:
                cache[i] = _mid_price(ev[1], ev[2])
            pr[r] = cache[i]
        off, spread = [None] * 24, [None] * 24
        for h in range(24):
            v = pr[hr == h]
            v = v[np.isfinite(v)]
            if len(v):
                off[h], spread[h] = _r(np.median(v)), _r(v.max() - v.min())
        out[name] = {"tech": u["tech"], "offer": off, "spread": spread,
                     "hsl": [_r(v, 1) for v in hourly_hsl(u, runs)], "bp": u.get("bp") or [None] * 24}
    return out


def _src_key(src) -> int:
    return src.stat().st_size if src.exists() else 0


def day_offers(date: str) -> dict:
    """Cached hourly_offers for one 60-day day, or {} when there is no per-unit day file.  The
    cache is keyed on the per-unit file's size (a reprocessed day file changes it; checkout
    times would change a modification time)."""
    path = UNIT_DATA_DIR / "ppa" / f"{date}.json.gz"
    src = UNIT_DATA_DIR / "60d" / f"{date}.json.gz"
    cached = read_json_gz(path)
    if cached and cached.get("format") == CACHE_FORMAT and cached.get("src_size") == _src_key(src):
        return cached["units"]
    ud = read_json_gz(src)
    if not ud:
        return {}
    units = hourly_offers(ud)
    write_json_gz(path, {"date": date, "format": CACHE_FORMAT, "src_size": _src_key(src), "units": units})
    return units


def fill_cache(dates) -> None:
    """Build missing day caches in parallel (the first run reads every per-unit day file)."""
    from concurrent.futures import ProcessPoolExecutor
    import os

    def stale(d):
        c = read_json_gz(UNIT_DATA_DIR / "ppa" / f"{d}.json.gz")
        return not c or c.get("format") != CACHE_FORMAT or c.get("src_size") != _src_key(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")

    todo = [d for d in dates if (UNIT_DATA_DIR / "60d" / f"{d}.json.gz").exists() and stale(d)]
    if not todo:
        return
    print(f"ppa: caching hourly offers for {len(todo)} day(s)")
    with ProcessPoolExecutor(max_workers=os.cpu_count() or 2) as ex:
        list(ex.map(day_offers, todo))


def _arr(v):
    return np.array([np.nan if x is None else x for x in (v or [None] * 24)][:24] + [np.nan] * max(0, 24 - len(v or [None] * 24)), float)


def _fit(x, y):
    a, b = np.polyfit(x, y, 1)
    return float(a), float(b), float(np.sqrt(np.mean((y - (a * x + b)) ** 2)))


def infer_unit(rows, points, floor=None):
    """rows: [(date index, offer [24], spread [24], hsl [24], {point: DA [24]})] for one unit.
    Hours at the unit's usual floor offer or at $0 (a common cap) are left out as clamped.
    Returns the formula-day fits and the best settlement point, or None."""
    days = []
    for di, off, spread, hsl, da in rows:
        av = np.isfinite(off) & (hsl >= MIN_HSL) & (np.nan_to_num(spread, nan=99) <= FLAT_USD)
        if av.sum() < 4:
            continue
        m = av & (np.abs(off) >= 0.02)
        if floor is not None:
            m &= np.abs(off - floor) >= 0.05
        for ext in (off[av].min(), off[av].max()):
            same = av & (np.abs(off - ext) < 0.05)
            if same.sum() >= 2:
                m &= ~same
        if m.sum() < 4 or len(np.unique(np.round(off[m] * 2))) < 4:
            continue
        fits = {}
        for p in points:
            x = da.get(p)
            if x is None:
                continue
            ok = m & np.isfinite(x)
            if ok.sum() < 4 or np.ptp(x[ok]) < 5:
                continue
            fits[p] = _fit(x[ok], off[ok]) + (int(ok.sum()),)
        if fits:
            days.append((di, m, fits, off, da))
    if len(days) < 2:
        return None
    score = []
    for p in points:
        ab = [f[p] for _, _, f, _, _ in days if p in f]
        if len(ab) < 2:
            continue
        a, b = float(np.median([v[0] for v in ab])), float(np.median([v[1] for v in ab]))
        res, pts = [], []
        for di, m, _, off, da in days:
            x = da.get(p)
            if x is None:
                continue
            ok = m & np.isfinite(x)
            res += list(np.abs(off[ok] - (a * x[ok] + b)))
            pts += [(di, float(xv), float(yv)) for xv, yv in zip(x[ok], off[ok])]
        if res:
            score.append((float(np.mean(np.array(res) < HIT_USD)), p, a, b, len(res), pts))
    if not score:
        return None
    score.sort(key=lambda s: (-s[0], -s[4]))
    best = score[0]
    daily = [[di, f[best[1]][0], f[best[1]][1], f[best[1]][2], f[best[1]][3]] for di, _, f, _, _ in days if best[1] in f]
    return {"best": best, "others": score[1:], "days": [d[0] for d in days], "daily": daily}


def build_ppa(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    dam_days = set(index["days"].get("dam", []))
    hubs = load_dam_prices()
    hub_points = hubs.get("points") or []
    points = ["node"] + hub_points
    fill_cache(dates)
    per_unit = {}      # name -> list of (di, offer, spread, hsl, da)
    habit = {}         # name -> [award MWh, base point MWh, days with award, days available]
    tech_of, sp_of = {}, {}
    for di, d in enumerate(dates):
        offers = day_offers(d)
        if not offers:
            continue
        dam = ((read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") if d in dam_days else None) or {}).get("units") or {}
        hub_day = hubs["days"].get(d) or {}
        hub_arr = {p: _arr(v) for p, v in hub_day.items()}
        for name, u in offers.items():
            tech_of[name] = u["tech"]
            du = dam.get(name) or {}
            if du.get("sp"):
                sp_of[name] = du["sp"]
            off, hsl, bp = _arr(u["offer"]), _arr(u["hsl"]), _arr(u["bp"])
            da = dict(hub_arr)
            da["node"] = _arr(du.get("spp"))
            per_unit.setdefault(name, []).append((di, off, _arr(u["spread"]), hsl, da))
            h = habit.setdefault(name, [0.0, 0.0, 0, 0])
            if np.nansum(hsl >= MIN_HSL):
                award = np.nansum(_arr(du.get("award")))
                h[0] += award
                h[1] += np.nansum(bp)
                h[2] += int(award > 0)
                h[3] += 1

    units, fits = [], {}
    for name, rows in per_unit.items():
        off_all = np.concatenate([r[1][(r[3] >= MIN_HSL)] for r in rows]) if rows else np.array([])
        off_all = off_all[np.isfinite(off_all)]
        floor = None
        if len(off_all):
            mode = Counter(np.round(off_all, 2)).most_common(1)[0][0]
            floor = float(mode)
        h = habit.get(name, [0, 0, 0, 0])
        rec = {"name": name, "tech": tech_of[name], "sp": sp_of.get(name), "tier": "hints",
               "floor": _r(floor), "da_share": _r(h[0] / h[1], 3) if h[1] > 0 else None,
               "da_days": _r(h[2] / h[3], 3) if h[3] else None, "avail_days": h[3]}
        res = infer_unit(rows, points, floor)
        if res:
            hit, p, a, b, n_h, pts = res["best"]
            others = res["others"]
            slope_ok = SLOPE[0] <= a <= SLOPE[1]
            near = [o[1] for o in others if o[0] >= hit - 0.1]
            if slope_ok and len(res["days"]) >= 3 and n_h >= 24 and hit >= 0.8:
                tier = "unclear" if near else "revealed"
            elif slope_ok and hit >= 0.5:
                tier = "partial"
            else:
                tier = "hints"
            if tier != "hints":
                rec.update({
                    "tier": tier, "point": p, "a": _r(a, 3), "b": _r(b), "hit": _r(hit, 3),
                    "alt": [[o[1], _r(o[0], 3)] for o in others[:3]], "near": near,
                    "days": len(res["days"]), "hours": n_h,
                    "first": dates[res["days"][0]], "last": dates[res["days"][-1]],
                    "strike_hi": _r(-b / a), "strike_lo": _r((-b - CREDIT) / a) if -b - CREDIT > 0 else None,
                    "daily": [[dates[di], _r(da_, 3), _r(db), _r(dr), n] for di, da_, db, dr, n in res["daily"]],
                })
                if len(pts) > MAX_FIT_POINTS:
                    pts = [pts[i] for i in np.linspace(0, len(pts) - 1, MAX_FIT_POINTS).astype(int)]
                fits[name] = [[di, _r(x), _r(y)] for di, x, y in pts]
        units.append(rec)

    # units bid on the same rule: same point, slope within 0.02 and intercept within $1.50
    found = [u for u in units if u["tier"] != "hints"]
    gid = 0
    for i, u in enumerate(found):
        if "group" in u:
            continue
        mates = [v for v in found[i:] if "group" not in v and v["point"] == u["point"]
                 and abs(v["a"] - u["a"]) <= 0.02 and abs(v["b"] - u["b"]) <= 1.5]
        if len(mates) > 1:
            gid += 1
            for v in mates:
                v["group"] = gid

    order = {"revealed": 0, "unclear": 1, "partial": 2, "hints": 3}
    units.sort(key=lambda u: (order[u["tier"]], -(u.get("hours") or 0), u["name"]))
    out = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "hit_usd": HIT_USD, "credit": CREDIT, "points": points, "tiers": TIERS,
        "n_days": len(dates), "first": dates[0] if dates else None, "last": dates[-1] if dates else None,
        "hub_days": [d for d in dates if d in hubs["days"]][:1] + [d for d in dates if d in hubs["days"]][-1:],
        "dates": dates, "units": units, "fits": fits,
    }
    write_json_gz(DATA_DIR / "ppa.json.gz", out)
    n = Counter(u["tier"] for u in units)
    print(f"ppa: {len(units)} wind/solar units; " + ", ".join(f"{TIERS[k]} {n.get(k, 0)}" for k in TIERS))
