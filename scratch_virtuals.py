"""One-off: DAM virtual offer and bid awards by hour for the listed operating days, read from
the raw store only (never downloaded from ERCOT here: a day whose zip is not in the bucket is
skipped).  Writes virtuals.json."""
import csv, datetime as dt, io, json, re, sys, zipfile
from collections import defaultdict
from pipeline.ercot_api import ErcotAPI
from pipeline.raw_store import RawStore
EMIL = "np3-966-er"
days = set(open("scratch_days.txt").read().split())
lo = min(dt.date.fromisoformat(d) for d in days); hi = max(dt.date.fromisoformat(d) for d in days)
api, raw = ErcotAPI(), RawStore()
docs = api.list_archives(EMIL, dt.datetime.combine(lo + dt.timedelta(days=56), dt.time()),
                         dt.datetime.combine(hi + dt.timedelta(days=65), dt.time()))
print(len(docs), "archive docs listed")
WANT = {"eoo": "EnergyOnlyOfferAward", "bid": "EnergyBidAward", "ptp": "PTPObligationBidAward"}
out, shown = {}, set()
for doc in sorted(docs, key=lambda d: d.get("postDatetime", "")):
    guess = (dt.date.fromisoformat(doc["postDatetime"][:10]) - dt.timedelta(days=60))
    if not any(abs((guess - dt.date.fromisoformat(d)).days) <= 3 for d in days):
        continue
    blob = raw.get(EMIL, doc["docId"])
    if blob is None:
        print("not in the bucket, skipped:", doc.get("friendlyName"), doc["docId"]); continue
    z = zipfile.ZipFile(io.BytesIO(blob))
    names = z.namelist()
    m = re.search(r"(\d{2})-([A-Z]{3})-(\d{2})", " ".join(names))
    if not m: continue
    op = dt.datetime.strptime("-".join(m.groups()), "%d-%b-%y").date().isoformat()
    if op not in days or op in out: continue
    res = {}
    for key, pat in WANT.items():
        f = [n for n in names if pat.lower() in n.replace("_", "").lower()]
        if not f: continue
        rows = list(csv.DictReader(io.TextIOWrapper(z.open(f[0]), encoding="utf-8-sig")))
        if key not in shown:
            print(key, f[0], "columns:", list(rows[0].keys()) if rows else None); shown.add(key)
        if not rows: continue
        hcol = next(c for c in rows[0] if "hour" in c.lower())
        mcol = next(c for c in rows[0] if "award" in c.lower() and "mw" in c.lower())
        scol = next((c for c in rows[0] if "settlement point" in c.lower() and "name" in c.lower()), None)
        h = defaultdict(float); hz = defaultdict(float)
        for r in rows:
            try: he = int(str(r[hcol]).split(":")[0]); mw = float(r[mcol] or 0)
            except ValueError: continue
            h[he] += mw
            if scol and str(r[scol]).startswith(("LZ_", "HB_")): hz[he] += mw
        res[key] = [round(h.get(i, 0.0), 1) for i in range(1, 25)]
        res[key + "_hubzone"] = [round(hz.get(i, 0.0), 1) for i in range(1, 25)]
    out[op] = res
    print(op, {k: round(sum(v) / 24) for k, v in res.items()})
json.dump(out, open("virtuals.json", "w"))
print(len(out), "days of", len(days))
