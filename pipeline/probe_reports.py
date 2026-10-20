"""Which ERCOT public reports carry transmission or resource outages, and what their files hold.

Run by the "Probe ERCOT reports" workflow on its PR.  Lists the Public API's report catalogue,
keeps the reports whose name mentions an outage, transmission or a system lambda (those that
mention one only in the description are listed), and for each downloads the newest document of the last few days and prints its files' columns
and first rows.  Writes nothing; the report goes to stdout, the run summary and one annotation.

  python -m pipeline.probe_reports
"""
import datetime as dt
import io
import os
import re
import traceback
import zipfile

import pandas as pd

from .ercot_api import BASE, ErcotAPI

WORDS = re.compile(r"outage|transmission|lambda", re.I)
ROWS = 3


def products(api) -> list:
    """Every report in the catalogue as {emilId, name, description}, whatever the page shape."""
    out, page = [], 1
    while True:
        js = api._request("GET", BASE, params={"page": page, "size": 1000}).json()
        found = []

        def walk(o):
            if isinstance(o, dict):
                if "emilId" in o:
                    found.append({k: o.get(k) for k in ("emilId", "name", "description")})
                else:
                    for v in o.values():
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(js)
        out.extend(found)
        pages = (js.get("_meta") or {}).get("totalPages", 1) or 1
        if page >= pages or not found:
            return out
        page += 1


def files(blob: bytes, name: str = "x.zip"):
    if not zipfile.is_zipfile(io.BytesIO(blob)):
        yield name, blob
        return
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for i in z.infolist():
            if not i.is_dir():
                yield from files(z.read(i), i.filename)


def preview(name: str, b: bytes) -> list:
    if name.lower().endswith(".csv"):
        f = pd.read_csv(io.BytesIO(b), nrows=200)
        return [f"    {name}: columns {list(f.columns)}"] + [f"      {r}" for r in f.head(ROWS).values.tolist()]
    if name.lower().endswith((".xlsx", ".xls")):
        out = []
        for sheet, f in pd.read_excel(io.BytesIO(b), sheet_name=None, nrows=12, header=None).items():
            out.append(f"    {name} [{sheet}]:")
            out += [f"      {r}" for r in f.head(8).values.tolist()]
        return out
    return [f"    {name}: {len(b)} bytes, starts {b[:120]!r}"]


def main():
    api = ErcotAPI()
    lines = ["# ERCOT reports on outages, transmission and lambda", ""]
    try:
        cat = products(api)
        lines.append(f"{len(cat)} reports in the catalogue")
        cat = list({p["emilId"]: p for p in cat}.values())
        keep = [p for p in cat if WORDS.search(f"{p['name']} {p['description']}")]
        lines.append("matching by description only (not downloaded): " +
                     "; ".join(f"{p['emilId']} {p['name']}" for p in keep if not WORDS.search(p["name"] or "")))
        keep = [p for p in keep if WORDS.search(p["name"] or "")]
    except Exception as e:
        lines += [f"catalogue failed: {type(e).__name__}: {e}", traceback.format_exc()[-800:]]
        keep = []
    now = dt.datetime.utcnow()
    for p in keep:
        lines += ["", f"## {p['emilId']}: {p['name']}", f"  {(p['description'] or '')[:300]}"]
        try:
            docs = api.list_archives(p["emilId"].lower(), now - dt.timedelta(days=4), now + dt.timedelta(days=1))
            lines.append(f"  {len(docs)} documents in the last 4 days")
            if not docs:
                continue
            doc = max(docs, key=lambda d: d.get("postDatetime", ""))
            lines.append(f"  newest: {doc.get('friendlyName') or doc.get('docId')} posted {doc.get('postDatetime')}")
            for n, b in list(files(api.download(p["emilId"].lower(), doc["docId"])))[:3]:
                lines += preview(n, b)
        except Exception as e:
            lines.append(f"  failed: {type(e).__name__}: {str(e)[:300]}")
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("```\n" + text + "\n```\n")
    if os.environ.get("GITHUB_ACTIONS"):
        print("::notice title=probe_reports::" + text[:60000].replace("%", "%25").replace("\r", "").replace("\n", "%0A"))


if __name__ == "__main__":
    main()
