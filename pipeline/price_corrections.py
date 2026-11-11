"""Apply ERCOT's price corrections to the prices the site already holds.

When ERCOT corrects a settlement point price it does not post the price report again.  The fix
comes in separate reports, one file per correction run:

  NP4-197-M  RTM Price Corrections (website report type 13045): 15-minute settlement point
             prices, files named pricecorrection_RTM_SPP_*; columns DeliveryDate, DeliveryHour,
             DeliveryInterval, SettlementPointName, SettlementPointType, SPPOriginal,
             SPPCorrected, PriceCorrectionTime, DSTFlag
  NP4-196-M  DAM Price Corrections (website report type 13044): hourly day-ahead settlement point
             prices, files named pricecorrection_DAM_SPP_*

The other files in these reports (LMPs, MCPCs, shadow prices, settlement-only generator prices)
are not read: the site keeps none of those from the corrected reports.  System lambda is never
corrected through them.

Each run:
  1. lists both reports on ERCOT's website (the list keeps about six months of files);
  2. downloads each settlement point price file not seen before, once: the raw store
     (pipeline/raw_store.py) is read first, and a file downloaded from ERCOT is kept there.
     Nothing is downloaded from ERCOT unless the raw store is keeping files;
  3. applies every correction file seen so far, new and old, reading old ones from the raw store
     only.  Applying is idempotent, so a price day that was loaded or reloaded after its
     correction (a late day, a node-file format change) gets the correction too.

A stored price is replaced only where it still equals ERCOT's original value (or the mean of the
original values, where the file averages several rows into one cell).  Where it already equals
the corrected value it is left alone; where it equals neither, it is left alone and counted, as a
cell that was loaded from some other source.  Files are written only when a value changes, so the
memoized builders rerun only after a real correction.

  real time   data/prices/<date>.json.gz spp15 (hubs and load zones) and the day's hourly means in
              summary_prices.json.gz; the resource-node file <UNIT_DATA_DIR>/nodes/<date>.json.gz
  day ahead   data/dam_hubs.json.gz and data/dam_nodes.json.gz (the repeated hour of the fall-back
              day is dropped there, so its corrections are too)

What was changed is logged in data/price_corrections.json.gz:
  {"docs": {doc id: {"report", "posted", "name", "days": [...], "stored": bool}},
   "days": {date: {"rt"|"da": {"docs": [...], "hub_cells", "node_cells", "max_hub_change",
                               "other_cells"}}}}

    python -m pipeline.price_corrections          # list, fetch and apply (the update run calls apply_all)
"""
import datetime as dt
import io
import re

import numpy as np
import pandas as pd
import requests

from .config import DATA_DIR, PRICE_POINT_TYPES, UNIT_DATA_DIR
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs, read_json_gz, update_summary, write_json_gz
from . import dam_prices

LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId={}"
DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={}"
REPORTS = {          # market -> (raw store / index name, website report type id, file name pattern)
    "rt": ("np4-197-m", 13045, re.compile(r"pricecorrection_RTM_SPP_.*_csv$", re.I)),
    "da": ("np4-196-m", 13044, re.compile(r"pricecorrection_DAM_SPP_.*_csv$", re.I)),
}
LOG_PATH = DATA_DIR / "price_corrections.json.gz"
TOL = 0.006          # prices are kept to the cent: within this, two values are the same


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


# ------------------------------------------------------------------ reading --
def read_corrections(blob: bytes) -> pd.DataFrame:
    """A correction zip -> rows date, he (1..24), interval (1..4, or 0 for hourly), point, type,
    dst ("Y"/"N"), orig, corr.  Raises ValueError when no CSV in it has the expected columns."""
    frames = []
    for name, b in iter_csvs(blob, "x.zip"):
        f = pd.read_csv(io.BytesIO(b))
        c = {_norm(k): k for k in f.columns}

        def col(*names, contains=None):
            for n in names:
                if n in c:
                    return c[n]
            if contains:
                return next((v for k, v in c.items() if contains in k), None)
            return None
        date, hour = col("deliverydate"), col("deliveryhour", "hourending")
        point = col("settlementpointname", "settlementpoint")
        orig, corr = col("spporiginal", contains="original"), col("sppcorrected", contains="corrected")
        if None in (date, hour, point, orig, corr):
            continue
        iv, typ, dst = col("deliveryinterval"), col("settlementpointtype"), col("dstflag", "repeatedhourflag")
        frames.append(pd.DataFrame({
            "date": to_iso_date(f[date].astype(str)),
            "he": pd.to_numeric(f[hour].astype(str).str.split(":").str[0], errors="coerce"),
            "interval": pd.to_numeric(f[iv], errors="coerce") if iv else 0,
            "point": f[point].astype(str).str.strip(),
            "type": f[typ].astype(str).str.strip() if typ else "",
            "dst": f[dst].astype(str).str.strip().str.upper() if dst else "N",
            "orig": pd.to_numeric(f[orig], errors="coerce"),
            "corr": pd.to_numeric(f[corr], errors="coerce"),
        }))
    if not frames:
        raise ValueError("no settlement point price correction CSV in the file")
    d = pd.concat(frames, ignore_index=True).dropna(subset=["he", "orig", "corr"])
    d["he"] = d["he"].astype(int)
    d["interval"] = d["interval"].fillna(0).astype(int)
    return d[(d["he"] >= 1) & (d["he"] <= 24)]


