"""Refill price days that were loaded with gaps, reading each source in order of cost:

  1. the raw store (R2, pipeline/raw_store.py): files already downloaded once
  2. the ERCOT API: one document at a time (ErcotAPI.download), so every file fetched is kept in
     the raw store; the normal run's bulk price download keeps nothing
  3. ERCOT's website: the report's own file list, then the yearly hub and load zone workbook
     (RT: NP6-785-ER, DA: NP4-180-ER), each kept in the raw store once downloaded

Only empty slots are filled; a price already loaded is never replaced.

  real time  data/prices/<date>.json.gz spp15 (96 fifteen-minute prices per hub and load zone), the
             day's hourly means in summary_prices.json.gz, and the resource-node file on the data
             branch where the API's files carry the nodes
  day ahead  data/dam_hubs.json.gz (hubs and load zones) and data/dam_nodes.json.gz (the thermal
             nodes it keeps), for a day missing from dam_hubs

    python -m pipeline.update --refill-prices 2026-05-02 2026-05-04 2026-05-05 2026-11-02

runs it inside a normal update (the "refill_prices" input of the update workflow), so the
builders, checks, commit and deploy follow as usual.
"""
import datetime as dt
import io
import zipfile

import numpy as np
import pandas as pd
import requests

from .config import DATA_DIR, EMIL_DAM_SPP, EMIL_SPP, UNIT_DATA_DIR
from .curves import to_iso_date
from .log import warn
from .parse_prices import PRICE_POINT_TYPES, _r2, node_prices, read_spp
from .store import iter_csvs, read_json_gz, save_index, update_summary, write_json_gz
from . import dam_prices

LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId={}"
DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={}"
WEB_RT_SPP, WEB_DA_SPP = 12301, 12331          # NP6-905-CD, NP4-190-CD on the website (days only)
WEB_RT_YEAR, WEB_DA_YEAR = 13061, 13060        # NP6-785-ER, NP4-180-ER: one workbook per year
EMIL_RT_YEAR, EMIL_DA_YEAR = "np6-785-er", "np4-180-er"


# ------------------------------------------------------------------ fetching --
def _keeping(api) -> bool:
    """Files fetched from ERCOT are being kept in the raw store (ERCOT's terms limit downloading a
    report again, so nothing is fetched from ERCOT without it)."""
    return api.raw.enabled and not api.raw._failed


def _col(f, *names):
    """The first column of `f` (names normalised to lower-case letters and digits) that equals one
    of `names`, else the first that contains one."""
    for n in names:
        if n in f.columns:
            return f[n]
    for n in names:
        for c in f.columns:
            if n in c:
                return f[c]
    raise KeyError(f"none of {names} in {list(f.columns)}")


def _api_docs(api, emil, start, end, stats):
    """Every document the API lists for [start, end), each read from the raw store first."""
    blobs = []
    try:
        docs = api.list_archives(emil, start, end)
    except Exception as e:
        warn(f"refill: {emil} listing failed: {type(e).__name__}: {e}")
        return blobs
    for doc in docs:
        before = api.raw.stats["hit"]
        try:
            if not _keeping(api):
                blob = api.raw.get(emil, doc["docId"])
                if blob is None:
                    stats["skipped"] += 1
                    continue
                blobs.append(blob)
                stats["r2"] += 1
                continue
            blobs.append(api.download(emil, doc["docId"]))
        except Exception as e:
            warn(f"refill: {emil} doc {doc['docId']} failed: {type(e).__name__}: {e}")
            continue
        stats["r2" if api.raw.stats["hit"] > before else "api"] += 1
    return blobs


def _web_list(report_type):
    try:
        r = requests.get(LIST.format(report_type), timeout=120)
        r.raise_for_status()
        return [d["Document"] for d in r.json()["ListDocsByRptTypeRes"]["DocumentList"]]
    except Exception as e:
        warn(f"refill: website list {report_type} failed: {type(e).__name__}: {e}")
        return []


def _web_doc(api, emil, doc_id, stats):
    """One website document, from the raw store when it is there, else downloaded and kept."""
    blob = api.raw.get(emil, doc_id)
    if blob is not None:
        stats["r2"] += 1
        return blob
    if not _keeping(api):
        stats["skipped"] += 1
        raise RuntimeError("the raw store is not keeping files; not downloading from ERCOT's website")
    r = requests.get(DOWNLOAD.format(doc_id), timeout=600)
    r.raise_for_status()
    if r.content[:2] != b"PK":
        raise ValueError(f"document {doc_id} is not a zip")
    api.raw.put(emil, doc_id, r.content)
    stats["web"] += 1
    return r.content


