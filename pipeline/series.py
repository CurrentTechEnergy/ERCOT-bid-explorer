"""Hourly series for every unit, for the graph builder (site/builder.html).  Needs no downloads.

The per-unit day files on the data branch hold everything at SCED-run resolution and are about
4 MB a day, too heavy for a browser.  This reduces each 60-day day to one value per unit, hour
and field, and writes them a month and a technology at a time, so a chart of one plant over a
week loads one or two small files.

Fields, hourly (hour ending 1..24 at positions 0..23), null where unknown:
  hsl        mean HSL over the runs the unit was online; null in hours it was mostly off
             (nodes.hourly_hsl)
  bp         mean SCED base point (MW)
  out        mean telemetered net output (MW; storage is negative while charging)
  off_first  first price of the submitted offer curve, median over the hour's online runs
             ($/MWh): for wind and solar the price of the whole offer, for thermal units
             usually the price on minimum output
  off_mid    price at half the submitted curve's MW, median over the hour (ppa._mid_price)
  off_bp     price the submitted curve puts on that run's base point, median over the hour:
             what the unit asked for the last MW it was dispatched
  directed   MW an ERCOT operator took off the unit's HDL by manual override (hourly mean)
  award      DAM energy award (MW)
  da         DAM settlement point price at the unit's settlement point ($/MWh)
and, per settlement point, `rt`: the real-time price at the unit's resource node (hourly mean
of the 15-minute prices; data branch nodes/).

Day caches (UNIT_DATA_DIR/series/YYYY-MM-DD.json.gz) are keyed on the sizes of the files they
were built from, like the ppa cache, so a run only redoes new or reprocessed days.  Written:
  data/series/index.json.gz   {format, fields, months: [YYYY-MM], dates, techs,
                               units: {name: [tech, settlement point or null, capacity MW]}}
  data/series/YYYY-MM/<tech>.json.gz
                              {month, dates, fields, units: {name: {field: [24 x days]}},
                               rt: {settlement point: [24 x days]}}
Capacity is the unit's highest hourly HSL over the loaded days (for the picker only).
"""
import os

import numpy as np

from .config import DATA_DIR, SIXTY_DAY_TECHS, UNIT_DATA_DIR
from .intraday import _online
from .nodes import hourly_hsl
from .parse_prices import node_hourly
from .ppa import _mid_price
from .store import read_json_gz, write_json_gz
from .units import _ffill_index

CACHE_FORMAT = 1
FIELDS = ("hsl", "bp", "out", "off_first", "off_mid", "off_bp", "directed", "award", "da")
MW_FIELDS = ("hsl", "bp", "out", "directed", "award")


def _r(x, nd):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _price_at(p, mw, q) -> float:
    """Price a piecewise-linear curve puts on q MW (first price below, last price above)."""
    if q is None or not np.isfinite(q) or len(p) == 0:
        return np.nan
    if q <= mw[0]:
        return float(p[0])
    if q >= mw[-1]:
        return float(p[-1])
    if np.any(np.diff(mw) < 0):
        return np.nan
    return float(np.interp(q, mw, p))


