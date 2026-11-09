"""Wind and solar across the years: fleet size, energy, curtailment, the price they captured and
how much of their output landed in hours priced at $0 or below.  Read by the Renewables page's
"Across the years" panel.  Needs no ERCOT downloads:
  - monthly, from Jan 2019: the wind and solar months of the hourly history (units-YYYY-MM.parquet
    on the `history` release, pipeline/history.py) with the same months' hourly real-time prices
    (rt-prices-, to Nov 2025), day-ahead hub prices (da-hubs-) and thermal output (thermal-, to Nov
    2025, for the hours' total generation), fetched with the gh CLI
  - daily, from the series month files (data/series/YYYY-MM/{wind,solar}.json.gz, pipeline/series.py),
    which also give each month they cover completely (Dec 2025 on): the history misses a day or
    two in a few months, so a history month short of days has its energy scaled up to the month

Per technology and period:
  gw          fleet size: the units with any HSL in the period (daily: in the 30 days ending that
              day), each at its highest hourly HSL over the 12 months ending with the period, summed,
              GW.  Monthly the window is the month and the 11 before it; daily, the day's month up to
              the day and the 11 months before.  Wind's HSL is what the wind lets it make, so a month's
              own highest hour runs 2-3 GW under the fleet's in a calm summer; over 12 months every
              unit has had its windy (or clear) hours.  Monthly, the first 11 months (2019) have less
              than a year behind them: "gw_months" gives each month's window length.  Daily, null for
              the first 29 days.
  nameplate   the same units at their installed capacity in ERCOT's CDR report (pipeline/cdr.py,
              reference/cdr_units.csv: one edition, applied to every year, so a repowered unit
              carries today's rating back), GW.  Matched on the unit code (cdr.Matcher, "unit"
              matches only); where several of our units match one CDR unit (a jointly owned unit
              SCED splits, _J01/_J02), its MW is shared by their highest HSL.  A unit the CDR doesn't
              have (newer than the edition, or gone before it) counts at its 12-month HSL, as in gw.
  np_fallback the part of nameplate counted at HSL for want of a CDR rating, GW
  units       units with any HSL in the period (that 30-day window, daily)
  gen         energy generated (telemetered output), GWh
  curt        curtailed: HSL above base point, summed over hours, GWh
              (a history month missing days: both scaled by days in the month / days loaded)
  capture     output-weighted DA price at each unit's settlement point, $/MWh
  avg         plain average DA price over the same unit-hours, $/MWh (capture / avg: timing only)
  rt_capture  output-weighted real-time price at each unit's settlement point, $/MWh
  rt_avg      plain average real-time price over the same unit-hours, $/MWh
  hub_da, hub_rt   plain average of the ERCOT hub average (HB_HUBAVG) over the period's hours, DA
              and real-time, $/MWh (capture / hub: timing and location)
  hub_da_gen, hub_rt_gen   the same hub prices weighted by each hour's ERCOT generation (every
              unit's telemetered output in the 60-day data, storage left out; the history's
              thermal plus wind and solar months, to Nov 2025): what the average MWh sold earned
              at the hub, $/MWh (capture / this: against the average MWh)
  sys_gen     that ERCOT generation over the period's hours with a real-time hub price, GWh (the
              weight for averaging hub_rt_gen over a year)
  neg         share of output in hours whose DA price at the unit's settlement point was $0 or below

data/renewables/years.json.gz
  {"format", "months": [YYYY-MM], "monthly": {tech: {field: [month]}}, "monthly_source": [month]
   ("h" history, "s" series), "gw_months": [months in each month's fleet-size window, 1-12],
   "dates": [YYYY-MM-DD], "daily": {tech: {field: [day]}}}
Monthly summaries from the history are cached on the data branch under renew_years/, keyed on the
release assets' ids and sizes, so a run only fetches months that are new or rebuilt; each unit's
highest HSL in a history month is cached apart, under renew_years/maxes/, keyed on the units asset
alone (so adding it didn't rebuild the summaries).

  python -m pipeline.renew_years
"""
import calendar
import json
import os
import subprocess
from pathlib import Path

import numpy as np

from .cdr import edition
from .config import DATA_DIR, UNIT_DATA_DIR
from .hours import day_weights, hour_weight
from .log import warn
from .store import read_json_gz, write_json_gz