def _web_day_docs(api, emil, report_type, date, lag_days, stats):
    """The website's files for one operating day of a daily report (posted from date + lag_days
    to the day after), csv only."""
    lo = dt.date.fromisoformat(date) + dt.timedelta(days=lag_days)
    hi = dt.date.fromisoformat(date) + dt.timedelta(days=1)
    blobs = []
    for d in _web_list(report_type):
        if not str(d.get("FriendlyName", "")).endswith("_csv"):
            continue
        posted = dt.date.fromisoformat(d["PublishDate"][:10])
        if lo <= posted <= hi:
            try:
                blobs.append(_web_doc(api, emil, int(d["DocID"]), stats))
            except Exception as e:
                warn(f"refill: website doc {d['DocID']} failed: {type(e).__name__}: {e}")
    return blobs


def _web_year(api, emil, report_type, year, stats):
    """The yearly workbook's sheets -> one frame (columns as in the workbook), or None."""
    doc = next((d for d in _web_list(report_type) if str(d.get("FriendlyName", "")).endswith(f"_{year}")), None)
    if doc is None:
        warn(f"refill: no {year} workbook in website report {report_type}")
        return None
    blob = _web_doc(api, emil, int(doc["DocID"]), stats)
    with zipfile.ZipFile(io.BytesIO(blob)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith((".xlsx", ".xls")))
        sheets = pd.read_excel(io.BytesIO(zf.read(name)), sheet_name=None, dtype=str)
    frames = []
    for f in sheets.values():
        if not f.empty:
            frames.append(f.rename(columns=lambda c: "".join(ch for ch in str(c).lower() if ch.isalnum())))
    return pd.concat(frames, ignore_index=True) if frames else None


# ----------------------------------------------------------------- real time --
def _rt_gaps(day):
    return sum(v is None for vals in (day.get("spp15") or {}).values() for v in vals)


def _fill_rt(day, spp, date) -> int:
    """Fill day's empty fifteen-minute hub and load zone slots from `spp` (read_spp's columns);
    -> slots filled."""
    g = spp[(spp["date"] == date) & spp["type"].isin(PRICE_POINT_TYPES)]
    if "flag" in g:
        g = g[g["flag"].astype(str).str.upper() != "Y"]
    n = 0
    for name, x in g.groupby("point"):
        vals = day["spp15"].get(name)
        if vals is None:
            continue
        idx = (x["he"].astype(int).clip(1, 24) - 1) * 4 + (x["interval"].astype(int).clip(1, 4) - 1)
        q = x.assign(i=idx.values).groupby("i")["price"].mean()
        for i, p in q.items():
            if vals[i] is None and pd.notna(p):
                vals[i] = round(float(p), 2)
                n += 1
    return n


def _fill_nodes(date, spp):
    """Fill the day's resource-node file (data branch) the same way, where it exists."""
    path = UNIT_DATA_DIR / "nodes" / f"{date}.json.gz"
    have, new = read_json_gz(path, default=None), node_prices(date, spp)
    if not have or not new:
        return
    for name, vals in new["points"].items():
        old = have["points"].get(name)
        if old is None:
            have["points"][name] = vals
        else:
            have["points"][name] = [o if o is not None else v for o, v in zip(old, vals)]
    write_json_gz(path, have)


def _rt_year_frame(f, date):
    """NP6-785-ER rows of one day -> read_spp's columns (plus the repeated-hour flag)."""
    f = f[to_iso_date(_col(f, "deliverydate")) == date]
    flag = _col(f, "repeatedhourflag", "dstflag") if any("repeat" in c or "dst" in c for c in f.columns) else "N"
    return pd.DataFrame({
        "date": date,
        "he": pd.to_numeric(_col(f, "deliveryhour", "hourending").astype(str).str.split(":").str[0], errors="coerce"),
        "interval": pd.to_numeric(_col(f, "deliveryinterval"), errors="coerce"),
        "flag": flag,
        "point": _col(f, "settlementpointname", "settlementpoint").astype(str).str.strip(),
        "type": _col(f, "settlementpointtype").astype(str).str.strip(),
        "price": pd.to_numeric(_col(f, "settlementpointprice"), errors="coerce"),
    }).dropna(subset=["he", "interval"])


