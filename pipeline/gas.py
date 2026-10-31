"""Natural gas prices: Henry Hub spot from the EIA open data API (v2), and Houston Ship Channel
and Waha daily prices from OilPriceAPI.

Needs EIA_API_KEY in the environment (free key from https://www.eia.gov/opendata/); without one
the fetch is skipped and any gas file already present is kept.  Writes data/gas.json.gz:
  {"series": "RNGWHHD", "name": ..., "unit": "$/MMBtu", "dates": [...], "value": [...],
   "updated": ISO timestamp}
with one entry per trading day (EIA posts no weekend or holiday prices), merged with what
was already stored so a short outage at EIA loses nothing.  fetch_gas_history() writes the
series before GAS_START to data/gas_history.json.gz, and the Ship Channel and Waha as far back
as OilPriceAPI has them to the private gas_hub_history.json.gz.  Every OilPriceAPI response is
kept in R2 under raw/oilpriceapi/<code>/<start>_<end>_p<page>.json (pipeline/raw_store.py); the
history fetch reads that copy first.

hub_with_basis() fills the days a hub has no price (before its series begins, or a gap of more
than GAP_DAYS) with Henry Hub plus the hub's median basis for that calendar month
(monthly_basis()), for the Ship Channel's Jun 2024 to Aug 2025 gap.

fetch_hubs() needs OILPRICEAPI_KEY (free key from https://www.oilpriceapi.com/) and writes the
private gas_hubs.json.gz (pipeline/private.py: OilPriceAPI's terms do not allow publishing the
prices, so the site gets only values derived from them):
  {"source": "OilPriceAPI", "unit": "$/MMBtu", "updated": ISO timestamp,
   "hubs": {"hsc": {"code": ..., "name": "Houston Ship Channel", "dates": [...], "value": [...]},
            "waha": {...}}}
one entry per day OilPriceAPI has a daily price (trading days), merged with what was stored.

write_hub_averages() publishes only a smoothed form of the hubs, for the Real-time offers gas
chart (no download there): data/gas_hub_avg.json.gz {"days": SMOOTH_DAYS, "unit": "$/MMBtu",
"hubs": {"hsc"|"waha": {"dates", "value"}}}, each value the mean of the last SMOOTH_DAYS trading
days' prices (history then live series), rounded to SMOOTH_ROUND.
"""
import bisect
import datetime as dt
import json
import os
import statistics

import requests

from .config import DATA_DIR, EIA_ROUTE, EIA_SERIES, GAS_HUBS, GAS_START
from . import private
from .log import warn
from .store import read_json_gz, write_json_gz

GAS_PATH = DATA_DIR / "gas.json.gz"
GAS_HISTORY_PATH = DATA_DIR / "gas_history.json.gz"
HISTORY_GAS_START = "2018-12-01"   # a month before the thermal history begins
# Hub histories walked again from the live series' start once, when this stamp is new: OilPriceAPI
# loaded Ship Channel 2019-07-03 to 2024-05-31 on 2026-10-31 (nothing from Jun 2024 to Aug 2025).
HISTORY_RESET = {"hsc": "2026-10-31"}
GAP_DAYS = 7          # a hub price carries this many days over a gap before Henry Hub + basis fills it
RAW_PREFIX = "raw/oilpriceapi"
HISTORY_CALLS = 20       # OilPriceAPI calls fetch_gas_history may spend in a run
HISTORY_WINDOW_DAYS = 140    # calendar days per hub history request: about 100 trading days, one page
HUBS = "gas_hubs.json.gz"                   # private (pipeline/private.py)
HUB_HISTORY = "gas_hub_history.json.gz"     # private
HUB_AVG_PATH = DATA_DIR / "gas_hub_avg.json.gz"
SMOOTH_DAYS, SMOOTH_ROUND = 7, 0.05
API = "https://api.eia.gov/v2"
PAGE = 5000
OPA = "https://api.oilpriceapi.com/v1/prices/historical"
OPA_PAGE = 100
REFETCH_DAYS = 21     # refetch the last three weeks too, in case a price was revised


def parse_rows(rows: list) -> dict:
    """{date: value} from the API's data rows, skipping rows with no value."""
    out = {}
    for r in rows:
        d, v = r.get("period"), r.get("value")
        if not d or v is None:
            continue
        try:
            out[str(d)[:10]] = round(float(v), 3)
        except (TypeError, ValueError):
            continue
    return out