# ----------------------------------------------------------------- applying --
def _patch(series: list, cells: pd.DataFrame) -> tuple:
    """Correct one point's list of prices in place.  `cells` holds that point's correction rows,
    with each row's index in the list in column "slot".  Rows that share a slot (several
    settlement point types, or both copies of a repeated hour) are averaged, as the price files
    average them.  -> (cells changed, largest absolute change, cells that matched neither value)"""
    changed, biggest, other = 0, 0.0, 0
    means = cells.groupby("slot")[["orig", "corr"]].mean()
    for i, (o, c) in zip(means.index, means.values):
        if not 0 <= i < len(series):
            continue
        old, o, c = series[i], round(float(o), 2), round(float(c), 2)
        if old is None or abs(old - c) < TOL:
            continue
        if abs(old - o) < TOL:
            series[i] = c
            changed += 1
            biggest = max(biggest, abs(c - old))
        else:
            other += 1
    return changed, biggest, other


def _hourly(vals: list) -> list:
    a = np.array([np.nan if v is None else v for v in vals], float).reshape(24, 4)
    with np.errstate(all="ignore"):
        m = np.nanmean(a, axis=1)
    return [None if np.isnan(v) else round(float(v), 2) for v in m]


def _entry(log_days: dict, date: str, market: str, doc_id) -> dict:
    entry = log_days.setdefault(date, {}).setdefault(market, {"docs": [], "hub_cells": 0, "node_cells": 0,
                                                              "max_hub_change": 0.0, "other_cells": 0})
    if str(doc_id) not in entry["docs"]:
        entry["docs"].append(str(doc_id))
    return entry


def apply_rt(rows: pd.DataFrame, log_days: dict, doc_id, fresh: bool) -> None:
    """Real-time corrections: site day files (hubs and load zones) and node files.  Cells that
    match neither value are counted only on a file's first application (`fresh`)."""
    rows = rows[(rows["interval"] >= 1) & (rows["interval"] <= 4)]
    rows = rows.assign(slot=(rows["he"] - 1) * 4 + rows["interval"] - 1)
    for date, day_rows in rows.groupby("date"):
        entry = _entry(log_days, date, "rt", doc_id)
        hub_rows = day_rows[day_rows["type"].isin(PRICE_POINT_TYPES)]
        node_rows = day_rows[~day_rows["type"].isin(PRICE_POINT_TYPES)]

        path = DATA_DIR / "prices" / f"{date}.json.gz"
        day = read_json_gz(path) if path.exists() else None
        if day and not hub_rows.empty:
            touched = []
            for point, g in hub_rows.groupby("point"):
                s = (day.get("spp15") or {}).get(point)
                if not s:
                    continue
                n, big, other = _patch(s, g)
                entry["hub_cells"] += n
                entry["other_cells"] += other if fresh else 0
                entry["max_hub_change"] = round(max(entry["max_hub_change"], big), 2)
                if n:
                    touched.append(point)
            if touched:
                write_json_gz(path, day)
                summ = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={}).get(date)
                if summ is not None:
                    for point in touched:
                        summ.setdefault("spp", {})[point] = _hourly(day["spp15"][point])
                    update_summary("prices", date, summ)
                print(f"  price corrections {date}: real-time {', '.join(sorted(touched))} corrected")

        npath = UNIT_DATA_DIR / "nodes" / f"{date}.json.gz"
        nodes = read_json_gz(npath) if npath.exists() else None
        if nodes and not node_rows.empty:
            n_all = 0
            for point, g in node_rows.groupby("point"):
                s = (nodes.get("points") or {}).get(point)
                if not s or len(s) != 96:
                    continue
                n, _, other = _patch(s, g)
                n_all += n
                entry["other_cells"] += other if fresh else 0
            entry["node_cells"] += n_all
            if n_all:
                write_json_gz(npath, nodes)
                print(f"  price corrections {date}: {n_all} real-time node price(s) corrected")


