"""One-off (not for merge): ERCOT's 60-day COP snapshot for the 60-day operating days we hold.

  python scratch_cop.py list    the COP reports in ERCOT's catalogue and their archive docs for
                                our window (no downloads)
  python scratch_cop.py fetch   downloads each doc once with ErcotAPI.download, which reads the R2
                                raw store first and writes every zip it gets from ERCOT to it,
                                and writes cop.json.gz: {date: {resource: hourly status codes}}
"""
import csv, datetime as dt, gzip, io, json, os, re, sys, zipfile
from pipeline.ercot_api import ErcotAPI, BASE
mode = sys.argv[1]
FIRST, LAST = dt.date(2025, 11, 30), dt.date(2026, 8, 25)
api = ErcotAPI()
if not api.raw.endpoint:
    sys.exit("R2 raw store is not configured: refusing to download")
try:
    js = api._request("GET", BASE).json()
except Exception as e:          # the catalogue is only a convenience
    print("catalogue not read:", e); js = {}
prods = []
for p in js.get("_embedded", {}).get("products", []) + js.get("products", []):
    name = p.get("name", "") + " " + p.get("description", "")
    if "COP" in name or "Current Operating Plan" in name:
        prods.append((p.get("emilId"), p.get("name")))
print("COP products:", prods)
emil = os.environ.get("COP_EMIL") or next((e for e, n in prods if "60" in n and "Snapshot" in n), "NP3-991-EX")
print("using", emil)
docs = api.list_archives(emil.lower(), dt.datetime.combine(FIRST + dt.timedelta(days=58), dt.time()),
                         dt.datetime.combine(LAST + dt.timedelta(days=63), dt.time()))
docs = sorted(docs, key=lambda d: d.get("postDatetime", ""))
print(len(docs), "docs;", [(d.get("friendlyName"), d.get("postDatetime")) for d in docs[:3]], "...", [(d.get("friendlyName"), d.get("postDatetime")) for d in docs[-2:]])
if mode != "fetch":
    sys.exit(0)
out, cols_shown = {}, False
for doc in docs:
    blob = api.download(emil.lower(), doc["docId"])
    try:
        z = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        print("not a zip:", doc.get("friendlyName")); continue
    for n in z.namelist():
        if not n.lower().endswith(".csv"):
            continue
        rows = list(csv.reader(io.TextIOWrapper(z.open(n), encoding="utf-8", errors="replace")))
        head = [h.strip() for h in rows[0]]
        if not cols_shown:
            print("columns:", head); print("sample:", rows[1][:12]); cols_shown = True
        low = [h.lower().replace(" ", "") for h in head]
        def col(*c):
            return next((i for i, h in enumerate(low) if any(x in h for x in c)), None)
        di, hi, ri, si = col("deliverydate"), col("hourending"), col("resourcename"), col("status")
        if None in (di, hi, ri, si):
            print("columns not found in", n, head); continue
        for r in rows[1:]:
            if len(r) <= max(di, hi, ri, si):
                continue
            try:
                d = dt.datetime.strptime(r[di].strip(), "%m/%d/%Y").date().isoformat()
                h = int(str(r[hi]).split(":")[0]) - 1
            except ValueError:
                continue
            if not (0 <= h < 24) or not (FIRST.isoformat() <= d <= LAST.isoformat()):
                continue
            out.setdefault(d, {}).setdefault(r[ri].strip(), [""] * 24)[h] = r[si].strip()
    print(doc.get("friendlyName"), len(out), "days so far", flush=True)
json.dump(out, gzip.open("cop.json.gz", "wt"))
print("wrote", len(out), "days")