def hourly_offers_all(u: dict, runs: list) -> dict:
    """{off_first, off_mid, off_bp}: hourly medians over the runs a unit is online with a
    submitted curve."""
    n = len(runs)
    hr = np.minimum(np.array(runs) // 60, 23)
    si = _ffill_index(u["status"], n)
    ci = _ffill_index(u.get("curve") or [], n)
    li = _ffill_index(u["lim"], n)
    bp = np.full(n, np.nan)
    if u.get("disp"):
        di = _ffill_index(u["disp"], n)
        bp = np.array([u["disp"][i][1] if i >= 0 and u["disp"][i][1] is not None else np.nan for i in di], float)
    first, mid, at_bp = (np.full(n, np.nan) for _ in range(3))
    cache = {}
    for r in range(n):
        i, s, li_r = ci[r], si[r], li[r]
        if i < 0 or s < 0 or not _online(u["status"][s][1]):
            continue
        ev = u["curve"][i]
        if ev[1] is None or not ev[1]:
            continue
        key = (i, li_r)
        if key not in cache:
            p = np.asarray(ev[1], float)
            m = np.asarray(ev[2], float)
            if u.get("frac"):
                hsl = u["lim"][li_r][1] if li_r >= 0 and u["lim"][li_r][1] is not None else 0.0
                m = m * hsl
            cache[key] = (p, m, _mid_price(p, m))
        p, m, mp = cache[key]
        first[r], mid[r], at_bp[r] = p[0], mp, _price_at(p, m, bp[r])
    out = {}
    for k, v in (("off_first", first), ("off_mid", mid), ("off_bp", at_bp)):
        vals = [None] * 24
        for h in range(24):
            x = v[hr == h]
            x = x[np.isfinite(x)]
            if len(x):
                vals[h] = _r(np.median(x), 2)
        out[k] = vals
    return out


def _src_key(date: str, dam_days: set, node_days: set) -> list:
    """Sizes of the files a day cache is built from (0 when absent)."""
    def size(p):
        return p.stat().st_size if p.exists() else 0
    return [size(UNIT_DATA_DIR / "60d" / f"{date}.json.gz"),
            size(UNIT_DATA_DIR / "nodes" / f"{date}.json.gz") if date in node_days else 0,
            size(DATA_DIR / "dam" / f"{date}.json.gz") if date in dam_days else 0]


def day_series(date: str, key: list) -> dict:
    """{units: {name: {tech, sp, field: [24]}}, rt: {sp: [24]}} for one 60-day day, cached."""
    from .history import _directed, _to24      # history imports update, which imports this module

    path = UNIT_DATA_DIR / "series" / f"{date}.json.gz"
    cached = read_json_gz(path)
    if cached and cached.get("format") == CACHE_FORMAT and cached.get("key") == key:
        return cached
    ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{date}.json.gz")
    if not ud:
        return {}
    dam = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz") if key[2] else None
    du = (dam or {}).get("units") or {}
    hours = (dam or {}).get("hours", 24)
    nodes = node_hourly(read_json_gz(UNIT_DATA_DIR / "nodes" / f"{date}.json.gz")) if key[1] else {}
    over = ud.get("overrides") or {}
    runs = ud["runs"]
    units, rt = {}, {}
    for name, u in ud["units"].items():
        d = du.get(name) or {}
        sp = d.get("sp")
        rec = {"tech": u.get("tech") if u.get("tech") in SIXTY_DAY_TECHS else "other", "sp": sp,
               "hsl": [_r(v, 1) for v in hourly_hsl(u, runs)],
               "bp": [_r(v, 1) if v is not None else None for v in (u.get("bp") or [None] * 24)],
               "out": [_r(v, 1) if v is not None else None for v in (u.get("out") or [None] * 24)],
               **hourly_offers_all(u, runs),
               "directed": [_r(v, 1) for v in _directed(over.get(name))],
               "award": [_r(v, 1) if v is not None else None for v in _to24(d.get("award"), hours)],
               "da": [_r(v, 2) if v is not None else None for v in _to24(d.get("spp"), hours)]}
        units[name] = rec
        if sp and sp in nodes and sp not in rt:
            rt[sp] = (list(nodes[sp]) + [None] * 24)[:24]
    day = {"date": date, "format": CACHE_FORMAT, "key": key, "units": units, "rt": rt}
    write_json_gz(path, day)
    return day


def _fill(args):
    date, key = args
    day_series(date, key)


def build_series(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    dam_days = set(index["days"].get("dam", []))
    node_days = set(index["days"].get("nodes", []))
    keys = {d: _src_key(d, dam_days, node_days) for d in dates}
    dates = [d for d in dates if keys[d][0]]      # days with a per-unit day file

    def stale(d):
        c = read_json_gz(UNIT_DATA_DIR / "series" / f"{d}.json.gz")
        return not c or c.get("format") != CACHE_FORMAT or c.get("key") != keys[d]

    todo = [d for d in dates if stale(d)]
    if todo:
        from concurrent.futures import ProcessPoolExecutor
        print(f"series: building hourly unit series for {len(todo)} day(s)")
        with ProcessPoolExecutor(max_workers=os.cpu_count() or 2) as ex:
            list(ex.map(_fill, [(d, keys[d]) for d in todo]))

    months = sorted({d[:7] for d in dates})
    meta = {}        # name -> [tech, sp, capacity]
    out_dir = DATA_DIR / "series"
    for month in months:
        md = [d for d in dates if d[:7] == month]
        D = len(md)
        by_tech, rt = {}, {}
        for di, d in enumerate(md):
            day = read_json_gz(UNIT_DATA_DIR / "series" / f"{d}.json.gz") or {}
            for sp, v in (day.get("rt") or {}).items():
                rt.setdefault(sp, [None] * (24 * D))[di * 24:(di + 1) * 24] = v
            for name, u in (day.get("units") or {}).items():
                t = u["tech"]
                rec = by_tech.setdefault(t, {}).get(name)
                if rec is None:
                    rec = by_tech[t][name] = {k: [None] * (24 * D) for k in FIELDS}
                for k in FIELDS:
                    rec[k][di * 24:(di + 1) * 24] = u[k]
                m = meta.setdefault(name, [t, None, None])
                m[1] = u.get("sp") or m[1]
                peak = max((v for v in u["hsl"] if v is not None), default=None)
                if peak is not None and (m[2] is None or peak > m[2]):
                    m[2] = peak
        for t in SIXTY_DAY_TECHS:
            us = by_tech.get(t)
            if not us:
                continue
            sps = {meta[n][1] for n in us if meta[n][1]}
            write_json_gz(out_dir / month / f"{t}.json.gz", {
                "month": month, "dates": md, "fields": list(FIELDS),
                "units": dict(sorted(us.items())),
                "rt": {sp: v for sp, v in sorted(rt.items()) if sp in sps}})
    write_json_gz(out_dir / "index.json.gz", {
        "format": CACHE_FORMAT, "fields": list(FIELDS), "months": months, "dates": dates,
        "techs": {t: sorted(n for n, m in meta.items() if m[0] == t) for t in SIXTY_DAY_TECHS},
        "units": dict(sorted(meta.items()))})
    print(f"series: {len(dates)} days in {len(months)} month(s), {len(meta)} units")
