"""Battery (ESR) day files: what every battery did in real time and what it sold day-ahead,
one file per 60-day day, for the fleet battery model, its scoring and the Unit page.  Needs
no downloads: built from the per-unit day files on the data branch (pipeline/units.py) and
the DAM day files (pipeline/parse_dam.py, which read the DAM ESR Data file from the RTC+B
start).

Sign convention everywhere here: charging and discharging are both positive MW, in separate
series; "net" is discharge minus charge (ERCOT's signed base point).  Hour h (0..23) is hour
ending h+1, like the rest of the site.

data/storage/<date>.json.gz
{
  "date", "format", "key",         # key: sizes of the files the day was built from (rebuild test)
  "n_units", "n_online",           # batteries in the SCED ESR file; online in at least one run
  "n_soc",                         # batteries with a state of charge that day (0 before the
                                   # per-unit file was (re)processed at format 7)
  "n_dam",                         # batteries with a DAM row (0 until the DAM ESR file is loaded)
  "fleet": {                       # 24 hourly values each, MW unless said; null where unknown
    "dis", "chg":   base point split by sign at every SCED run, hourly mean, summed over
                    units (the 2-day generation summary's ESR discharging / charging method)
    "out_dis", "out_chg":  the same from telemetered net output (hourly means, so a unit that
                    switches within the hour leaks a little between the two)
    "hsl", "lsl":   summed limits over online units (lsl is negative: the charging limit)
    "head_dis", "head_chg":  room left: (HSL - base point) when discharging or idle, and
                    (base point - LSL) when charging or idle, summed over online units
    "soc", "soc_min", "soc_max":  summed state of charge and its limits (MWh) over the units
                    that report one; null when none does
    "as_up", "as_dn":  ancillary service awarded in SCED, summed (up: Reg-Up, RRS, ECRS,
                    Non-Spin; down: Reg-Down)
    "cap_up", "cap_dn":  AS capability telemetered, summed (format 7 files only)
    "dam_dis", "dam_chg":  DAM energy awards, summed, split by sign
    "dam_as": {"regup", "regdn", "rrs", "ecrs", "nspin": [24]}  DAM AS awards, summed
    "dis0", "dis50", "chg0", "chg50":  $/MWh, the fleet's offer prices from the submitted
                    curves (format 2): per battery, the median over the hour's online runs of
                    dis0  lowest price at which it offers any discharge
                    dis50 price at which offered discharge reaches half of HSL
                    chg0  highest price at which it still bids to charge
                    chg50 price below which it bids at least half of its charging range (|LSL|)
                    then the median across batteries weighted by HSL (dis) or |LSL| (chg).
                    ONTEST runs are left out
    "chg_ge": {"<price>": [24]}  MW bid to charge at that price or above it (charging that
                    continues if the price is that high), summed over online batteries, from the
                    submitted curves capped to [LSL, 0]; hourly mean of the per-run sums
    "dis_le": {"<price>": [24]}  MW offered to discharge at that price or below, capped to
                    [0, HSL]; prices are OFFER_PRICES
  },
  "units": {
    "<Resource Name>": {
      "hsl", "lsl":  MW, the day's largest HSL and smallest LSL while online
      "sp":          settlement point (from the DAM row; null without one)
      "online":      share of the day's runs online (status starting "ON")
      "bp", "out":   [24] hourly mean base point and net output, signed
      "soc": [24] | null,  "soc_min", "soc_max":  MWh, hourly mean / day's limits, when reported
      "as_up", "as_dn", "cap_up", "cap_dn": [24] hourly means, MW (null series when unknown)
      "dam": [24] | null,  signed DAM energy award
      "dam_as": {service: [24]} | null,  "spp": [24] | null  DAM price at its node
      "dis0", "dis50", "chg0", "chg50": [24] | null  its offer prices as above, $/MWh
    }, ...
  }
}
data/storage/index.json.gz   {format, days, soc_from (first day with a state of charge),
                              dam_from (first day with DAM battery rows), fields}
The index's "days" list is also kept in data/index.json under days.storage.

data/storage/series.json.gz  every day's fleet block in one file, for the Batteries page's
                              date-range charts: {format, dates, prices (OFFER_PRICES),
                              fleet: {field: [day][24]}, chg_ge / dis_le: {price: [day][24]},
                              n_units, n_online: [day]}
data/storage/units.json.gz   one row a day per battery, for the Unit page's across-days charts
                              and the battery events: {format, dates, fields (UNIT_DAY_FIELDS),
                              units: {name: {field: [day]}}}, null on days the battery is absent:
                                hsl, soc_max   the day's largest HSL (MW) and maximum state of charge (MWh)
                                dis, chg       MWh discharged and charged (hourly base points)
                                dam_dis, dam_chg   MWh awarded day-ahead each way
                                dis0           lowest price at which it offered discharge in any hour
                                chg0           price where its charging stops, mean over HE 10 to 16
                                as_up          AS up awarded in SCED, mean MW over the day
data/storage/habits.json.gz  the same shape, for the battery events (pipeline/events.py), with
                              hsl, soc_max, dis, chg and each battery's daily habit profile:
                                dis0_mid, dis0_pk, chg0_mid, chg0_pk   median dis0 / chg0 over HE 10 to
                                               16 and HE 17 to 22
                                chg_hr         hour ending by which a tenth of the day's charging is done

  python -m pipeline.storage            # build or refresh every day with a per-unit file
  python -m pipeline.storage --all      # rebuild every day
"""
import argparse
import sys

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import load_index, read_json_gz, save_index, write_json_gz
from .units import expand