FORMAT = 6      # 5: the fall-back Sunday's folded HE2 weighs two hours (pipeline/hours.py); 6: fleet size over 12 months
SUMMARY_FORMAT = 5      # the cached month summaries' format (6 changed only how gw is put together)


def _cache_ok(c: dict, month: str) -> bool:
    """A cached month is current at FORMAT; one built at 4 differs only in a November (the
    fall-back Sunday), so other months at 4 are kept rather than rebuilt."""
    f = (c or {}).get("format")
    return f == SUMMARY_FORMAT or (f == 4 and month[5:] != "11")
PATH = DATA_DIR / "renewables" / "years.json.gz"
CACHE = UNIT_DATA_DIR / "renew_years"
HISTORY = Path("history")
TECHS = ("wind", "solar")
FIELDS = ["gw", "units", "gen", "curt", "capture", "avg", "neg", "rt_capture", "rt_avg", "hub_da", "hub_rt",
          "hub_da_gen", "hub_rt_gen", "sys_gen", "nameplate", "np_fallback"]
HUB = "HB_HUBAVG"
KINDS = ("units", "rt-prices", "da-hubs", "thermal")
WINDOW = 30     # days a unit counts as in the fleet after its last HSL (daily)
YEAR = 12       # months over which each unit's highest HSL is its size
MAXES = CACHE / "maxes"
REPO = os.environ.get("GITHUB_REPOSITORY", "CurrentTechEnergy/ERCOT-bid-explorer")


def _mean(a) -> float:
    a = np.asarray(a, float)
    a = a[np.isfinite(a)]
    return round(float(a.mean()), 2) if len(a) else None


def _hourly(v15) -> np.ndarray:
    """96 fifteen-minute prices -> 24 hourly means (nan where an hour has none)."""
    a = np.array([np.nan if x is None else x for x in v15], float).reshape(24, 4)
    n = np.isfinite(a).sum(axis=1)
    return np.where(n > 0, np.nansum(a, axis=1) / np.maximum(n, 1), np.nan)


def _weighted(p, w) -> float:
    p, w = np.asarray(p, float), np.asarray(w, float)
    ok = np.isfinite(p) & np.isfinite(w)
    return round(float((p[ok] * w[ok]).sum() / w[ok].sum()), 2) if ok.any() and w[ok].sum() > 0 else None


def summarize(units: dict, cap: dict, hub: dict) -> dict:
    """{unit: (hsl, bp, out, da, rt[, w]) arrays over the period's hours}, {unit: fleet-size MW},
    {"da", "rt": the hub average's hourly prices over the period, "gen": ERCOT generation in the
    same hours (optional), "w": hour weights (optional)} -> FIELDS.  w is each slot's hours
    (pipeline/hours.py: 2 for the fall-back Sunday's folded hour ending 2, else 1); missing, 1."""
    gen = curt = wsum = psum = neg = rsum = rpsum = 0.0
    ap, aw, rp, rw = [], [], [], []
    for v in units.values():
        hsl, bp, out, da, rt = v[:5]
        w = v[5] if len(v) > 5 else np.ones(len(out))
        o = np.clip(np.nan_to_num(out), 0, None) * w
        curt += np.nansum(np.clip(hsl - bp, 0, None) * w)
        gen += o.sum()
        ok = np.isfinite(da)
        wsum += o[ok].sum()
        psum += (o[ok] * da[ok]).sum()
        neg += o[ok & (da <= 0)].sum()
        ap.append(da[ok]); aw.append(w[ok])
        ok = np.isfinite(rt)
        rsum += o[ok].sum()
        rpsum += (o[ok] * rt[ok]).sum()
        rp.append(rt[ok]); rw.append(w[ok])
    cat = lambda xs: np.concatenate(xs) if xs else np.array([])
    hw = hub.get("w")
    if hw is None:
        hw = np.ones(len(hub.get("rt", hub.get("da", []))))
    return {"gw": round(sum(cap.values()) / 1e3, 3), "units": sum(1 for v in cap.values() if v > 0),
            "gen": round(float(gen) / 1e3, 1), "curt": round(float(curt) / 1e3, 1),
            "capture": round(float(psum / wsum), 2) if wsum else None,
            "avg": _weighted(cat(ap), cat(aw)),
            "neg": round(float(neg / wsum), 4) if wsum else None,
            "rt_capture": round(float(rpsum / rsum), 2) if rsum else None, "rt_avg": _weighted(cat(rp), cat(rw)),
            "hub_da": _weighted(hub["da"], hw) if "da" in hub else None,
            "hub_rt": _weighted(hub["rt"], hw) if "rt" in hub else None,
            "hub_da_gen": _weighted(hub["da"], hub["gen"] * hw) if "gen" in hub and "da" in hub else None,
            "hub_rt_gen": _weighted(hub["rt"], hub["gen"] * hw) if "gen" in hub and "rt" in hub else None,
            "sys_gen": round(float(np.nansum(np.where(np.isfinite(hub["rt"]), hub["gen"] * hw, 0))) / 1e3, 1)
            if "gen" in hub and "rt" in hub else None}


