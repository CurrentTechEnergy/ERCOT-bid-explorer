"""Branch-only check: where does ERCOT publish mitigated (SCED2) curves?"""
import datetime as dt, io, json, zipfile
import pandas as pd
from .config import EMIL_60DAY
from .ercot_api import ErcotAPI, BASE
from .store import iter_csvs
api = ErcotAPI()
out = {}
try:
    r = api._request("GET", BASE, params={"size": 1000})
    js = r.json()
    prods = js.get("_embedded", {}).get("products", []) or js.get("products", []) or []
    out["n_products"] = len(prods)
    out["products"] = [{k: p.get(k) for k in ("emilId", "name", "description")} for p in prods]
except Exception as e:
    out["products_error"] = repr(e)
for day in ("2025-12-01", "2026-04-27"):
    d0 = dt.date.fromisoformat(day) + dt.timedelta(days=60)
    docs = api.list_archives(EMIL_60DAY, dt.datetime.combine(d0 - dt.timedelta(days=1), dt.time()), dt.datetime.combine(d0 + dt.timedelta(days=2), dt.time()))
    doc = next((d for d in docs if d["postDatetime"][:10] == d0.isoformat()), None)
    if not doc:
        out[day] = "no file"; continue
    blob = api.download(EMIL_60DAY, doc["docId"])
    files = {}
    for name, data in iter_csvs(blob, "x.zip"):
        f = pd.read_csv(io.BytesIO(data), nrows=5, low_memory=False)
        files[name] = [c for c in f.columns if not any(c.startswith(p) for p in ("SCED1 Curve-", "Submitted TPO-", "SCED2 Curve-"))] + \
            sorted({c.split("-")[0] for c in f.columns if "-" in c and ("Curve" in c or "TPO" in c)})
    out[day] = files
json.dump(out, open("as_test.json", "w"), indent=1)