FORMAT = 2          # 2: offer prices and MW by price from the submitted curves; AS capability summed with RRS missing
OUT_DIR = DATA_DIR / "storage"
AS_UP = ("regup", "rrs", "ecrs", "nspin")
AS_DN = ("regdn",)
FLEET_FIELDS = ["dis", "chg", "out_dis", "out_chg", "hsl", "lsl", "head_dis", "head_chg", "soc", "soc_min", "soc_max",
                "as_up", "as_dn", "cap_up", "cap_dn", "dam_dis", "dam_chg"]
OFFER_FIELDS = ["dis0", "dis50", "chg0", "chg50"]
OFFER_PRICES = [-250, -20, 0, 10, 20, 30, 50, 100, 250]   # $/MWh for chg_ge and dis_le
UNIT_DAY_FIELDS = ["hsl", "soc_max", "dis", "chg", "dam_dis", "dam_chg", "dis0", "chg0", "as_up"]
HABIT_FIELDS = ["dis0_mid", "dis0_pk", "chg0_mid", "chg0_pk", "chg_hr"]
MIDDAY = slice(9, 16)          # HE 10 to 16, where charging bids are read
PEAK = slice(16, 22)           # HE 17 to 22, where discharge offers are read


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _rl(a, nd=1):
    return None if a is None else [_r(v, nd) for v in a]


def _hourly_mean(v: np.ndarray, hour: np.ndarray, mask=None) -> np.ndarray:
    """Mean of v over the runs in each hour (NaN ignored; NaN where no run has a value)."""
    out = np.full(24, np.nan)
    ok = np.isfinite(v) & (mask if mask is not None else True)
    for h in range(24):
        sel = ok & (hour == h)
        if sel.any():
            out[h] = v[sel].mean()
    return out


def _key(date, dam_days):
    """What the day was built from: per-unit file size and DAM file size (0 without one)."""
    p = UNIT_DATA_DIR / "60d" / f"{date}.json.gz"
    d = DATA_DIR / "dam" / f"{date}.json.gz"
    return [p.stat().st_size if p.exists() else 0, d.stat().st_size if date in dam_days and d.exists() else 0]


def _price_at(p: np.ndarray, m: np.ndarray, target: float) -> float:
    """Lowest price at which the curve (MW non-decreasing, linear between points) reaches
    `target` MW; NaN if it never does."""
    if m[-1] < target - 1e-9:
        return np.nan
    if m[0] >= target:
        return float(p[0])
    i = int(np.argmax(m >= target))
    m0, m1, p0, p1 = m[i - 1], m[i], p[i - 1], p[i]
    return float(p1 if m1 == m0 else p0 + (p1 - p0) * (target - m0) / (m1 - m0))


