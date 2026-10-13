"""Natural gas prices: Henry Hub spot from the EIA open data API (v2), and Houston Ship Channel
and Waha daily prices from OilPriceAPI.

Needs EIA_API_KEY in the environment (free key from https://www.eia.gov/opendata/); without one
the fetch is skipped and any gas file already present is kept.  Writes data/gas.json.gz:
  {"series": "RNGWHHD", "name": ..., "unit": "$/MMBtu", "dates": [...], "value": [...],
   "updated": ISO timestamp}
with one entry per trading day (EIA posts no weekend or holiday prices), merged with what
was already stored so a short outage at EIA loses nothing.

fetch_hubs() needs OILPRICEAPI_KEY (free key from https://www.oilpriceapi.com/) and writes
data/gas_hubs.json.gz:
  {"source": "OilPriceAPI", "unit": "$/MMBtu", "updated": ISO timestamp,
   "hubs": {"hsc": {"code": ..., "name": "Houston Ship Channel", "dates": [...], "value": [...]},
            "waha": {...}}}
one entry per day OilPriceAPI has a daily price (trading days), merged with what was stored.
"""
import datetime as dt
import os

import requests

from .config import DATA_DIR, EIA_ROUTE, EIA_SERIES, GAS_HUBS, GAS_START
from .log import warn
from .store import read_json_gz, write_json_gz

GAS_PATH = DATA_DIR / "gas.json.gz"
HUBS_PATH = DATA_DIR / "gas_hubs.json.gz"
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


def _fetch_hub(code: str, key: str, start: str, end: str) -> dict:
    rows, page = [], 1
    while True:
        r = requests.get(OPA, headers={"Authorization": f"Token {key}"}, params={
            "by_code": code, "start_date": start, "end_date": end, "per_page": OPA_PAGE, "page": page,
        }, timeout=60)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]}")
        data = r.json().get("data") or {}
        got = data.get("prices", []) if isinstance(data, dict) else data
        rows += got
        if len(got) < OPA_PAGE:
            break
        page += 1
    return parse_hub_rows(rows)


def fetch_hubs(key=None) -> bool:
    """Fetch and merge the GAS_HUBS daily prices.  Returns True when the file was written."""
    key = key or os.environ.get("OILPRICEAPI_KEY")
    if not key:
        print("gas hubs: no OILPRICEAPI_KEY, skipped")
        return False
    have = (read_json_gz(HUBS_PATH, default=None) or {}).get("hubs", {})
    end = dt.date.today().isoformat()
    hubs, changed = {}, False
    for hub, (code, name) in GAS_HUBS.items():
        old = have.get(hub, {})
        series = dict(zip(old.get("dates", []), old.get("value", [])))
        start = _refetch_start(list(series))
        try:
            new = _fetch_hub(code, key, start, end)
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
    write_json_gz(HUBS_PATH, {
        "source": "OilPriceAPI", "unit": "$/MMBtu", "hubs": hubs,
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    return True
