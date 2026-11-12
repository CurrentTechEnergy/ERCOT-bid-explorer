"""Price cap tracker for the Prices page: how often ERCOT's hub prices reached the system-wide offer
cap, by year and by day, from 2019.  Writes data/price_cap.json.gz.

The cap in effect (16 TAC 25.509): $9,000/MWh through 2021, $5,000/MWh (HCAP) from Jan 1, 2022.
The rule's $2,000 low cap applies only after the peaker net margin passes its threshold in a year;
that has not happened since the cap moved to $5,000, so it is not modelled.  An interval is "at the
cap" when its price is at or above AT_CAP (99%) of the cap: settlement point prices add congestion
and losses to the capped price, so a hub can settle a little above or below the cap itself.

Inputs (one hub, HB_HUBAVG):
  real time   15-minute settlement point prices.  Past years from ERCOT's yearly hub and load zone
              workbook NP6-785-ER (one zip per year); from the first day of data/prices on, the
              site's own spp15 (96 prices a day).  The hourly averages elsewhere on the site hide a
              single 15-minute interval at the cap (May 8, 2024 and Jun 20, 2023 are such days), so
              the tracker counts 15-minute intervals.
  day ahead   hourly prices.  Past years from the yearly workbook NP4-180-ER; from the first day of
              data/dam_hubs.json.gz on, that file.

The yearly workbooks are read through the raw store (pipeline/raw_store.py) by fetch_hist(): a
workbook already in R2 is read from there; one that is not is downloaded from ERCOT's website only
while the store is keeping files (refill_prices._keeping), and kept.  Each year is read once into
data/price_cap_hist.json.gz, so later runs touch neither R2 nor ERCOT for past years.

    python -m pipeline.price_cap            # rebuild price_cap.json.gz from the files on hand

Files:
  price_cap_hist.json.gz  {"years": {"<year>": {"rt": [[date, max, "HH:MM" interval start], ...],
                                                 "da": [[date, max, he], ...],
                                                 "rt_hits": [[date, "HH:MM", price], ...],
                                                 "da_hits": [[date, he, price], ...],
                                                 "rt_counts": {...}, "da_counts": {...}}}}
  price_cap.json.gz       {"built", "hub", "at_cap", "caps": [{"from", "cap"}],
                           "days": {"columns": ["date", "rt_max", "rt_time", "da_max", "da_he"], "rows"},
                           "years": {"<year>": {"rt": counts, "da": counts}},
                           "hits": [[date, "rt"|"da", "HH:MM" | he, price], ...]  newest first,
                           "last": {"rt": hit or null, "da": hit or null}}
  counts: {"n" intervals (rt: 15-minute, da: hours), "at" at the cap, "half" at half the cap or more,
           "ge1000" at $1,000 or more, "max", "from", "to"}
"""
import datetime as dt
import gzip
import json
import sys

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .curves import to_iso_date
from .log import warn
from .store import read_json_gz, write_json_gz

HUB = "HB_HUBAVG"
AT_CAP = 0.99
FIRST_YEAR = 2019
CAPS = [{"from": "2019-01-01", "cap": 9000.0}, {"from": "2022-01-01", "cap": 5000.0}]
HIST = DATA_DIR / "price_cap_hist.json.gz"
HIST_V = 2          # bump to read every past year again (2: every hub and load zone, not only HUB)
OUT = DATA_DIR / "price_cap.json.gz"


def cap_on(date: str) -> float:
    c = CAPS[0]["cap"]
    for e in CAPS:
        if date >= e["from"]:
            c = e["cap"]
    return c


def _counts(dates, prices) -> dict:
    p = np.asarray(prices, float)
    ok = np.isfinite(p)
    if not ok.any():
        return {"n": 0}
    caps = np.array([cap_on(d) for d in dates], float)
    d = [x for x, k in zip(dates, ok) if k]
    return {"n": int(ok.sum()), "at": int((p[ok] >= AT_CAP * caps[ok]).sum()), "half": int((p[ok] >= 0.5 * caps[ok]).sum()),
            "ge1000": int((p[ok] >= 1000).sum()), "max": round(float(p[ok].max()), 2), "from": min(d), "to": max(d)}


def _points(f: pd.DataFrame) -> pd.DataFrame:
    return f[f.point.str.startswith(("HB_", "LZ_"))]


