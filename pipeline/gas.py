"""Henry Hub natural gas spot price from the EIA open data API (v2).

Needs EIA_API_KEY in the environment (free key from https://www.eia.gov/opendata/); without one
the fetch is skipped and any gas file already present is kept.  Writes data/gas.json.gz:
  {"series": "RNGWHHD", "name": ..., "unit": "$/MMBtu", "dates": [...], "value": [...],
   "updated": ISO timestamp}
with one entry per trading day (EIA posts no weekend or holiday prices), merged with what
was already stored so a short outage at EIA loses nothing.
"""
import datetime as dt
import os

import requests

from .config import DATA_DIR, EIA_ROUTE, EIA_SERIES, GAS_START
from .log import warn
from .store import read_json_gz, write_json_gz

GAS_PATH = DATA_DIR / "gas.json.gz"
API = "https://api.eia.gov/v2"
PAGE = 5000


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
