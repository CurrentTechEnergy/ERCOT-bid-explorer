"""How far back OilPriceAPI's Houston Ship Channel series go, before paying for credits.

The live Ship Channel code (NATURAL_GAS_HSC_USD) came back empty before 2025-09-02, while Waha on
the same key reaches 2019 (pipeline/gas.py fetch_gas_history).  This asks for one month in 2024
and one in 2019 on each Ship Channel code the account lists, and checks that the basis code plus
the EIA Henry Hub spot reproduces the stored Ship Channel prices where both exist.

Run by the "Probe OilPriceAPI gas history" workflow.  About 7 calls of the free plan's 50 a day.
Every response is kept in R2 under raw/oilpriceapi/<code>/<start>_<end>_p<page>.json and read from
there first, so a rerun spends nothing.  The repository is public, so the report gives only row
counts, first and last dates and a median difference, never a price (pipeline/private.py).

  python -m pipeline.probe_gas_history
"""
import datetime as dt
import json
import os
import statistics

import requests

from .config import GAS_HUBS
from .gas import GAS_HISTORY_PATH, HUB_HISTORY, OPA, OPA_PAGE, parse_hub_rows
from . import private
from .raw_store import RawStore
from .store import read_json_gz

CODES = [GAS_HUBS["hsc"][0], "NATURAL_GAS_HSC_DAY_AHEAD_USD", "NATURAL_GAS_BASIS_HSC_USD"]
WINDOWS = [("2024-03-01", "2024-03-31"), ("2019-09-01", "2019-09-30")]
BASIS_CHECK = ("2025-09-02", "2025-10-31")    # stored Ship Channel history overlaps EIA Henry Hub here


def fetch(store, key, code, start, end):
    """{date: price} for code over [start, end], from R2 when kept, else OilPriceAPI (then kept).
    Returns (prices, calls spent, error or None)."""
    rows, page, calls = [], 1, 0
    while True:
        obj = f"raw/oilpriceapi/{code}/{start}_{end}_p{page}.json"
        blob = store.get_object(obj) if store.enabled else None
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
        data = json.loads(blob).get("data") or {}
        got = data.get("prices", []) if isinstance(data, dict) else data
        rows += got
        if len(got) < OPA_PAGE:
            break
        page += 1
    return {d: v for d, v in parse_hub_rows(rows).items() if start <= d <= end}, calls, None


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
    # basis + EIA Henry Hub against the stored Ship Channel prices
    basis, calls, err = fetch(store, key, CODES[2], *BASIS_CHECK)
    spent += calls
    hh = (read_json_gz(GAS_HISTORY_PATH, default=None) or {}).get("henry_hub") or {}
    hh = dict(zip(hh.get("dates", []), hh.get("value", [])))
    hsc = (private.read(HUB_HISTORY, default=None) or {}).get("hsc") or {}
    hsc = dict(zip(hsc.get("dates", []), hsc.get("value", [])))
    both = [d for d in basis if d in hh and d in hsc]
    print(f"\nBasis check {BASIS_CHECK[0]} to {BASIS_CHECK[1]}: basis {err or describe(basis)}; ", end="")
    if both:
        diff = [abs(hh[d] + basis[d] - hsc[d]) for d in both]
        print(f"{len(both)} days with Henry Hub and stored Ship Channel; |HH + basis - HSC| "
              f"median {statistics.median(diff):.3f}, max {max(diff):.3f} $/MMBtu")
    else:
        print("no days overlap Henry Hub and the stored Ship Channel history")
    print(f"\nOilPriceAPI calls spent this run: {spent} "
          f"({dt.datetime.now(dt.timezone.utc):%Y-%m-%d %H:%M} UTC)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
