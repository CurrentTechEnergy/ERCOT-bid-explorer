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
    }, ...
  }
}
data/storage/index.json.gz   {format, days, soc_from (first day with a state of charge),
                              dam_from (first day with DAM battery rows), fields}
The index's "days" list is also kept in data/index.json under days.storage.

  python -m pipeline.storage            # build or refresh every day with a per-unit file
  python -m pipeline.storage --all      # rebuild every day
"""
import argparse
import sys

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import load_index, read_json_gz, save_index, write_json_gz
from .units import expand

FORMAT = 1
OUT_DIR = DATA_DIR / "storage"
AS_UP = ("regup", "rrs", "ecrs", "nspin")
AS_DN = ("regdn",)
FLEET_FIELDS = ["dis", "chg", "out_dis", "out_chg", "hsl", "lsl", "head_dis", "head_chg", "soc", "soc_min", "soc_max",
                "as_up", "as_dn", "cap_up", "cap_dn", "dam_dis", "dam_chg"]


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
        cap_up = sum(x.get(f"cap_{k}", np.full(n, np.nan)) for k in AS_UP) if "cap_regup" in x else np.full(n, np.nan)
        cap_dn = x.get("cap_regdn", np.full(n, np.nan))
        cap_up_h, cap_dn_h = _hourly_mean(cap_up, hour, online), _hourly_mean(cap_dn, hour, online)
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
        "format": FORMAT, "days": days, "fields": FLEET_FIELDS + ["dam_as"],
        "soc_from": next((d for d, day in done if day.get("n_soc")), None),
        "dam_from": next((d for d, day in done if day.get("n_dam")), None),
        "n_units": {d: day["n_units"] for d, day in done},
    })
    index["days"]["storage"] = days
    print(f"storage: {len(built)} day(s) built, {len(days)} in the index"
          + (f", state of charge from {next((d for d, day in done if day.get('n_soc')), None)}" if any(day.get("n_soc") for _, day in done) else ", no state of charge yet")
          + (f", DAM battery rows from {next((d for d, day in done if day.get('n_dam')), None)}" if any(day.get("n_dam") for _, day in done) else ", no DAM battery rows yet"))
    return built


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
