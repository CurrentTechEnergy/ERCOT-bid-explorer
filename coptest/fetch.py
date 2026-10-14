"""Throwaway test (branch cop-test only): fetch two operating days of the 60-Day COP Adjustment
Period Snapshot, the raw DAM generation resource file and the SCED ESR file, and commit them
gzipped under coptest/out/ for offline analysis."""
import datetime as dt, gzip, io, json, sys, zipfile
sys.path.insert(0, ".")
from pipeline.ercot_api import ErcotAPI

DAYS = [dt.date(2026, 2, 24), dt.date(2026, 3, 17), dt.date(2026, 3, 22), dt.date(2026, 5, 3)]
OUT = "coptest/out"
api = ErcotAPI()
log = {}  # round 2: spring cheap-stretch days


def tag(d):            # 05-AUG-26 style used in 60-day file names
    return d.strftime("%d-%b-%y").upper()


def csvs(blob):
    """(name, bytes) of every CSV in a zip, opening nested zips."""
    z = zipfile.ZipFile(io.BytesIO(blob))
    for n in z.namelist():
        b = z.read(n)
        if n.lower().endswith(".zip"):
            yield from csvs(b)
        elif n.lower().endswith(".csv"):
            yield n, b


def save(name, b):
    import os
    os.makedirs(OUT, exist_ok=True)
    gz = gzip.compress(b)
    if len(gz) > 90e6:
        lines = b.split(b"\n")
        gz = gzip.compress(b"\n".join(lines[:300000]))
        log.setdefault("truncated", []).append(name)
    open(f"{OUT}/{name}.gz", "wb").write(gz)
    log.setdefault("saved", []).append([name, len(b), len(gz), b.split(b"\n", 1)[0].decode(errors="replace")])


def fetch(emil, want, lag=60):
    """Download docs of report `emil` posted near each day + lag; keep CSVs whose name passes want()."""
    for d in DAYS:
        post = d + dt.timedelta(days=lag)
        try:
            docs = api.list_archives(emil, dt.datetime.combine(post - dt.timedelta(days=2), dt.time()),
                                     dt.datetime.combine(post + dt.timedelta(days=3), dt.time()))
        except Exception as e:
            log.setdefault("errors", []).append([emil, str(d), f"{type(e).__name__}: {e}"[:300]])
            continue
        log.setdefault("listing", {})[f"{emil} {d}"] = [[x.get("docId"), x.get("friendlyName"), x.get("postDatetime")] for x in docs][:40]
        # op day = post date - lag; try the doc posted that day first, then its neighbours
        docs.sort(key=lambda x: abs((dt.date.fromisoformat(x["postDatetime"][:10]) - post).days))
        for doc in docs[:3]:
            blob = api.download(emil, doc["docId"])
            if blob[:2] != b"PK":
                log.setdefault("errors", []).append([emil, str(d), "not a zip", blob[:200].decode(errors="replace")])
                continue
            got = list(csvs(blob))
            for n, b in got:
                log.setdefault("files", []).append([emil, str(d), doc["postDatetime"], n, len(b)])
            hit = [(n, b) for n, b in got if tag(post) in n.upper()]
            if not hit and len(got) and emil == "np1-301":
                hit = got if doc is docs[0] else []
            for n, b in hit:
                if want(n):
                    save(n, b)
            if hit:
                break


fetch("np1-301", lambda n: True)                                         # COP snapshot (EMIL from the product page)
if False:
    fetch("np3-991-er", lambda n: True)                                  # fallback guess
fetch("np3-966-er", lambda n: n.lower().startswith("60d_dam_gen_resource_data"))
# SCED ESR file not needed this round
import os
os.makedirs(OUT, exist_ok=True)
json.dump(log, open(f"{OUT}/log.json", "w"), indent=1)
print(json.dumps({k: v for k, v in log.items() if k != "listing"}, indent=1)[:5000])