def _offer_metrics(p, m, hsl: float, lsl: float) -> tuple:
    """(dis0, dis50, chg0, chg50, MW at each OFFER_PRICES) of one submitted ESR curve, which
    runs from charging (negative MW) to discharging; MW clipped to [LSL, HSL]."""
    p = np.asarray(p, float)
    m = np.clip(np.maximum.accumulate(np.asarray(m, float)), min(lsl, 0.0), max(hsl, 0.0))
    chg0 = _price_at(p, m, 0.0) if m[0] < 0 else np.nan
    chg50 = _price_at(p, m, 0.5 * lsl) if lsl < -0.5 and m[0] <= 0.5 * lsl else np.nan
    dis0 = _price_at(p, m, 0.05) if hsl > 0.5 else np.nan
    dis50 = _price_at(p, m, 0.5 * hsl) if hsl > 0.5 else np.nan
    at = np.interp(OFFER_PRICES, p, m) if len(p) > 1 else np.full(len(OFFER_PRICES), m[0])
    return dis0, dis50, chg0, chg50, at


def _wmedian(v: np.ndarray, w: np.ndarray) -> float:
    """Weighted median (NaN values and non-positive weights ignored)."""
    ok = np.isfinite(v) & np.isfinite(w) & (w > 0)
    if not ok.any():
        return np.nan
    v, w = v[ok], w[ok]
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return float(v[o][np.searchsorted(c, 0.5 * c[-1])])


