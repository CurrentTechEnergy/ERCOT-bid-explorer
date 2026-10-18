"""Day-ahead settlement point prices (NP4-190-CD, "DAM Settlement Point Prices"), hourly.

Hubs and load zones, for the PPA guesser (pipeline/ppa.py).  The 60-day DAM disclosure already
gives each unit's own node DA price; this adds the hubs and load zones a hedge could settle at.
Writes data/dam_hubs.json.gz:
  {"points": [HB_..., LZ_...], "days": {date: {point: [24 x $/MWh or null]}}}
Hours are hour ending 1..24 stored at index 0..23; on the fall-back day the repeated hour is
dropped (as in the per-unit day files, which average it into one).

Thermal, wind and solar resource nodes for the most recent days, for tomorrow's shutdown
verdicts (pipeline/decisions.py) and the Overview's forecast (pipeline/forecast): the report
for operating day D is posted around 13:30 Central on D - 1, sixty days before the disclosure
gives the units' own prices.  Only the settlement points of units in the latest DAM disclosure
files are kept, and only the last NODE_DAYS days.  Writes data/dam_nodes.json.gz in the same
shape; the hub and load-zone prices in the same files go into data/dam_hubs.json.gz, so the
hub history runs up to tomorrow rather than stopping at the 60-day days.

History before the API backfill reaches it can be loaded from ERCOT's yearly file of DAM hub and
load zone prices (NP4-180-ER, an .xlsx with one sheet per month):
  python -m pipeline.dam_prices rpt.00013060...DAMLZHBSPP_2026.xlsx
"""
import datetime as dt
import io
import sys
from typing import Iterable, Tuple

from zoneinfo import ZoneInfo

import pandas as pd

from .config import DATA_DIR, EMIL_DAM_SPP
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs, read_json_gz, write_json_gz

PATH = DATA_DIR / "dam_hubs.json.gz"
NODES_PATH = DATA_DIR / "dam_nodes.json.gz"
MAX_MISSES = 3
NODE_DAYS = 14        # days of thermal node prices kept
NODE_FROM_DAM = 5     # latest DAM disclosure files the thermal node list is read from
CENTRAL = ZoneInfo("America/Chicago")
DAM_POSTED = dt.time(14, 0)   # Central, on D - 1: ERCOT's 13:30 deadline plus a margin.  A day
                              # not found before then is not a miss, since it cannot be posted yet


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _keep(point: str) -> bool:
    return point.startswith("HB_") or point.startswith("LZ_")


def frame_to_days(f: pd.DataFrame, keep=_keep) -> dict:
    """{date: {point: [24]}} from a frame with columns date (ISO), he (1..24), flag, point, price,
    for the settlement points `keep` accepts."""
    f = f[f["point"].map(keep) & (f["flag"].astype(str).str.upper() != "Y")]
    f = f.dropna(subset=["he"])
    out = {}
    for (date, point), g in f.groupby(["date", "point"]):
        row = [None] * 24
        for he, p in zip(g["he"].astype(int), g["price"]):
            if 1 <= he <= 24 and pd.notna(p):
                row[he - 1] = round(float(p), 2)
        out.setdefault(date, {})[point] = row
    return out


def read_dam_spp(csvs: Iterable[Tuple[str, bytes]], keep=_keep) -> dict:
    """NP4-190-CD CSVs -> {date: {point: [24]}} for the settlement points `keep` accepts (hubs
    and load zones by default)."""
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        c = {_norm(k): k for k in f.columns}
        need = ("deliverydate", "hourending", "settlementpoint", "settlementpointprice")
        if any(k not in c for k in need):
            warn(f"Unrecognised DAM settlement point price columns in {n}: {list(f.columns)}")
            continue
        flag = c.get("dstflag") or c.get("repeatedhourflag")
        frames.append(pd.DataFrame({
            "date": to_iso_date(f[c["deliverydate"]].astype(str).str.strip()),
            "he": pd.to_numeric(f[c["hourending"]].astype(str).str.split(":").str[0], errors="coerce"),
            "flag": f[flag].astype(str).str.strip() if flag else "N",
            "point": f[c["settlementpoint"]].astype(str).str.strip(),
            "price": pd.to_numeric(f[c["settlementpointprice"]], errors="coerce"),
        }))
    return frame_to_days(pd.concat(frames, ignore_index=True), keep) if frames else {}


def load(path=PATH) -> dict:
    return read_json_gz(path, default=None) or {"points": [], "days": {}}


def save(store: dict, path=PATH) -> None:
    store["days"] = dict(sorted(store["days"].items()))
    store["points"] = sorted({p for v in store["days"].values() for p in v})
    write_json_gz(path, store)


def merge(store: dict, days: dict) -> list:
    for d, pts in days.items():
        store["days"].setdefault(d, {}).update(pts)
    return sorted(days)


