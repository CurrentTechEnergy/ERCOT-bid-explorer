"""One-off: does the ERCOT API list and serve the 60-day SCED files for the missing days?"""
import datetime as dt
import io
import zipfile

from pipeline.ercot_api import ErcotAPI

# operating day -> the website's document id for it (posted 60 days later)
WEB = {"2026-03-03": 1222075060, "2026-03-04": 1222450499, "2026-03-05": 1222802395,
       "2026-03-07": 1223585285, "2026-03-14": 1226230259, "2026-03-29": 1231933249,
       "2026-04-21": 1240791862, "2026-06-04": 1257827930, "2026-07-09": 1271562702,
       "2026-07-11": 1272373940}
EMIL = "np3-965-er"

api = ErcotAPI()
print("| operating day | website doc | API lists it | API docs posted day 58-63 | download |")
print("|---|---|---|---|---|")
for day, doc in WEB.items():
    d = dt.date.fromisoformat(day)
    lo = dt.datetime.combine(d + dt.timedelta(days=58), dt.time())
    hi = dt.datetime.combine(d + dt.timedelta(days=64), dt.time())
    try:
        docs = api.list_archives(EMIL, lo, hi)
        ids = sorted(int(x["docId"]) for x in docs)
        listed = doc in ids
        posted = ", ".join(f"{x['docId']}@{x['postDatetime'][:10]}" for x in sorted(docs, key=lambda x: x["postDatetime"]))
    except Exception as e:
        listed, posted = "error", f"{type(e).__name__}: {str(e)[:120]}"
    try:
        blob = api.download(EMIL, doc)
        if blob[:2] == b"PK":
            z = zipfile.ZipFile(io.BytesIO(blob))
            gen = [n for n in z.namelist() if n.lower().startswith("60d_sced_gen_resource_data")]
            first = io.TextIOWrapper(z.open(gen[0])).read(200).splitlines()[1].split(",")[0] if gen else "no gen file"
            got = f"zip {len(blob)/1e6:.0f} MB, first row {first}"
        else:
            got = f"not a zip: {len(blob)} bytes, {blob[:80]!r}"
    except Exception as e:
        got = f"{type(e).__name__}: {str(e)[:160]}"
    print(f"| {day} | {doc} | {listed} | {posted} | {got} |")