def build_day(date: str, unit_day: dict, dam: dict) -> dict:
    runs = np.asarray(unit_day["runs"], int)
    n = len(runs)
    hour = np.minimum(runs // 60, 23)
    rep = unit_day.get("dst_repeat") or []
    if rep:                                   # fall-back day: the repeated hour's runs count in hour 1 too
        hour = hour.copy()
        hour[rep] = 1
    dam_units = (dam or {}).get("units") or {}
    fleet = {k: np.zeros(24) for k in FLEET_FIELDS}
    have = {k: np.zeros(24, bool) for k in ("soc", "soc_min", "soc_max", "cap_up", "cap_dn", "as_up", "as_dn")}
    dam_as = {k: np.zeros(24) for k in AS_UP + AS_DN}
    np_ = len(OFFER_PRICES)
    chg_ge, dis_le, have_curve = np.zeros((np_, 24)), np.zeros((np_, 24)), np.zeros(24, bool)
    offers = {k: [] for k in OFFER_FIELDS}        # per battery [24] arrays, for the fleet medians
    weights = {"dis": [], "chg": []}
    units, n_online, n_soc, n_dam = {}, 0, 0, 0
    for name, u in unit_day["units"].items():
        if u.get("tech") != "storage":
            continue
        x = expand(u, n)
        online = np.array([bool(s) and s.startswith("ON") for s in x["status"]])
        if online.any():
            n_online += 1
        bp = x.get("bp", np.full(n, np.nan))
        # net output per run is not kept per run; the hourly means are in the file
        out_h = np.array([np.nan if v is None else v for v in u["out"]], float)
        bp_h = _hourly_mean(bp, hour, online)
        bp_h = np.where(np.isnan(bp_h), np.array([np.nan if v is None else v for v in u["bp"]], float), bp_h)
        dis_h, chg_h = _hourly_mean(np.fmax(bp, 0), hour, online), _hourly_mean(-np.fmin(bp, 0), hour, online)
        if np.isnan(dis_h).all():            # file without per-run base points: split the hourly mean
            dis_h, chg_h = np.fmax(bp_h, 0), -np.fmin(bp_h, 0)
        hsl, lsl = x["hsl"], x["lsl"]
        hsl_h = _hourly_mean(np.where(online, hsl, np.nan), hour)
        lsl_h = _hourly_mean(np.where(online, lsl, np.nan), hour)
        with np.errstate(invalid="ignore"):
            head_dis = _hourly_mean(np.where(online, hsl - np.fmax(bp, 0), np.nan), hour)
            head_chg = _hourly_mean(np.where(online, np.fmin(bp, 0) - lsl, np.nan), hour)
        asup, asdn = x.get("asup", np.full(n, np.nan)), x.get("asdn", np.full(n, np.nan))
        asup_h, asdn_h = _hourly_mean(asup, hour, online), _hourly_mean(asdn, hour, online)
        # services the file leaves blank (RRS on some days) count as 0 unless every one is blank
        caps = np.array([x.get(f"cap_{k}", np.full(n, np.nan)) for k in AS_UP])
        cap_up = np.where(np.isfinite(caps).any(axis=0), np.nansum(caps, axis=0), np.nan) if "cap_regup" in x else np.full(n, np.nan)
        cap_dn = x.get("cap_regdn", np.full(n, np.nan))
        cap_up_h, cap_dn_h = _hourly_mean(cap_up, hour, online), _hourly_mean(cap_dn, hour, online)
        # offer prices and MW by price from the submitted curve, online runs other than ONTEST
        met = np.full((n, 4), np.nan)
        at = np.full((n, np_), np.nan)
        cache = {}
        for r in range(n):
            s, c = x["status"][r], x["curve"][r]
            if not online[r] or s == "ONTEST" or c is None or not np.isfinite(hsl[r]) or not np.isfinite(lsl[r]):
                continue
            key = (id(c[0]), hsl[r], lsl[r])
            if key not in cache:
                *mm, a = _offer_metrics(c[0], c[1], hsl[r], lsl[r])
                cache[key] = (mm, a)
            met[r], at[r] = cache[key]
        off_h = {}
        for j, k in enumerate(("dis0", "dis50", "chg0", "chg50")):
            v = np.full(24, np.nan)
            for h in range(24):
                col = met[hour == h, j]
                if np.isfinite(col).any():
                    v[h] = np.nanmedian(col)
            off_h[k] = v
            offers[k].append(v)
        weights["dis"].append(np.nan_to_num(hsl_h)); weights["chg"].append(np.nan_to_num(-lsl_h))
        cur = np.isfinite(at[:, 0])
        if cur.any():
            for h in range(24):
                sel = cur & (hour == h)
                if sel.any():
                    have_curve[h] = True
                    # hourly mean over the hour's runs, counting runs without a curve as 0
                    nh = max(int((hour == h).sum()), 1)
                    chg_ge[:, h] += -np.fmin(at[sel], 0).sum(axis=0) / nh
                    dis_le[:, h] += np.fmax(at[sel], 0).sum(axis=0) / nh
        soc_h = _hourly_mean(x["soc"], hour) if "soc" in x else None
        has_soc = soc_h is not None and np.isfinite(soc_h).any()
        if has_soc:
            n_soc += 1
        d = dam_units.get(name)
        if d and any(a is not None for a in (d.get("award") or [])):
            n_dam += 1
        rec = {"hsl": _r(np.nanmax(np.where(online, hsl, np.nan)) if online.any() else np.nan),
               "lsl": _r(np.nanmin(np.where(online, lsl, np.nan)) if online.any() else np.nan),
               "sp": (d or {}).get("sp") or None, "online": _r(online.mean(), 3),
               "bp": _rl(bp_h), "out": _rl(out_h),
               "soc": _rl(soc_h) if has_soc else None,
               "soc_min": _r(np.nanmin(x["soc_min"])) if has_soc and np.isfinite(x["soc_min"]).any() else None,
               "soc_max": _r(np.nanmax(x["soc_max"])) if has_soc and np.isfinite(x["soc_max"]).any() else None,
               "as_up": _rl(asup_h) if np.isfinite(asup_h).any() else None,
               "as_dn": _rl(asdn_h) if np.isfinite(asdn_h).any() else None,
               "cap_up": _rl(cap_up_h) if np.isfinite(cap_up_h).any() else None,
               "cap_dn": _rl(cap_dn_h) if np.isfinite(cap_dn_h).any() else None,
               "dam": (d or {}).get("award")[:24] if d and d.get("award") else None,
               "dam_as": {k: v[:24] for k, v in (d.get("as") or {}).items()} if d and d.get("as") else None,
               "spp": (d or {}).get("spp")[:24] if d and d.get("spp") else None}
        for k, v in off_h.items():
            rec[k] = _rl(v) if np.isfinite(v).any() else None
        units[name] = rec

        # fleet sums (NaN counts as 0 in a sum; the have[] masks say whether anything was known)
        fleet["dis"] += np.nan_to_num(dis_h); fleet["chg"] += np.nan_to_num(chg_h)
        fleet["out_dis"] += np.nan_to_num(np.fmax(out_h, 0)); fleet["out_chg"] += np.nan_to_num(-np.fmin(out_h, 0))
        fleet["hsl"] += np.nan_to_num(hsl_h); fleet["lsl"] += np.nan_to_num(lsl_h)
        fleet["head_dis"] += np.nan_to_num(head_dis); fleet["head_chg"] += np.nan_to_num(head_chg)
        if has_soc:
            fleet["soc"] += np.nan_to_num(soc_h); have["soc"] |= np.isfinite(soc_h)
            for k in ("soc_min", "soc_max"):
                v = _hourly_mean(x[k], hour)
                fleet[k] += np.nan_to_num(v); have[k] |= np.isfinite(v)
        for k, v in (("as_up", asup_h), ("as_dn", asdn_h), ("cap_up", cap_up_h), ("cap_dn", cap_dn_h)):
            fleet[k] += np.nan_to_num(v); have[k] |= np.isfinite(v)
        if rec["dam"]:
            a = np.array([np.nan if v is None else v for v in rec["dam"]], float)
            fleet["dam_dis"] += np.nan_to_num(np.fmax(a, 0)); fleet["dam_chg"] += np.nan_to_num(-np.fmin(a, 0))
        for k, v in (rec["dam_as"] or {}).items():
            if k in dam_as:
                dam_as[k] += np.nan_to_num(np.array([np.nan if y is None else y for y in v], float))

    out_fleet = {}
    for k in FLEET_FIELDS:
        v = fleet[k]
        if k in have:
            v = np.where(have[k], v, np.nan)
        if k.startswith("dam_") and not n_dam:
            v = np.full(24, np.nan)
        out_fleet[k] = _rl(v)
    out_fleet["dam_as"] = {k: _rl(v) for k, v in dam_as.items()} if n_dam else None
    for k in OFFER_FIELDS:
        if offers[k]:
            v, w = np.array(offers[k]), np.array(weights[k[:3]])
            out_fleet[k] = _rl([_wmedian(v[:, h], w[:, h]) for h in range(24)])
        else:
            out_fleet[k] = [None] * 24
    for key, arr in (("chg_ge", chg_ge), ("dis_le", dis_le)):
        out_fleet[key] = {str(p): _rl(np.where(have_curve, arr[i], np.nan), 0) for i, p in enumerate(OFFER_PRICES)}
    return {"date": date, "format": FORMAT, "n_units": len(units), "n_online": n_online, "n_soc": n_soc, "n_dam": n_dam,
            "fleet": out_fleet, "units": dict(sorted(units.items()))}


def build_storage(index: dict, rebuild_all: bool = False) -> list:
    """Build or refresh data/storage/<date>.json.gz for every 60-day day with a per-unit file;
    returns the days (re)built."""
    dam_days = set(index["days"].get("dam", []))
    dates = [d for d in sorted(index["days"].get("60d", [])) if (UNIT_DATA_DIR / "60d" / f"{d}.json.gz").exists()]
    done, built = [], []
    for d in dates:
        key = _key(d, dam_days)
        path = OUT_DIR / f"{d}.json.gz"
        cur = read_json_gz(path) if path.exists() else None
        if cur and not rebuild_all and cur.get("format") == FORMAT and cur.get("key") == key:
            done.append((d, cur))
            continue
        unit_day = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if not unit_day:
            continue
        dam = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") if d in dam_days else None
        day = build_day(d, unit_day, dam)
        day["key"] = key
        write_json_gz(path, day)
        done.append((d, day))
        built.append(d)
    have = {d for d, _ in done}
    for p in OUT_DIR.glob("20*.json.gz"):      # a day whose per-unit file went away
        if p.name[:10] not in have:
            p.unlink()
    days = sorted(have)
    write_json_gz(OUT_DIR / "index.json.gz", {
        "format": FORMAT, "days": days, "fields": FLEET_FIELDS + ["dam_as"] + OFFER_FIELDS + ["chg_ge", "dis_le"],
        "soc_from": next((d for d, day in done if day.get("n_soc")), None),
        "dam_from": next((d for d, day in done if day.get("n_dam")), None),
        "n_units": {d: day["n_units"] for d, day in done},
    })
    index["days"]["storage"] = days
    _write_series(done)
    _write_units(done)
    print(f"storage: {len(built)} day(s) built, {len(days)} in the index"
          + (f", state of charge from {next((d for d, day in done if day.get('n_soc')), None)}" if any(day.get("n_soc") for _, day in done) else ", no state of charge yet")
          + (f", DAM battery rows from {next((d for d, day in done if day.get('n_dam')), None)}" if any(day.get("n_dam") for _, day in done) else ", no DAM battery rows yet"))
    return built


def _write_series(done: list) -> None:
    """data/storage/series.json.gz: the fleet block of every day, [day][24] per field."""
    done = sorted(done, key=lambda t: t[0])
    keys = FLEET_FIELDS + OFFER_FIELDS
    blank = [None] * 24
    fleet = {k: [day["fleet"].get(k) or blank for _, day in done] for k in keys}
    by_price = {key: {str(p): [((day["fleet"].get(key) or {}).get(str(p))) or blank for _, day in done]
                      for p in OFFER_PRICES} for key in ("chg_ge", "dis_le")}
    write_json_gz(OUT_DIR / "series.json.gz", {
        "format": FORMAT, "dates": [d for d, _ in done], "prices": OFFER_PRICES, "fleet": fleet, **by_price,
        "n_units": [day["n_units"] for _, day in done], "n_online": [day["n_online"] for _, day in done]})


def _unit_day(u: dict) -> list:
    """One battery's day as UNIT_DAY_FIELDS (see the module docstring)."""
    def arr(k):
        v = u.get(k)
        return None if v is None else np.array([np.nan if x is None else x for x in v], float)
    bp, dam, dis0, chg0, asup = arr("bp"), arr("dam"), arr("dis0"), arr("chg0"), arr("as_up")
    with np.errstate(invalid="ignore"):
        mid = chg0[MIDDAY] if chg0 is not None else None
        return [u.get("hsl"), u.get("soc_max"),
                _r(np.nansum(np.fmax(bp, 0))) if bp is not None and np.isfinite(bp).any() else None,
                _r(-np.nansum(np.fmin(bp, 0))) if bp is not None and np.isfinite(bp).any() else None,
                _r(np.nansum(np.fmax(dam, 0))) if dam is not None and np.isfinite(dam).any() else None,
                _r(-np.nansum(np.fmin(dam, 0))) if dam is not None and np.isfinite(dam).any() else None,
                _r(np.nanmin(dis0)) if dis0 is not None and np.isfinite(dis0).any() else None,
                _r(np.nanmean(mid)) if mid is not None and np.isfinite(mid).any() else None,
                _r(np.nanmean(asup)) if asup is not None and np.isfinite(asup).any() else None,
                _med(dis0, MIDDAY), _med(dis0, PEAK), _med(chg0, MIDDAY), _med(chg0, PEAK), _chg_hr(bp)]


def _med(a, sl):
    if a is None or not np.isfinite(a[sl]).any():
        return None
    return _r(np.nanmedian(a[sl]))


def _chg_hr(bp):
    """Hour ending by which a tenth of the day's charging is done, or None below 1 MWh charged."""
    if bp is None:
        return None
    c = np.nan_to_num(-np.fmin(bp, 0))
    if c.sum() < 1:
        return None
    return int(np.argmax(np.cumsum(c) >= 0.1 * c.sum())) + 1


def _write_units(done: list) -> None:
    """data/storage/units.json.gz (for the Unit page) and habits.json.gz (for the battery
    events): one row a day per battery."""
    done = sorted(done, key=lambda t: t[0])
    names = sorted({n for _, day in done for n in day["units"]})
    fields = UNIT_DAY_FIELDS + HABIT_FIELDS
    units = {n: {k: [None] * len(done) for k in fields} for n in names}
    for i, (_, day) in enumerate(done):
        for n, u in day["units"].items():
            for k, v in zip(fields, _unit_day(u)):
                units[n][k][i] = v
    dates = [d for d, _ in done]
    for path, keep in (("units.json.gz", UNIT_DAY_FIELDS), ("habits.json.gz", ["hsl", "soc_max", "dis", "chg"] + HABIT_FIELDS)):
        write_json_gz(OUT_DIR / path, {"format": FORMAT, "dates": dates, "fields": keep,
                                       "units": {n: {k: u[k] for k in keep} for n, u in units.items()}})


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all", action="store_true", help="rebuild every day, not only stale ones")
    args = ap.parse_args(argv)
    index = load_index()
    build_storage(index, rebuild_all=args.all)
    save_index(index)
    return 0


if __name__ == "__main__":
    sys.exit(main())