def _month_from_parquet(paths: dict, month: str) -> dict:
    """paths: {kind: parquet path} for the month's KINDS (rt-prices may be missing)."""
    import pandas as pd
    d = pd.read_parquet(paths["units"], columns=["date", "he", "unit", "tech", "sp", "hsl", "bp", "out", "da_node"])
    d = d[d.tech.isin(TECHS)]
    # the month's hours, with the hub prices and (with the thermal month) ERCOT generation in each
    hours = d[["date", "he"]].drop_duplicates().set_index(["date", "he"]).sort_index()
    if "rt-prices" in paths:
        rt = pd.read_parquet(paths["rt-prices"], columns=["date", "he", "point", "price"])
        hours["rt"] = rt[rt.point == HUB].set_index(["date", "he"]).price
        d = d.merge(rt.rename(columns={"point": "sp", "price": "rt"}), on=["date", "he", "sp"], how="left")
    else:
        d["rt"] = np.nan
    if "da-hubs" in paths:
        dh = pd.read_parquet(paths["da-hubs"], columns=["date", "he", "point", "price"])
        hours["da"] = dh[dh.point == HUB].set_index(["date", "he"]).price
    if "thermal" in paths:
        th = pd.read_parquet(paths["thermal"], columns=["date", "he", "out"])
        gen = pd.concat([th, d[["date", "he", "out"]]]).assign(out=lambda x: x.out.clip(lower=0))
        hours["gen"] = gen.groupby(["date", "he"]).out.sum()
    hub = {k: hours[k].to_numpy(float) for k in ("rt", "da", "gen") if k in hours}
    hub["w"] = hour_weight(hours.index.get_level_values("date"), hours.index.get_level_values("he"))
    d["w"] = hour_weight(d["date"].to_numpy(), d["he"].to_numpy())
    y, m = map(int, month.split("-"))
    scale = calendar.monthrange(y, m)[1] / max(d.date.nunique(), 1)
    out = {}
    for t in TECHS:
        g = d[d.tech == t]
        units = {u: tuple(x[c].to_numpy(float) for c in ("hsl", "bp", "out", "da_node", "rt", "w")) for u, x in g.groupby("unit")}
        cap = {u: float(np.nanmax(v[0])) if np.isfinite(v[0]).any() else 0.0 for u, v in units.items()}
        out[t] = summarize(units, cap, hub)
        out[t]["gen"], out[t]["curt"] = round(out[t]["gen"] * scale, 1), round(out[t]["curt"] * scale, 1)
    return out


def _gh(*args) -> str:
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


def _unit_maxes(units_path) -> dict:
    """{tech: {unit: highest hourly HSL, MW}} in a history units month (units with none left out)."""
    import pandas as pd
    d = pd.read_parquet(units_path, columns=["unit", "tech", "hsl"])
    d = d[d.tech.isin(TECHS) & (d.hsl > 0)]
    return {t: {u: round(float(v), 1) for u, v in d[d.tech == t].groupby("unit").hsl.max().items()} for t in TECHS}


def _fetch(a: dict) -> Path:
    path = HISTORY / a["name"]
    if not path.exists() or path.stat().st_size != a["size"]:
        HISTORY.mkdir(exist_ok=True)
        _gh("release", "download", "history", "-R", REPO, "-p", a["name"], "-D", str(HISTORY), "--clobber")
    return path


