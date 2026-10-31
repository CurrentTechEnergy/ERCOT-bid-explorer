"""How far back OilPriceAPI's Houston Ship Channel series go, before paying for credits.

The Ship Channel code (NATURAL_GAS_HSC_USD) came back empty before 2025-09-02 until OilPriceAPI
loaded 2019-07-03 to 2024-05-31 on Oct 31, 2026.  This asks for four months across that range and
the gap after it, and checks the new days against the EIA Henry Hub spot (a scale or unit slip
would show as days far from it).

Run by the "Probe OilPriceAPI gas history" workflow.  About 4 calls of the free plan's 50 a day.
Every response is kept in R2 under raw/oilpriceapi/<code>/<start>_<end>_p<page>.json and read from
there first (an empty answer is asked again), so a rerun spends little.  The repository is public,
so the report gives only counts, dates and a correlation, never a price (pipeline/private.py).

  python -m pipeline.probe_gas_history
"""
import datetime as dt
import json
import os
import statistics

import requests

from .config import GAS_HUBS
from .gas import GAS_HISTORY_PATH, OPA, OPA_PAGE, parse_hub_rows
from .raw_store import RawStore
from .store import read_json_gz

CODES = [GAS_HUBS["hsc"][0]]
# Ship Channel was extended Oct 31 (2019-07-03 to 2024-05-31, then 2025-09-02 on): the start, the
# middle, the last month before the gap and a month inside the gap (expected empty)
WINDOWS = [("2019-07-01", "2019-07-31"), ("2024-03-01", "2024-03-31"), ("2024-05-01", "2024-05-31"),
           ("2025-01-01", "2025-01-31")]


def fetch(store, key, code, start, end):
    """{date: price} for code over [start, end], from R2 when kept, else OilPriceAPI (then kept).
    Returns (prices, calls spent, error or None)."""
    rows, page, calls = [], 1, 0
    while True:
        obj = f"raw/oilpriceapi/{code}/{start}_{end}_p{page}.json"
        blob = store.get_object(obj) if store.enabled else None
        if blob is not None and not _rows(blob):
            blob = None         # a kept empty answer is refetched: OilPriceAPI adds history later
        if blob is None:
            r = requests.get(OPA, headers={"Authorization": f"Token {key}"}, params={
                "by_code": code, "start_date": start, "end_date": end, "per_page": OPA_PAGE, "page": page,
            }, timeout=60)
            calls += 1
            if r.status_code != 200:
                return parse_hub_rows(rows), calls, f"HTTP {r.status_code}: {r.text[:120]}"
            blob = r.content
            if store.enabled:
                store.put_object(obj, blob, "application/json")
        got = _rows(blob)
        rows += got
        if len(got) < OPA_PAGE:
            break
        page += 1
    return {d: v for d, v in parse_hub_rows(rows).items() if start <= d <= end}, calls, None


def _rows(blob):
    data = json.loads(blob).get("data") or {}
    return data.get("prices", []) if isinstance(data, dict) else data


def describe(prices):
    if not prices:
        return "0 days"
    d = sorted(prices)
    return f"{len(d)} days, {d[0]} to {d[-1]}"


def main() -> int:
    key = os.environ.get("OILPRICEAPI_KEY")
    if not key:
        print("no OILPRICEAPI_KEY")
        return 1
    store = RawStore()
    if not store.enabled:
        print("R2 not configured: stopping rather than fetching without keeping the responses")
        return 1
    spent = 0
    print("| code | window | result |\n|---|---|---|")
    for code in CODES:
        for start, end in WINDOWS:
            prices, calls, err = fetch(store, key, code, start, end)
            spent += calls
            print(f"| {code} | {start} to {end} | {err or describe(prices)} |")
    # the new Ship Channel days against EIA Henry Hub: a scale or unit slip would show here
    hh = (read_json_gz(GAS_HISTORY_PATH, default=None) or {}).get("henry_hub") or {}
    hh = dict(zip(hh.get("dates", []), hh.get("value", [])))
    for start, end in WINDOWS[:3]:
        hsc, calls, err = fetch(store, key, CODES[0], start, end)
        spent += calls
        both = [d for d in hsc if d in hh]
        if both:
            near = sum(abs(hsc[d] - hh[d]) <= 1 for d in both)
            r = statistics.correlation([hsc[d] for d in both], [hh[d] for d in both]) if len(both) > 2 else float("nan")
            print(f"\n{start[:7]}: {len(both)} days with Henry Hub; within $1 of it on {near}; correlation {r:.2f}")
    print(f"\nOilPriceAPI calls spent this run: {spent} "
          f"({dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M} UTC)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