def refill_rt(api, date, stats, year_cache, index=None) -> str:
    path = DATA_DIR / "prices" / f"{date}.json.gz"
    day = read_json_gz(path, default=None)
    if not day or not day.get("spp15"):
        return f"{date} RT: no day file to refill (a normal run loads missing days)"
    gaps0 = _rt_gaps(day)
    if not gaps0:
        return f"{date} RT: already complete"
    d = dt.date.fromisoformat(date)
    blobs = _api_docs(api, EMIL_SPP, dt.datetime.combine(d, dt.time()),
                      dt.datetime.combine(d + dt.timedelta(days=1), dt.time(2)), stats)
    spp = read_spp([c for b in blobs for c in iter_csvs(b, "x.zip")])
    _fill_rt(day, spp, date)
    _fill_nodes(date, spp)
    if _rt_gaps(day) and dt.date.today() - d <= dt.timedelta(days=6):
        blobs = _web_day_docs(api, EMIL_SPP, WEB_RT_SPP, date, 0, stats)
        _fill_rt(day, read_spp([c for b in blobs for c in iter_csvs(b, "x.zip")]), date)
    if _rt_gaps(day):
        if d.year not in year_cache:
            year_cache[d.year] = _web_year(api, EMIL_RT_YEAR, WEB_RT_YEAR, d.year, stats)
        if year_cache[d.year] is not None:
            _fill_rt(day, _rt_year_frame(year_cache[d.year], date), date)
    gaps1 = _rt_gaps(day)
    if gaps1 == gaps0:
        return f"{date} RT: {gaps0} empty slots, none found"
    write_json_gz(path, day)
    summ = (read_json_gz(DATA_DIR / "summary_prices.json.gz", default={}) or {}).get(date) or {}
    hourly = {}
    for name, vals in day["spp15"].items():
        a = np.array([np.nan if v is None else v for v in vals], float).reshape(24, 4)
        with np.errstate(all="ignore"):
            hourly[name] = _r2(np.nanmean(a, axis=1))
    update_summary("prices", date, {"lambda": summ.get("lambda"), "spp": hourly})
    return f"{date} RT: filled {gaps0 - gaps1} of {gaps0} empty fifteen-minute slots" + (f", {gaps1} still empty" if gaps1 else "")


# ----------------------------------------------------------------- day ahead --
def _da_complete(store, date):
    v = (store["days"].get(date) or {}).get("HB_HUBAVG")
    return bool(v) and sum(x is not None for x in v) >= 23


def refill_da(api, date, stats, year_cache, index=None) -> str:
    store = dam_prices.load()
    if _da_complete(store, date):
        return f"{date} DA: already complete"
    d = dt.date.fromisoformat(date)
    nodes = dam_prices.thermal_nodes(index) if index else set()
    sources = [lambda: _api_docs(api, EMIL_DAM_SPP, dt.datetime.combine(d - dt.timedelta(days=2), dt.time()),
                                 dt.datetime.combine(d + dt.timedelta(days=1), dt.time()), stats),
               lambda: _web_day_docs(api, EMIL_DAM_SPP, WEB_DA_SPP, date, -2, stats)]
    for get in sources:
        csvs = [c for b in get() for c in iter_csvs(b, "x.zip")]
        hubs = dam_prices.read_dam_spp(csvs)
        if date in hubs:
            dam_prices.merge(store, {date: hubs[date]})
            dam_prices.save(store)
            got = dam_prices.read_dam_spp(csvs, keep=nodes.__contains__) if nodes else {}
            if date in got:
                ns = dam_prices.load(dam_prices.NODES_PATH)
                if ns["days"] and date >= min(ns["days"]):
                    dam_prices.merge(ns, {date: got[date]})
                    dam_prices.save(ns, dam_prices.NODES_PATH)
            break
    if not _da_complete(store, date):
        key = ("da", d.year)
        if key not in year_cache:
            year_cache[key] = _web_year(api, EMIL_DA_YEAR, WEB_DA_YEAR, d.year, stats)
        f = year_cache[key]
        if f is not None:
            f = f[to_iso_date(_col(f, "deliverydate")) == date]
            days = dam_prices.frame_to_days(pd.DataFrame({
                "date": date, "he": pd.to_numeric(_col(f, "hourending", "deliveryhour").astype(str).str.split(":").str[0], errors="coerce"),
                "flag": _col(f, "repeatedhourflag", "dstflag") if any("repeat" in c or "dst" in c for c in f.columns) else "N",
                "point": _col(f, "settlementpointname", "settlementpoint").astype(str).str.strip(),
                "price": pd.to_numeric(_col(f, "settlementpointprice"), errors="coerce")}))
            if date in days:
                dam_prices.merge(store, {date: days[date]})
                dam_prices.save(store)
    return f"{date} DA: {'filled' if _da_complete(store, date) else 'still missing'}"


# ---------------------------------------------------------------------- run --
def refill_prices(api, dates, index: dict) -> None:
    """Refill RT and DA hub prices for `dates`: the raw store, then the API, then the website."""
    stats = {"r2": 0, "api": 0, "web": 0, "skipped": 0}
    if not _keeping(api):
        warn("refill: the raw store (R2) is not configured or not keeping files, so only files already "
             "in it are read; nothing is fetched from ERCOT")
    year_cache = {}
    for date in sorted(set(dates)):
        for fn in (refill_rt, refill_da):
            try:
                print(f"refill: {fn(api, date, stats, year_cache, index)}", flush=True)
            except Exception as e:     # one day's problem must not lose the rest of the run
                warn(f"refill {fn.__name__} {date}: failed: {type(e).__name__}: {e}")
    print(f"refill: files read from the raw store {stats['r2']}, from the ERCOT API {stats['api']} "
          f"(kept in the store), from ERCOT's website {stats['web']} (kept in the store); "
          f"{stats['skipped']} not fetched (raw store not keeping files)")
    if api.raw.enabled:
        print(api.raw.summary())
    save_index(index)