def apply_da(rows: pd.DataFrame, log_days: dict, doc_id, fresh: bool) -> None:
    """Day-ahead corrections: dam_hubs (hubs and load zones) and dam_nodes."""
    rows = rows[rows["dst"] != "Y"]          # the stores drop the repeated hour
    rows = rows.assign(slot=rows["he"] - 1)
    for path, keep, key in ((dam_prices.PATH, lambda p: p.startswith(("HB_", "LZ_")), "hub_cells"),
                            (dam_prices.NODES_PATH, lambda p: not p.startswith(("HB_", "LZ_")), "node_cells")):
        store = dam_prices.load(path)
        dirty = False
        for date, day_rows in rows.groupby("date"):
            entry = _entry(log_days, date, "da", doc_id)
            have = store["days"].get(date)
            if not have:
                continue
            for point, g in day_rows[day_rows["point"].map(keep)].groupby("point"):
                s = have.get(point)
                if not s:
                    continue
                n, big, other = _patch(s, g)
                entry[key] += n
                entry["other_cells"] += other if fresh else 0
                if key == "hub_cells":
                    entry["max_hub_change"] = round(max(entry["max_hub_change"], big), 2)
                dirty |= bool(n)
        if dirty:
            dam_prices.save(store, path)
            print(f"  price corrections: day-ahead prices corrected in {path.name}")


# ----------------------------------------------------------------- fetching --
def _list(report_type: int) -> list:
    r = requests.get(LIST.format(report_type), timeout=120)
    r.raise_for_status()
    return [d["Document"] for d in r.json()["ListDocsByRptTypeRes"]["DocumentList"]]


def apply_all(api, index: dict) -> None:
    """List, fetch new correction files once, then apply every one seen so far."""
    raw = api.raw
    fresh = set()       # docs applied from a fresh read this run
    log = read_json_gz(LOG_PATH, default=None) or {"docs": {}, "days": {}}
    known = index.setdefault("docs", {})
    for market, (emil, report_type, pattern) in REPORTS.items():
        done = known.setdefault(emil, [])
        try:
            listed = [d for d in _list(report_type) if pattern.search(d.get("FriendlyName", ""))]
        except Exception as e:     # a listing problem only means no new corrections this run
            warn(f"price corrections {market}: listing ERCOT's {emil} files failed: {type(e).__name__}: {e}")
            listed = []
        new = sorted((d for d in listed if int(d["DocID"]) not in done), key=lambda d: d.get("PublishDate", ""))
        if new and not (raw.enabled and not raw._failed):
            warn(f"price corrections {market}: {len(new)} new file(s) on ERCOT not fetched: the raw store "
                 "is not keeping files, and ERCOT limits downloading a report again")
            new = []
        for d in new:
            doc_id = int(d["DocID"])
            blob = raw.get(emil, doc_id)
            if blob is None:
                try:
                    r = requests.get(DOWNLOAD.format(doc_id), timeout=300)
                    r.raise_for_status()
                    blob = r.content
                except Exception as e:
                    warn(f"price corrections {market}: download of doc {doc_id} failed: {type(e).__name__}: {e}")
                    continue
                if blob[:2] != b"PK":
                    warn(f"price corrections {market}: doc {doc_id} was not a zip; skipped this run")
                    continue
                before = raw.stats["stored"]
                raw.put(emil, doc_id, blob, {"postDatetime": d.get("PublishDate"),
                                             "friendlyName": d.get("FriendlyName"),
                                             "constructedName": d.get("ConstructedName")})
                stored = raw.stats["stored"] > before
                if not stored:
                    warn(f"price corrections {market}: doc {doc_id} downloaded but not kept in the raw store; "
                         "it is applied this run and not downloaded again")
            else:
                stored = True
            try:
                rows = read_corrections(blob)
            except Exception as e:     # not recorded as done: the next run reads it from the store again
                warn(f"price corrections {market}: doc {doc_id} ({d.get('FriendlyName')}) not read: "
                     f"{type(e).__name__}: {e}")
                continue
            done.append(doc_id)
            log["docs"][str(doc_id)] = {"report": emil, "posted": d.get("PublishDate", "")[:19],
                                        "name": d.get("FriendlyName", ""), "stored": stored,
                                        "days": sorted(rows["date"].unique())}
            print(f"price corrections {market}: new file {d.get('FriendlyName')} (doc {doc_id}), "
                  f"operating day(s) {', '.join(log['docs'][str(doc_id)]['days'])}")
            (apply_rt if market == "rt" else apply_da)(rows, log["days"], doc_id, True)
            fresh.add(doc_id)

    # every file seen before, again from the raw store only: catches price days loaded since
    for doc_id, meta in sorted(log["docs"].items(), key=lambda kv: kv[1].get("posted", "")):
        if int(doc_id) in fresh or not meta.get("stored"):
            continue
        blob = raw.get(meta["report"], int(doc_id))
        if blob is None:
            continue
        try:
            rows = read_corrections(blob)
        except Exception as e:
            warn(f"price corrections: stored doc {doc_id} not read: {type(e).__name__}: {e}")
            continue
        (apply_rt if meta["report"] == REPORTS["rt"][0] else apply_da)(rows, log["days"], doc_id, False)

    log["days"] = dict(sorted(log["days"].items()))
    if log["docs"] or LOG_PATH.exists():
        old = read_json_gz(LOG_PATH, default=None)
        if old != log:
            write_json_gz(LOG_PATH, log)


if __name__ == "__main__":
    from .ercot_api import ErcotAPI
    from .store import load_index, save_index
    idx = load_index()
    apply_all(ErcotAPI(), idx)
    save_index(idx)
