"""One-off check: which OilPriceAPI gas series and how much history this key can read."""
import json
import os

import requests

KEY = os.environ.get("OILPRICEAPI_KEY", "")
print("key set:", bool(KEY), "length", len(KEY))
H = {"Authorization": f"Token {KEY}", "Content-Type": "application/json"}
BASE = "https://api.oilpriceapi.com/v1/prices"
CODES = ["NATURAL_GAS_WAHA", "NATURAL_GAS_HSC_USD", "NATURAL_GAS_HSC_DAY_AHEAD_USD", "NATURAL_GAS_USD"]


def show(label, r):
    print(f"\n== {label}: HTTP {r.status_code}")
    try:
        j = r.json()
    except ValueError:
        print(r.text[:400])
        return
    data = j.get("data")
    rows = data.get("prices") if isinstance(data, dict) else data
    if isinstance(rows, list) and rows:
        dates = sorted(str(x.get("created_at") or x.get("date") or "")[:10] for x in rows)
        print(f"rows {len(rows)}  first {dates[0]}  last {dates[-1]}")
        for x in rows[:3]:
            print(json.dumps(x)[:300])
        days = [x for x in rows if str(x.get("created_at") or x.get("date") or "")[:10] in
                ("2026-01-16", "2026-01-21", "2026-01-23", "2026-01-26", "2026-02-02")]
        for x in days:
            print("  key day:", json.dumps(x)[:200])
    else:
        print(json.dumps(j)[:600])


for code in CODES:
    show(f"{code} latest", requests.get(f"{BASE}/latest", params={"by_code": code}, headers=H, timeout=60))
    show(f"{code} historical Dec 1-Feb 10", requests.get(
        f"{BASE}/historical", params={"by_code": code, "start_date": "2025-12-01", "end_date": "2026-02-10",
                                      "per_page": 100}, headers=H, timeout=60))
show("WAHA past_year", requests.get(f"{BASE}/past_year", params={"by_code": "NATURAL_GAS_WAHA"}, headers=H, timeout=60))