def history_months() -> tuple:
    """-> ({YYYY-MM: {tech: FIELDS}}, {YYYY-MM: {tech: {unit: highest HSL}}}) from the history
    release's units months (both cached)."""
    try:
        assets = json.loads(_gh("api", f"repos/{REPO}/releases/tags/history", "--jq",
                                '[.assets[] | select(.name | test("^(units|rt-prices|da-hubs|thermal)-[0-9]{4}-[0-9]{2}\\\\.parquet$")) | {id, name, size}]'))
    except (OSError, subprocess.CalledProcessError, ValueError) as e:
        warn(f"renew_years: can't list the history release ({e}); using cached months only")
        assets = None
    out, maxes = {}, {}
    if assets is None:
        for p in sorted(CACHE.glob("*.json.gz")):
            c = read_json_gz(p) or {}
            if _cache_ok(c, c.get("month") or ""):
                out[c["month"]] = c["techs"]
        for p in sorted(MAXES.glob("*.json.gz")):
            c = read_json_gz(p) or {}
            if c.get("month"):
                maxes[c["month"]] = c["maxes"]
        return out, maxes
    by = {}     # month -> kind -> asset
    for a in assets:
        kind, month = a["name"][:-16], a["name"][-15:-8]
        by.setdefault(month, {})[kind] = a
    for month in sorted(m for m, k in by.items() if "units" in k):
        have = by[month]
        mkey = [have["units"]["id"], have["units"]["size"]]
        c = read_json_gz(MAXES / f"{month}.json.gz")
        if c and c.get("key") == mkey:
            maxes[month] = c["maxes"]
        else:
            try:
                maxes[month] = _unit_maxes(_fetch(have["units"]))
                write_json_gz(MAXES / f"{month}.json.gz", {"month": month, "key": mkey, "maxes": maxes[month]})
            except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as e:
                warn(f"renew_years: no unit maxima for {month} ({e})")
        key = [[have[k]["id"], have[k]["size"]] if k in have else None for k in KINDS]
        c = read_json_gz(CACHE / f"{month}.json.gz")
        if c and _cache_ok(c, month) and c.get("key") == key:
            out[month] = c["techs"]
            continue
        try:
            paths = {kind: _fetch(a) for kind, a in have.items()}
            techs = _month_from_parquet(paths, month)
        except (OSError, subprocess.CalledProcessError, ValueError, KeyError) as e:
            warn(f"renew_years: skipped {month} ({e})")
            continue
        write_json_gz(CACHE / f"{month}.json.gz", {"month": month, "format": SUMMARY_FORMAT, "key": key, "techs": techs})
        out[month] = techs
    return out, maxes