def summarise(frame: pd.DataFrame, market: str) -> dict:
    """frame: date, slot ("HH:MM" interval start for rt, hour ending for da), point, price.  Days and
    hits for HUB; counts for every hub and load zone; the day's highest price at any of them."""
    frame = _points(frame.dropna(subset=["price"]))
    if frame.empty:
        return {}
    slot = (lambda v: v) if market == "rt" else int
    out = {}
    f = frame[frame.point == HUB].sort_values(["date", "slot"])
    if not f.empty:
        i = f.groupby("date").price.idxmax()
        out[market] = [[r.date, round(float(r.price), 2), slot(r.slot)] for r in f.loc[i].itertuples()]
        hits = f[f.price >= AT_CAP * f.date.map(cap_on)]
        out[f"{market}_hits"] = [[r.date, slot(r.slot), round(float(r.price), 2)] for r in hits.itertuples()]
        out[f"{market}_counts"] = _counts(f.date.tolist(), f.price.to_numpy())
    out[f"{market}_points"] = {pt: _counts(g.date.tolist(), g.price.to_numpy()) for pt, g in frame.groupby("point")}
    # the highest price at any hub or load zone each day, and how many of them reached the cap
    i = frame.groupby("date").price.idxmax()
    top = frame.loc[i].set_index("date")
    at = frame[frame.price >= AT_CAP * frame.date.map(cap_on)]
    n_at = at.groupby("date").point.agg(lambda v: sorted(set(v)))
    out[f"{market}_any"] = [[d, round(float(r.price), 2), r.point, slot(r.slot), n_at.get(d, [])]
                            for d, r in top.sort_index().iterrows()]
    return out


# ------------------------------------------------------------ yearly workbooks --
def _col(f, *names):
    for n in names:
        if n in f.columns:
            return f[n]
    for n in names:
        for c in f.columns:
            if n in c:
                return f[c]
    raise KeyError(names)


def workbook_frame(f: pd.DataFrame, market: str) -> pd.DataFrame:
    """A yearly workbook (columns lower-cased letters and digits, as refill_prices._web_year gives
    them) -> date, slot, point, price for every hub and load zone."""
    pt = _col(f, "settlementpointname", "settlementpoint").astype(str).str.strip()
    f = f.assign(_pt=pt)[pt.str.startswith(("HB_", "LZ_"))]
    he = pd.to_numeric(_col(f, "deliveryhour", "hourending").astype(str).str.split(":").str[0], errors="coerce")
    out = pd.DataFrame({"date": to_iso_date(_col(f, "deliverydate")), "he": he, "point": f["_pt"],
                        "price": pd.to_numeric(_col(f, "settlementpointprice"), errors="coerce")})
    if market == "rt":
        k = pd.to_numeric(_col(f, "deliveryinterval"), errors="coerce")
        out["slot"] = [f"{int(h) - 1:02d}:{(int(q) - 1) * 15:02d}" if np.isfinite(h) and np.isfinite(q) else None
                       for h, q in zip(he, k)]
    else:
        out["slot"] = he
    return out.dropna(subset=["slot", "date"])[["date", "slot", "point", "price"]]


def fetch_hist(api, last_year: int = None) -> None:
    """Read any past year missing from price_cap_hist.json.gz from the yearly workbooks, through the
    raw store (refill_prices._web_year: R2 first; ERCOT's website only while the store keeps files)."""
    from .refill_prices import EMIL_DA_YEAR, EMIL_RT_YEAR, WEB_DA_YEAR, WEB_RT_YEAR, _keeping, _web_year
    hist = read_json_gz(HIST, default=None) or {"years": {}}
    last_year = last_year or dt.date.today().year - 1
    missing = [y for y in range(FIRST_YEAR, last_year + 1) if (hist["years"].get(str(y)) or {}).get("v") != HIST_V]
    if not missing:
        return
    if not api.raw.enabled:
        warn("price cap: the raw store (R2) is not configured; past years not read")
        return
    if not _keeping(api):
        warn("price cap: the raw store is not keeping files, so only workbooks already in it are read")
    stats = {"r2": 0, "api": 0, "web": 0, "skipped": 0}
    for y in missing:
        entry = {"v": HIST_V}
        try:
            for market, emil, rtype in (("rt", EMIL_RT_YEAR, WEB_RT_YEAR), ("da", EMIL_DA_YEAR, WEB_DA_YEAR)):
                f = _web_year(api, emil, rtype, y, stats)
                if f is None:
                    raise ValueError(f"no {market} workbook")
                entry.update(summarise(workbook_frame(f, market), market))
        except Exception as e:      # a year that fails stays missing and is tried again next run
            warn(f"price cap {y}: {type(e).__name__}: {e}")
            continue
        hist["years"][str(y)] = entry
        write_json_gz(HIST, hist)
        print(f"price cap: {y} read ({entry['rt_counts']['n']} real-time intervals, {entry['da_counts']['n']} day-ahead hours)", flush=True)
    print(f"price cap: workbooks from the raw store {stats['r2']}, from ERCOT's website {stats['web']} (kept in the store), "
          f"{stats['skipped']} not fetched", flush=True)