def fetch_gas(key=None, start=None) -> bool:
    """Fetch and merge Henry Hub prices.  Returns True when the file was written."""
    key = key or os.environ.get("EIA_API_KEY")
    if not key:
        print("gas: no EIA_API_KEY, skipped")
        return False
    have = read_json_gz(GAS_PATH, default=None) or {}
    series = dict(zip(have.get("dates", []), have.get("value", [])))
    # refetch the last three weeks too, in case EIA revised a price
    if start is None:
        start = GAS_START
        if series:
            last = max(series)
            start = max(GAS_START, (dt.date.fromisoformat(last) - dt.timedelta(days=21)).isoformat())
    rows, offset, name = [], 0, None
    try:
        while True:
            r = requests.get(f"{API}/{EIA_ROUTE}/data/", params={
                "api_key": key, "frequency": "daily", "data[0]": "value",
                "facets[series][0]": EIA_SERIES, "start": start,
                "sort[0][column]": "period", "sort[0][direction]": "asc",
                "offset": offset, "length": PAGE,
            }, timeout=60)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            resp = r.json().get("response", {})
            page = resp.get("data", [])
            rows += page
            if page and name is None:
                name = page[0].get("series-description")
            if len(page) < PAGE:
                break
            offset += PAGE
    except Exception as e:
        warn(f"gas: EIA fetch failed, keeping stored prices: {type(e).__name__}: {e}")
        return False
    new = parse_rows(rows)
    if not new:
        warn(f"gas: EIA returned no {EIA_SERIES} rows since {start}")
        return False
    series.update(new)
    dates = sorted(series)
    write_json_gz(GAS_PATH, {
        "series": EIA_SERIES, "name": name or have.get("name") or "Henry Hub natural gas spot price",
        "unit": "$/MMBtu", "dates": dates, "value": [series[d] for d in dates],
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    print(f"gas: {len(new)} day(s) fetched from EIA, {len(dates)} stored, {dates[0]} to {dates[-1]}")
    return True


def fetch_gas_history(eia_key=None, opa_key=None) -> bool:
    """Gas prices before the live series begin, for the operator-informed model's days before the
    60-day window (pipeline/models/operator_history.py), into data/gas_history.json.gz:
      {"henry_hub": {"dates", "value"}, "updated"}
    and the private gas_hub_history.json.gz: {"hsc"|"waha": {"dates", "value", "cursor", "done"}}.
    Henry Hub from EIA, from HISTORY_GAS_START to GAS_START, fetched once.  Houston Ship Channel,
    then Waha, from OilPriceAPI backwards from the start of each in the private gas_hubs.json.gz,
    HISTORY_WINDOW_DAYS at a time and at most HISTORY_CALLS calls a run between them (the free plan allows 50 a day and the daily
    fetches use about 2 a run), walking past empty windows (gaps), until it reaches
    HISTORY_GAS_START or the plan refuses a window (done: days with no price use Henry Hub,
    hub_with_basis()).  A new HISTORY_RESET stamp walks that hub again from the live start.  Returns True when a file was written."""
    have = read_json_gz(GAS_HISTORY_PATH, default=None) or {}
    hist = private.read(HUB_HISTORY, default=None) or {}
    changed = hub_changed = False
    eia_key = eia_key or os.environ.get("EIA_API_KEY")
    if not have.get("henry_hub") and eia_key:
        rows, offset = [], 0
        try:
            while True:
                r = requests.get(f"{API}/{EIA_ROUTE}/data/", params={
                    "api_key": eia_key, "frequency": "daily", "data[0]": "value",
                    "facets[series][0]": EIA_SERIES, "start": HISTORY_GAS_START, "end": GAS_START,
                    "sort[0][column]": "period", "sort[0][direction]": "asc",
                    "offset": offset, "length": PAGE,
                }, timeout=60)
                if r.status_code != 200:
                    raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
                page = r.json().get("response", {}).get("data", [])
                rows += page
                if len(page) < PAGE:
                    break
                offset += PAGE
            series = {d: v for d, v in parse_rows(rows).items() if d < GAS_START}
            if series:
                dates = sorted(series)
                have["henry_hub"] = {"dates": dates, "value": [series[d] for d in dates]}
                changed = True
                print(f"gas history: Henry Hub {len(dates)} day(s), {dates[0]} to {dates[-1]}")
        except Exception as e:
            warn(f"gas history: EIA fetch failed: {type(e).__name__}: {e}")
    opa_key = opa_key or os.environ.get("OILPRICEAPI_KEY")
    calls = 0
    for hub in ("hsc", "waha"):
        h = hist.get(hub) or {}
        if HISTORY_RESET.get(hub) and h.get("reset") != HISTORY_RESET[hub]:
            h = hist[hub] = {**h, "cursor": None, "done": False, "reset": HISTORY_RESET[hub]}
            hub_changed = True
        live = ((private.read(HUBS, default=None) or {}).get("hubs", {}).get(hub) or {}).get("dates") or []
        if not opa_key or h.get("done") or not live or calls >= HISTORY_CALLS:
            continue
        code, name = GAS_HUBS[hub][0], GAS_HUBS[hub][1]
        series = dict(zip(h.get("dates", []), h.get("value", [])))
        cursor = h.get("cursor") or live[0]
        while calls < HISTORY_CALLS and cursor > HISTORY_GAS_START:
            start = max(HISTORY_GAS_START, (dt.date.fromisoformat(cursor) - dt.timedelta(days=HISTORY_WINDOW_DAYS)).isoformat())
            end = (dt.date.fromisoformat(cursor) - dt.timedelta(days=1)).isoformat()
            try:
                got, spent = _fetch_hub(code, opa_key, start, end, cached=True)
            except Exception as e:
                warn(f"gas history: {name} {start} to {end} failed: {type(e).__name__}: {e}")
                if str(e).startswith("HTTP 4") and not str(e).startswith("HTTP 429"):
                    h["done"] = True        # the plan does not reach this far back: stop asking
                calls += 1
                break
            calls += spent
            got = {d: v for d, v in got.items() if start <= d <= end}
            if not got:     # a gap (Ship Channel has none Jun 2024 to Aug 2025): keep walking back
                print(f"gas history: no {name} prices {start} to {end}")
            series.update(got)
            cursor = start
        h["done"] = h.get("done") or cursor <= HISTORY_GAS_START
        dates = sorted(series)
        hist[hub] = {"dates": dates, "value": [series[d] for d in dates], "cursor": cursor, "done": h["done"],
                     **({"reset": h["reset"]} if h.get("reset") else {})}
        hub_changed = True
        print(f"gas history: {name} {len(dates)} day(s) stored{f', from {dates[0]}' if dates else ''}"
              f"{' (done)' if h['done'] else f', next run continues before {cursor}'}")
    if hub_changed:
        private.write(HUB_HISTORY, hist)
        _basis_spread(hist.get("hsc") or {}, have.get("henry_hub") or {})
    if not changed:
        return hub_changed
    have["updated"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    write_json_gz(GAS_HISTORY_PATH, have)
    return True


def _refetch_start(dates: list) -> str:
    """GAS_START when nothing is stored yet, else REFETCH_DAYS before the last stored date."""
    if not dates:
        return GAS_START
    return max(GAS_START, (dt.date.fromisoformat(max(dates)) - dt.timedelta(days=REFETCH_DAYS)).isoformat())


def parse_hub_rows(rows: list) -> dict:
    """{date: price} from OilPriceAPI price rows (date from created_at), skipping rows with no price."""
    out = {}
    for r in rows:
        d, v = str(r.get("created_at") or "")[:10], r.get("price")
        if len(d) != 10 or v is None:
            continue
        try:
            out[d] = round(float(v), 3)
        except (TypeError, ValueError):
            continue
    return out


_store = None


def _raw_store():
    global _store
    if _store is None:
        from .raw_store import RawStore
        _store = RawStore()
    return _store


def _rows(body: bytes) -> list:
    data = json.loads(body).get("data") or {}
    return data.get("prices", []) if isinstance(data, dict) else data


def _fetch_hub(code: str, key: str, start: str, end: str, cached=False):
    """({date: price}, OilPriceAPI calls spent) for code over [start, end].  Each page's response
    is kept in R2; with cached, a kept page with rows is read instead of asking again (an empty
    one is asked again: OilPriceAPI adds history later)."""
    rows, page, calls, store = [], 1, 0, _raw_store()
    while True:
        obj = f"{RAW_PREFIX}/{code}/{start}_{end}_p{page}.json"
        body = None
        if cached and store.enabled:
            try:
                body = store.get_object(obj)
            except RuntimeError as e:
                warn(f"gas: {e}")
            if body is not None and not _rows(body):
                body = None
        if body is None:
            r = requests.get(OPA, headers={"Authorization": f"Token {key}"}, params={
                "by_code": code, "start_date": start, "end_date": end, "per_page": OPA_PAGE, "page": page,
            }, timeout=60)
            calls += 1
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
            body = r.content
            store.put_object(obj, body, "application/json")
        got = _rows(body)
        rows += got
        if len(got) < OPA_PAGE:
            break
        page += 1
    return parse_hub_rows(rows), calls


def fetch_hubs(key=None) -> bool:
    """Fetch and merge the GAS_HUBS daily prices.  Returns True when the file was written."""
    key = key or os.environ.get("OILPRICEAPI_KEY")
    if not key:
        print("gas hubs: no OILPRICEAPI_KEY, skipped")
        return False
    have = (private.read(HUBS, default=None) or {}).get("hubs", {})
    end = dt.date.today().isoformat()
    hubs, changed = {}, False
    for hub, (code, name) in GAS_HUBS.items():
        old = have.get(hub, {})
        series = dict(zip(old.get("dates", []), old.get("value", [])))
        start = _refetch_start(list(series))
        try:
            new, _ = _fetch_hub(code, key, start, end)
        except Exception as e:
            warn(f"gas hubs: {name} fetch failed, keeping stored prices: {type(e).__name__}: {e}")
            new = {}
        if new:
            series.update(new)
            changed = True
        dates = sorted(series)
        if dates:
            hubs[hub] = {"code": code, "name": name, "dates": dates, "value": [series[d] for d in dates]}
            print(f"gas hubs: {name}: {len(new)} day(s) fetched, {len(dates)} stored, {dates[0]} to {dates[-1]}")
        elif not new:
            warn(f"gas hubs: no {name} ({code}) prices since {start}")
    if not changed:
        return False
    private.write(HUBS, {
        "source": "OilPriceAPI", "unit": "$/MMBtu", "hubs": hubs,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    return True


def write_hub_averages() -> None:
    live = (private.read(HUBS, default=None) or {}).get("hubs", {})
    hist = private.read(HUB_HISTORY, default=None) or {}
    out = {}
    for hub in ("hsc", "waha"):
        by = {}
        for s in (hist.get(hub) or {}, live.get(hub) or {}):
            by.update({d: v for d, v in zip(s.get("dates", []), s.get("value", [])) if v is not None})
        dates = sorted(by)
        if len(dates) < SMOOTH_DAYS:
            continue
        vals = [by[d] for d in dates]
        avg = [round(round(sum(vals[i - SMOOTH_DAYS + 1:i + 1]) / SMOOTH_DAYS / SMOOTH_ROUND) * SMOOTH_ROUND, 2)
               for i in range(SMOOTH_DAYS - 1, len(vals))]
        out[hub] = {"dates": dates[SMOOTH_DAYS - 1:], "value": avg}
    write_json_gz(HUB_AVG_PATH, {"days": SMOOTH_DAYS, "unit": "$/MMBtu", "hubs": out})


def monthly_basis(hub: dict, hh: dict) -> dict:
    """{month 1-12: median of hub - Henry Hub} over the days both have a price ({date: $/MMBtu})."""
    by = {}
    for d, v in hub.items():
        if v is not None and hh.get(d) is not None:
            by.setdefault(int(d[5:7]), []).append(v - hh[d])
    return {m: statistics.median(x) for m, x in by.items()}


def hub_with_basis(hub: dict, hh: dict, basis=None) -> tuple:
    """(prices, filled): hub's {date: $/MMBtu} plus, on each Henry Hub day more than GAP_DAYS after
    the hub's last earlier price (or before its first), Henry Hub + basis[month] (0 without
    one), and the set of dates so filled.  basis None takes monthly_basis(hub, hh)."""
    basis = monthly_basis(hub, hh) if basis is None else basis
    have = sorted(d for d, v in hub.items() if v is not None)
    out, filled = {d: hub[d] for d in have}, set()
    for d, v in hh.items():
        if v is None or d in out:
            continue
        i = bisect.bisect_left(have, d) - 1
        if i < 0 or (dt.date.fromisoformat(d) - dt.date.fromisoformat(have[i])).days > GAP_DAYS:
            out[d] = round(v + basis.get(int(d[5:7]), 0.0), 3)
            filled.add(d)
    return out, filled


def _basis_spread(hub: dict, hh: dict) -> None:
    """Log how much Ship Channel's basis to Henry Hub moves from year to year in each calendar month:
    the range of the yearly medians.  The repository is public, so no basis or price is printed."""
    live = read_json_gz(GAS_PATH, default=None) or {}
    hh = {**dict(zip(hh.get("dates", []), hh.get("value", []))), **dict(zip(live.get("dates", []), live.get("value", [])))}
    by = {}
    for d, v in zip(hub.get("dates", []), hub.get("value", [])):
        if v is not None and hh.get(d) is not None:
            by.setdefault((int(d[5:7]), d[:4]), []).append(v - hh[d])
    parts = []
    for m in range(1, 13):
        yearly = [statistics.median(x) for (mm, _), x in by.items() if mm == m and len(x) >= 10]
        if len(yearly) >= 2:
            parts.append(f"{dt.date(2000, m, 1):%b} {max(yearly) - min(yearly):.2f} ({len(yearly)} yr)")
    if parts:
        print("gas history: Ship Channel basis, range of yearly medians by month ($/MMBtu): " + ", ".join(parts))