def series_days() -> tuple:
    """-> (dates, {tech: {field: [day]}}, {YYYY-MM: {tech: FIELDS}} for complete months,
    {tech: {date: {unit: highest hourly HSL}}}) from the series month files.  The fleet size (gw)
    here is the period's own highest HSL; build_renew_years replaces it with the 12-month one."""
    idx = read_json_gz(DATA_DIR / "series" / "index.json.gz") or {}
    sps = {u: v[1] for u, v in (idx.get("units") or {}).items()}
    dam_hubs = (read_json_gz(DATA_DIR / "dam_hubs.json.gz") or {}).get("days") or {}
    dates, daily, months, dmaxes = [], {t: {k: [] for k in FIELDS} for t in TECHS}, {}, {}
    per = {t: {} for t in TECHS}     # tech -> month -> (dates, {unit: (hsl, bp, out, da) per day})
    for month in idx.get("months", []):
        for t in TECHS:
            f = read_json_gz(DATA_DIR / "series" / month / f"{t}.json.gz")
            if not f:
                continue
            per[t][month] = f
    all_dates = sorted({d for t in TECHS for f in per[t].values() for d in f["dates"]})
    gen = {}        # date -> 24 hourly MW of ERCOT generation (every technology but storage)
    for month in idx.get("months", []):
        for t in idx.get("techs", []):
            if t == "storage":
                continue
            f = per[t].get(month) if t in per else read_json_gz(DATA_DIR / "series" / month / f"{t}.json.gz")
            if not f:
                continue
            for v in f["units"].values():
                o = np.clip(np.nan_to_num(np.array([np.nan if x is None else x for x in v["out"]], float)), 0, None)
                for i, d in enumerate(f["dates"]):
                    gen[d] = gen.get(d, 0) + o[24 * i:24 * i + 24]
    hubs = {}       # date -> {"da", "rt": 24 hourly hub-average prices, "gen"}
    for d in all_dates:
        da = (dam_hubs.get(d) or {}).get(HUB)
        rt = ((read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz") or {}).get("spp15") or {}).get(HUB)
        hubs[d] = {"da": np.array([np.nan if x is None else x for x in da], float) if da else np.full(24, np.nan),
                   "rt": _hourly(rt) if rt and len(rt) == 96 else np.full(24, np.nan), "w": day_weights(d)}
        if d in gen:
            hubs[d]["gen"] = gen[d]
    for t in TECHS:
        # date -> {unit: (hsl, bp, out, da, rt) 24-hour arrays}
        days = {}
        for f in per[t].values():
            n = 24 * len(f["dates"])
            for u, v in f["units"].items():
                arr = {k: np.array([np.nan if x is None else x for x in v[k]], float) for k in ("hsl", "bp", "out", "da")}
                rt = (f.get("rt") or {}).get(sps.get(u))
                arr["rt"] = np.array([np.nan if x is None else x for x in rt], float) if rt else np.full(n, np.nan)
                for i, d in enumerate(f["dates"]):
                    days.setdefault(d, {})[u] = tuple(arr[k][24 * i:24 * i + 24] for k in ("hsl", "bp", "out", "da", "rt")) + (day_weights(d),)
        dmax = dmaxes[t] = {d: {u: (float(np.nanmax(x[0])) if np.isfinite(x[0]).any() else 0.0) for u, x in us.items()} for d, us in days.items()}
        for j, d in enumerate(all_dates):
            if d not in days:
                for k in FIELDS:
                    daily[t][k].append(None)
                continue
            cap = {}
            for dd in all_dates[max(0, j - WINDOW + 1):j + 1]:
                for u, m in dmax.get(dd, {}).items():
                    cap[u] = max(cap.get(u, 0.0), m)
            s = summarize(days[d], cap, hubs[d])
            if j < WINDOW - 1:      # not 30 days behind it yet: the fleet would read small
                s["gw"] = s["units"] = None
            for k in FIELDS:
                daily[t][k].append(s.get(k))
        for month in sorted({d[:7] for d in days}):
            ds = [d for d in days if d.startswith(month)]
            y, m = map(int, month.split("-"))
            if len(ds) < calendar.monthrange(y, m)[1]:
                continue
            units = {}
            for d in sorted(ds):
                for u, x in days[d].items():
                    units.setdefault(u, []).append(x)
            units = {u: tuple(np.concatenate([x[i] for x in xs]) for i in range(6)) for u, xs in units.items()}
            cap = {u: float(np.nanmax(v[0])) if np.isfinite(v[0]).any() else 0.0 for u, v in units.items()}
            hub = {k: np.concatenate([hubs[d][k] for d in sorted(ds)]) for k in ("da", "rt", "w")}
            if all("gen" in hubs[d] for d in ds):
                hub["gen"] = np.concatenate([hubs[d]["gen"] for d in sorted(ds)])
            months.setdefault(month, {})[t] = summarize(units, cap, hub)
    dates = all_dates
    return dates, daily, {m: v for m, v in months.items() if all(t in v for t in TECHS)}, dmaxes


def _prev_months(month: str, n: int) -> list:
    """The n months before YYYY-MM, oldest first."""
    y, m = map(int, month.split("-"))
    k = y * 12 + m - 1
    return [f"{(k - i) // 12}-{(k - i) % 12 + 1:02d}" for i in range(n, 0, -1)]


def _month_maxes(hmax: dict, dmaxes: dict) -> dict:
    """{tech: {YYYY-MM: {unit: highest HSL}}}: the history's months and the series' (whole or not),
    the higher where both have a unit."""
    out = {t: {} for t in TECHS}
    for m, techs in hmax.items():
        for t in TECHS:
            out[t].setdefault(m, {}).update((techs or {}).get(t) or {})
    for t in TECHS:
        for d, us in (dmaxes.get(t) or {}).items():
            mm = out[t].setdefault(d[:7], {})
            for u, v in us.items():
                if v > mm.get(u, 0.0):
                    mm[u] = v
    return out


def _year_mw(present, month: str, mmax: dict, extra: dict = None) -> dict:
    """{unit: MW}: each unit in `present` at its highest HSL over the YEAR - 1 months before
    `month` (mmax: {YYYY-MM: {unit: MW}}) and `extra` ({unit: MW}, the period's own)."""
    prev = [mmax.get(m) or {} for m in _prev_months(month, YEAR - 1)]
    extra = extra or {}
    return {u: max([extra.get(u, 0.0)] + [p.get(u, 0.0) for p in prev]) for u in present}


def cdr_mw(tech: str, peak: dict) -> dict:
    """{unit: installed MW from the CDR} for the units of `peak` ({unit: highest HSL ever}) the CDR
    has; a CDR unit several of ours match is shared by their highest HSL."""
    from .cdr import Matcher, load
    rows = [r for r in load() if r.get("mw")]
    if not rows:
        return {}
    matcher, by = Matcher(rows), {}
    for u in peak:
        r, kind = matcher.match(u, tech)
        if kind == "unit" and r.get("mw"):
            by.setdefault(r["code"], (float(r["mw"]), []))[1].append(u)
    out = {}
    for mw, us in by.values():
        tot = sum(peak[u] for u in us)
        for u in us:
            out[u] = mw * (peak[u] / tot if tot > 0 else 1 / len(us))
    return out


def _sizes(year: dict, cdr: dict) -> tuple:
    """-> (gw, nameplate, np_fallback) from {unit: 12-month HSL} and {unit: CDR MW}."""
    fb = sum(v for u, v in year.items() if u not in cdr)
    return (round(sum(year.values()) / 1e3, 3), round((sum(cdr[u] for u in year if u in cdr) + fb) / 1e3, 3),
            round(fb / 1e3, 3))


def build_renew_years(index: dict = None) -> None:
    hist, hmax = history_months()
    dates, daily, smonths, dmaxes = series_days()
    months = sorted(set(hist) | set(smonths))
    if not months and not dates:
        return
    mmax = _month_maxes(hmax, dmaxes)
    cdr = {}
    for t in TECHS:
        peak = {}
        for us in mmax[t].values():
            for u, v in us.items():
                peak[u] = max(peak.get(u, 0.0), v)
        cdr[t] = cdr_mw(t, peak)
    monthly = {t: {k: [] for k in FIELDS} for t in TECHS}
    for m in months:
        src = smonths.get(m) or hist[m]
        for t in TECHS:
            for k in FIELDS:
                monthly[t][k].append((src.get(t) or {}).get(k))
            own = mmax[t].get(m)
            if own:     # each unit in the month at its highest HSL over the month and the 11 before
                year = _year_mw([u for u, v in own.items() if v > 0], m, mmax[t], own)
                for k, v in zip(("gw", "nameplate", "np_fallback"), _sizes(year, cdr[t])):
                    monthly[t][k][-1] = v
    gw_months = [min(YEAR, len(set(_prev_months(m, YEAR - 1)) & set(months)) + 1) for m in months]
    for t in TECHS:     # daily: the units in the 30-day window, each at its highest HSL over the day's
        dm = dmaxes.get(t) or {}    # month so far and the 11 months before
        for j, d in enumerate(dates):
            if daily[t]["gw"][j] is None:
                continue
            present = {u for dd in dates[max(0, j - WINDOW + 1):j + 1] for u, v in (dm.get(dd) or {}).items() if v > 0}
            own = {}
            for dd in dates[:j + 1]:
                if dd[:7] == d[:7]:
                    for u, v in (dm.get(dd) or {}).items():
                        own[u] = max(own.get(u, 0.0), v)
            for k, v in zip(("gw", "nameplate", "np_fallback"), _sizes(_year_mw(present, d[:7], mmax[t], own), cdr[t])):
                daily[t][k][j] = v
    write_json_gz(PATH, {"format": FORMAT, "months": months, "monthly": monthly,
                         "monthly_source": ["s" if m in smonths else "h" for m in months], "gw_months": gw_months,
                         "dates": dates, "daily": daily, "cdr_edition": edition()})
    last = {t: monthly[t]["gw"][-1] for t in TECHS} if months else {}
    print(f"renew_years: {len(months)} months ({len(set(months) - set(smonths))} from the history), {len(dates)} days; "
          + ", ".join(f"{t} {v:.1f} GW" for t, v in last.items() if v is not None))


if __name__ == "__main__":
    build_renew_years()
