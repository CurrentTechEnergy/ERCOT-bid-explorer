"""Names for the QSE and DME codes in the 60-day files (pipeline/qse.py), and each resource's
owner, from two daily ERCOT lists.  Both are public on ercot.com with no login or API key, so they
are read there (as pipeline/nrc.py reads the NRC), newest posting only.

  NP3-988-ER  Resource Decision-Making Entity List.  CSV, posted daily about 05:00 Central: one
              row per resource (OWNER RE, RESOURCE NAME, TYPE, SPLIT GEN RESOURCE, DME, DME DUNS,
              RMR).  It names the DME but gives no code, so codes are tied to names by joining on
              resource name with the codes qse.py has seen.  On Oct 21, 2026 every one of 444
              codes joined to exactly one name.
  NP16-474-M  Qualified Scheduling Entity List.  An xlsx in a zip, posted daily: QSE NAME, QSE
              SHORT NAME (the code), DUNS, SFA effective date, and contact names and emails for
              each QSE's representatives.  Only name, code and date are kept.

Names drop ERCOT's " (DME)", " (RE)" and " (QSE)" tags.  Names seen before are kept when a code
or resource leaves the lists, so older history rows still decode.

Writes data/entities.json.gz:
  {updated, posted: {dme_list, qse_list},
   qse: {code: [name, SFA effective date]},
   dme: {code: name},
   resources: {resource name: [owner, dme name, rmr (bool)]}}
"""
import datetime as dt
import io
import re
import zipfile

import openpyxl
import pandas as pd
import requests

from .config import DATA_DIR
from .log import warn
from .qse import PATH as QSE_PATH
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "entities.json.gz"
LIST = "https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId={}"
DOWNLOAD = "https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId={}"
RT_DME = 10036       # NP3-988-ER
RT_QSE = 14746       # NP16-474-M


def clean(name) -> str:
    return re.sub(r"\s*\((DME|RE|QSE)\)\s*$", "", str(name or "")).strip()


def _newest(rt: int):
    """(doc id, publish time) of a report's newest posting."""
    r = requests.get(LIST.format(rt), timeout=60)
    r.raise_for_status()
    docs = [d["Document"] for d in r.json()["ListDocsByRptTypeRes"]["DocumentList"]]
    d = max(docs, key=lambda d: d["PublishDate"])
    return d["DocID"], d["PublishDate"][:19]


def _get(doc_id) -> bytes:
    r = requests.get(DOWNLOAD.format(doc_id), timeout=120)
    r.raise_for_status()
    return r.content


def read_dme_list(blob: bytes) -> dict:
    """NP3-988-ER CSV (or a zip holding it) -> {resource: [owner, dme name, rmr]}."""
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            blob = zf.read(next(n for n in zf.namelist() if n.lower().endswith(".csv")))
    f = pd.read_csv(io.BytesIO(blob), dtype=str).fillna("")
    f.columns = [c.strip().upper() for c in f.columns]
    return {r["RESOURCE NAME"].strip(): [clean(r["OWNER RE"]) or None, clean(r["DME"]) or None,
                                         r.get("RMR", "").strip().upper() == "Y"]
            for _, r in f.iterrows() if r["RESOURCE NAME"].strip()}


def read_qse_list(blob: bytes) -> dict:
    """NP16-474-M zip (or xlsx) -> {code: [name, SFA effective date]}; contact columns are not read."""
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            xl = [n for n in zf.namelist() if n.lower().endswith(".xlsx")]
            if xl:
                blob = zf.read(xl[0])
    wb = openpyxl.load_workbook(io.BytesIO(blob), read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        cols = None
        for row in ws.iter_rows(values_only=True):
            cells = [str(c).strip().upper() if c is not None else "" for c in row]
            if cols is None:
                if "QSE SHORT NAME" in cells and "QSE NAME" in cells:
                    cols = (cells.index("QSE NAME"), cells.index("QSE SHORT NAME"),
                            cells.index("SFA EFFECTIVE DATE") if "SFA EFFECTIVE DATE" in cells else None)
                continue
            name, code = row[cols[0]], row[cols[1]]
            if not code or not name:
                continue
            sfa = row[cols[2]] if cols[2] is not None else None
            sfa = sfa.date().isoformat() if isinstance(sfa, dt.datetime) else (str(sfa)[:10] if sfa else None)
            out[str(code).strip()] = [clean(name), sfa]
    return out


def dme_codes(resources: dict, seen: dict, old: dict) -> dict:
    """DME code -> name: the code qse.py saw for a resource, joined to the list's name for it."""
    out = dict(old)
    for name, v in seen.items():
        code = v[1] if len(v) == 3 else None
        r = resources.get(name)
        if code and r and r[1]:
            out[code] = r[1]
    return out


def fetch_entities() -> None:
    old = read_json_gz(PATH, default={}) or {}
    resources, qses = dict(old.get("resources") or {}), dict(old.get("qse") or {})
    posted = dict(old.get("posted") or {})
    try:
        doc, when = _newest(RT_DME)
        if when > posted.get("dme_list", ""):
            resources.update(read_dme_list(_get(doc)))
            posted["dme_list"] = when
    except Exception as e:
        warn(f"decision-making entity list (NP3-988-ER): failed: {type(e).__name__}: {e}")
    try:
        doc, when = _newest(RT_QSE)
        if when > posted.get("qse_list", ""):
            qses.update(read_qse_list(_get(doc)))
            posted["qse_list"] = when
    except Exception as e:
        warn(f"QSE list (NP16-474-M): failed: {type(e).__name__}: {e}")
    if not resources and not qses:
        return
    seen = (read_json_gz(QSE_PATH, default={}) or {}).get("units", {})
    dmes = dme_codes(resources, seen, old.get("dme") or {})
    write_json_gz(PATH, {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                         "posted": posted, "qse": qses, "dme": dmes, "resources": resources})
    print(f"entities: {len(resources)} resources with a DME, {len(dmes)} DME codes named, {len(qses)} QSE codes named", flush=True)


if __name__ == "__main__":
    fetch_entities()
