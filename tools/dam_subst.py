"""One-off pull for the DAM substitution test (does renewable day-ahead selling replace virtual
supply?).  Reads only; writes to out/subst/ for a workflow artifact, never to site/data.

For every 60-Day DAM Disclosure (NP3-966-ER) posted for operating days FROM..TO, raw store only
by default (Blair's rule through Oct 31): a document not in the store is listed as missing and
skipped, unless SUBST_FETCH_MISSING=1, in which case ErcotAPI.download fetches it and keeps it.
From each zip:
  60d_DAM_EnergyOnlyOfferAwards  -> eoo_YYYY-MM-DD.parquet  [he, sp, qse, mw, spp]
  60d_DAM_EnergyBidAwards        -> bid_YYYY-MM-DD.parquet  [he, sp, qse, mw, spp]
  60d_DAM_Gen_Resource_Data      -> qse_YYYY-MM-DD.parquet  [resource, type, sp, qse]
  60d_DAM_EnergyOnlyOffers       -> eoo_offer_YYYY-MM-DD.parquet  [he, sp, qse, oid, seg, price, mw] (mw cumulative)
(three-part awards, HSL and node prices are already in site/data/dam)
Also writes docs.csv: every document, its operating day and whether it came from the store.

  python -m tools.dam_subst 2025-11-30 2026-08-26
"""
import datetime as dt
import io
import os
import sys
from pathlib import Path

import pandas as pd

from pipeline.config import EMIL_DAM
from pipeline.ercot_api import ErcotAPI
from pipeline.store import iter_csvs

OUT = Path("out/subst")
FETCH = os.environ.get("SUBST_FETCH_MISSING") == "1"


def _norm(f):
    f.columns = [c.strip().lower() for c in f.columns]
    return f


def awards(b, mw_col):
    f = _norm(pd.read_csv(io.BytesIO(b)))
    mw = next(c for c in f.columns if c.startswith(mw_col))
    return pd.DataFrame({
        "he": pd.to_numeric(f["hour ending"], errors="coerce").astype("Int16"),
        "sp": f["settlement point"].astype(str),
        "qse": f[next(c for c in f.columns if c.startswith("qse"))].astype(str),
        "mw": pd.to_numeric(f[mw], errors="coerce").astype("float32"),
        "spp": pd.to_numeric(f["settlement point price"], errors="coerce").astype("float32"),
    })


def offers(b):
    """Energy-only offer curves, one row per point (cumulative MW at that price)."""
    f = _norm(pd.read_csv(io.BytesIO(b), low_memory=False))
    out = []
    for i in range(1, 11):
        m, p = f"energy only offer mw{i}", f"energy only offer price{i}"
        if m not in f.columns:
            break
        g = pd.DataFrame({
            "he": pd.to_numeric(f["hour ending"], errors="coerce").astype("Int16"),
            "sp": f["settlement point"].astype(str),
            "qse": f[next(c for c in f.columns if c.startswith("qse"))].astype(str),
            "oid": f[next(c for c in f.columns if c.startswith("energy only offer id"))].astype(str),
            "seg": i,
            "price": pd.to_numeric(f[p], errors="coerce").astype("float32"),
            "mw": pd.to_numeric(f[m], errors="coerce").astype("float32"),
        })
        out.append(g.dropna(subset=["price", "mw"]))
    return pd.concat(out, ignore_index=True)


def rescue(api):
    """Zips fetched from the ERCOT MIS on Oct 25 for a one-off count (SUBST_RESCUE_DIR, with picks.txt
    mapping operating day -> document id; MIS and API document ids are the same).  Each is put in
    the raw store if the store lacks it, so it is never fetched again."""
    d = os.environ.get("SUBST_RESCUE_DIR")
    if not d or not (Path(d) / "picks.txt").exists():
        return
    for line in (Path(d) / "picks.txt").read_text().split("\n"):
        if not line.strip():
            continue
        day, doc = line.split()
        f = Path(d) / f"{day}.zip"
        if not f.exists():
            continue
        if api.raw.get(EMIL_DAM, doc) is not None:
            print(f"  rescued {day} (doc {doc}): already in the raw store", flush=True)
            continue
        blob = f.read_bytes()
        api.raw.put(EMIL_DAM, doc, blob, api._docs.get((EMIL_DAM, int(doc))) or api._docs.get((EMIL_DAM, doc)))
        print(f"  rescued {day} (doc {doc}): {len(blob) / 1e6:.1f} MB put in the raw store", flush=True)


def main(first, last):
    OUT.mkdir(parents=True, exist_ok=True)
    api = ErcotAPI()
    since = dt.datetime.combine(first + dt.timedelta(days=55), dt.time())
    until = dt.datetime.combine(last + dt.timedelta(days=66), dt.time())
    docs = api.list_archives(EMIL_DAM, since, until)
    print(f"{len(docs)} documents listed", flush=True)
    rescue(api)
    rows = []
    for x in sorted(docs, key=lambda d: str(d.get("postDatetime"))):
        doc = x["docId"]
        blob = api.raw.get(EMIL_DAM, doc)
        src = "store"
        if blob is None:
            if not FETCH:
                rows.append({"doc": doc, "posted": x.get("postDatetime"), "name": x.get("friendlyName"), "day": None, "src": "missing"})
                print(f"  doc {doc}: not in the raw store, skipped", flush=True)
                continue
            blob, src = api.download(EMIL_DAM, doc), "ercot"
        day, got = None, {}
        for name, b in iter_csvs(blob, "x.zip"):
            n = name.lower()
            if "energyonlyofferawards" in n:
                got["eoo"] = awards(b, "energy only offer award")
            elif "energyonlyoffers" in n:
                got["eoo_offer"] = offers(b)
            elif "energybidawards" in n:
                got["bid"] = awards(b, "energy only bid award")
            elif "gen_resource_data" in n:
                f = _norm(pd.read_csv(io.BytesIO(b), usecols=lambda c: c.strip().lower() in
                                      ("delivery date", "resource name", "resource type", "settlement point name", "qse")))
                day = pd.to_datetime(f["delivery date"].iloc[0]).date()
                got["qse"] = f.drop(columns="delivery date").drop_duplicates().rename(columns={
                    "resource name": "resource", "resource type": "type", "settlement point name": "sp"})
        rows.append({"doc": doc, "posted": x.get("postDatetime"), "name": x.get("friendlyName"), "day": day, "src": src})
        if day is None or not (first <= day <= last):
            continue
        for k, f in got.items():
            f.to_parquet(OUT / f"{k}_{day}.parquet", index=False)
        print(f"{day}: doc {doc} from {src}, " + ", ".join(f"{k} {len(f)}" for k, f in got.items()), flush=True)
    pd.DataFrame(rows).to_csv(OUT / "docs.csv", index=False)
    print(api.raw.summary(), flush=True)


if __name__ == "__main__":
    main(dt.date.fromisoformat(sys.argv[1]), dt.date.fromisoformat(sys.argv[2]))