def fetch_dam_prices(api, dates, index: dict, limit: int = 60) -> None:
    """DA hub and load-zone prices for `dates` not yet stored, newest first, up to `limit` days a
    run.  The report for operating day D is posted around midday on D - 1."""
    store = load()
    misses = index.setdefault("dam_price_misses", {})
    todo = sorted((set(dates) - set(store["days"])), reverse=True)
    todo = [d for d in todo if misses.get(d, 0) < MAX_MISSES][:limit]
    if todo:
        print(f"DA hub prices: fetching {len(todo)} day(s), {todo[-1]} to {todo[0]}")
    for date in todo:
        d = dt.date.fromisoformat(date)
        try:
            docs = api.list_archives(EMIL_DAM_SPP, dt.datetime.combine(d - dt.timedelta(days=2), dt.time()),
                                     dt.datetime.combine(d + dt.timedelta(days=1), dt.time()))
            blobs = api.download_many(EMIL_DAM_SPP, [x["docId"] for x in docs]) if docs else []
            got = read_dam_spp([c for b in blobs for c in iter_csvs(b, "x.zip")])
        except Exception as e:   # a DA price problem must not lose the rest of the run
            warn(f"DA hub prices {date}: failed: {type(e).__name__}: {e}")
            continue
        merge(store, got)
        if date not in got:
            misses[date] = misses.get(date, 0) + 1
    save(store)


NODE_TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar")


def thermal_nodes(index: dict) -> set:
    """Settlement points of the thermal, wind and solar units in the latest DAM disclosure
    files (wind and solar for the Overview's priced-out share, pipeline/models/renewable_floor.py)."""
    nodes = set()
    for d in sorted(index["days"].get("dam", []))[-NODE_FROM_DAM:]:
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz")
        for u in (dd or {}).get("units", {}).values():
            if u.get("tech") in NODE_TECHS and u.get("sp"):
                nodes.add(u["sp"])
    return nodes


def fetch_dam_node_prices(api, index: dict, now: dt.datetime = None) -> None:
    """Thermal node DA prices for the last NODE_DAYS days up to tomorrow (Central), those not yet
    stored.  A day counts towards MAX_MISSES only when it was still missing after DAM_POSTED on
    the day before it, so the runs before the DAM posts never give up on tomorrow."""
    nodes = thermal_nodes(index)
    if not nodes:
        return
    now = now or dt.datetime.now(CENTRAL)
    today = now.date()
    store = load(NODES_PATH)
    keep_from = (today - dt.timedelta(days=NODE_DAYS - 2)).isoformat()
    store["days"] = {d: v for d, v in store["days"].items() if d >= keep_from}
    misses = index.setdefault("dam_node_misses", {})
    want = [(today + dt.timedelta(days=k)).isoformat() for k in range(1, 1 - NODE_DAYS, -1)]
    hub_have = set(load()["days"])
    todo = [d for d in want if (d not in store["days"] or d not in hub_have) and misses.get(d, 0) < MAX_MISSES]
    for date in todo:
        d = dt.date.fromisoformat(date)
        try:
            docs = api.list_archives(EMIL_DAM_SPP, dt.datetime.combine(d - dt.timedelta(days=2), dt.time()),
                                     dt.datetime.combine(d + dt.timedelta(days=1), dt.time()))
            blobs = api.download_many(EMIL_DAM_SPP, [x["docId"] for x in docs]) if docs else []
            csvs = [c for b in blobs for c in iter_csvs(b, "x.zip")]
            got = read_dam_spp(csvs, keep=nodes.__contains__)
            hubs = read_dam_spp(csvs)
        except Exception as e:
            warn(f"DA node prices {date}: failed: {type(e).__name__}: {e}")
            continue
        if date in got:
            store["days"][date] = got[date]
        elif now >= dt.datetime.combine(d - dt.timedelta(days=1), DAM_POSTED, tzinfo=CENTRAL):
            misses[date] = misses.get(date, 0) + 1
        if date in hubs:      # the same files carry the hubs and load zones: keep them for the
            hub_store = load()    # days ahead of the 60-day history (the forecast's price bands)
            merge(hub_store, {date: hubs[date]})
            save(hub_store)
    index["dam_node_misses"] = {d: n for d, n in misses.items() if d >= keep_from}
    save(store, NODES_PATH)
    if store["days"]:
        last = max(store["days"])
        print(f"DA node prices: {len(store['days'])} day(s) to {last}, {len(store['days'][last])} thermal nodes")


def load_xlsx(path: str) -> list:
    """Merge ERCOT's yearly NP4-180-ER workbook into the store; returns the dates added."""
    sheets = pd.read_excel(path, sheet_name=None, dtype=str)
    frames = []
    for _, f in sheets.items():
        if f.empty:
            continue
        c = {_norm(k): k for k in f.columns}
        frames.append(pd.DataFrame({
            "date": to_iso_date(f[c["deliverydate"]].str.strip()),
            "he": pd.to_numeric(f[c["hourending"]].str.split(":").str[0], errors="coerce"),
            "flag": f[c["repeatedhourflag"]] if "repeatedhourflag" in c else "N",
            "point": f[c["settlementpoint"]].str.strip(),
            "price": pd.to_numeric(f[c["settlementpointprice"]], errors="coerce"),
        }))
    store = load()
    added = merge(store, frame_to_days(pd.concat(frames, ignore_index=True)))
    save(store)
    return added


if __name__ == "__main__":
    for p in sys.argv[1:]:
        added = load_xlsx(p)
        print(f"{p}: {len(added)} day(s), {added[0] if added else '-'} to {added[-1] if added else '-'}")