# ---------------------------------------------------------------- site files --
def site_frames(first_rt: str = None, first_da: str = None):
    """Real-time 15-minute and day-ahead hourly hub and load zone prices from the site's own files, for
    days after the history (first_* exclusive)."""
    rows = []
    for p in sorted((DATA_DIR / "prices").glob("*.json.gz")):
        d = p.name[:10]
        if first_rt and d <= first_rt:
            continue
        j = read_json_gz(p, default=None) or {}
        for pt, v in (j.get("spp15") or {}).items():
            rows += [(d, f"{i // 4:02d}:{i % 4 * 15:02d}", pt, x) for i, x in enumerate(v or []) if x is not None]
    rt = pd.DataFrame(rows, columns=["date", "slot", "point", "price"])
    dh = (read_json_gz(DATA_DIR / "dam_hubs.json.gz", default=None) or {}).get("days") or {}
    rows = [(d, i + 1, pt, x) for d, day in dh.items() if not first_da or d > first_da
            for pt, v in day.items() for i, x in enumerate(v or []) if x is not None]
    return rt, pd.DataFrame(rows, columns=["date", "slot", "point", "price"])


def _add(old: dict, c: dict) -> dict:
    """Counts for a year split between a workbook and the site's files, added up."""
    if not old.get("n"):
        return c
    if not c.get("n"):
        return old
    return {"n": old["n"] + c["n"], "at": old["at"] + c["at"], "half": old["half"] + c["half"],
            "ge1000": old["ge1000"] + c["ge1000"], "max": max(old["max"], c["max"]),
            "from": min(old["from"], c["from"]), "to": max(old["to"], c["to"])}


def build(hist: dict = None) -> dict:
    hist = hist if hist is not None else (read_json_gz(HIST, default=None) or {"years": {}})
    day = {"rt": {}, "da": {}}          # HUB: date -> (max, slot)
    anyp = {"rt": {}, "da": {}}         # any hub or load zone: date -> (max, point, slot, [points at the cap])
    hits, years = [], {}
    last = {"rt": "", "da": ""}

    def take(y, e):
        for m in ("rt", "da"):
            for d, p, t in e.get(m, []):
                day[m][d] = (p, t)
                last[m] = max(last[m], d)
            for d, p, pt, t, at in e.get(f"{m}_any", []):
                anyp[m][d] = (p, pt, t, at)
            hits.extend([d, m, t, p] for d, t, p in e.get(f"{m}_hits", []))
            yr = years.setdefault(y, {"rt": {}, "da": {}, "points": {"rt": {}, "da": {}}})
            yr[m] = _add(yr[m], e.get(f"{m}_counts", {}))
            for pt, c in e.get(f"{m}_points", {}).items():
                yr["points"][m][pt] = _add(yr["points"][m].get(pt, {}), c)

    for y in sorted(hist["years"]):
        take(y, hist["years"][y])
    rt, da = site_frames(last["rt"] or None, last["da"] or None)
    for m, f in (("rt", rt), ("da", da)):
        if not f.empty:
            for y, g in f.assign(year=f.date.str[:4]).groupby("year"):
                take(y, summarise(g, m))
    dates = sorted(set(day["rt"]) | set(day["da"]) | set(anyp["rt"]) | set(anyp["da"]))
    nil = (None, None)
    rows = [[d, *(day["rt"].get(d) or nil), *(day["da"].get(d) or nil),
             *((anyp["rt"].get(d) or (None,) * 4)[:2]), len((anyp["rt"].get(d) or (0, 0, 0, []))[3]),
             *((anyp["da"].get(d) or (None,) * 4)[:2]), len((anyp["da"].get(d) or (0, 0, 0, []))[3])] for d in dates]
    # days a hub or load zone reached the cap while HUB did not, newest first
    local = sorted(([d, m, a[0], a[1], a[2], a[3]] for m in ("rt", "da") for d, a in anyp[m].items()
                    if a[3] and HUB not in a[3]), reverse=True)
    hits.sort(key=lambda h: (h[0], str(h[2])), reverse=True)
    out = {"built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "hub": HUB, "at_cap": AT_CAP, "caps": CAPS,
           "days": {"columns": ["date", "rt_max", "rt_time", "da_max", "da_he",
                                "rt_any_max", "rt_any_point", "rt_any_at", "da_any_max", "da_any_point", "da_any_at"], "rows": rows},
           "years": {y: years[y] for y in sorted(years)}, "hits": hits,
           "local": {"columns": ["date", "market", "max", "point", "time", "points_at_cap"], "rows": local},
           "last": {m: next((h for h in hits if h[1] == m), None) for m in ("rt", "da")},
           "last_any": {m: next(([r[0], r[4], r[2], r[3]] for r in sorted(
               ([d, m, a[0], a[1], a[2]] for d, a in anyp[m].items() if a[3]), reverse=True)), None) for m in ("rt", "da")}}
    write_json_gz(OUT, out)
    lr = out["last"]["rt"]
    print(f"price cap: {len(rows)} days, {len(hits)} {HUB} intervals at the cap, {len(local)} days only a hub or load zone did; "
          f"last real-time {lr[0] + ' ' + lr[2] if lr else 'none'}", flush=True)
    return out


if __name__ == "__main__":
    build()
