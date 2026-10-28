"""Real-time ancillary service awards and prices since RTC+B (Dec 5, 2025), for the AS revenue
analyses (batteries against a perfect battery; thermal units paid to stay on).  Built by the
history workflow (kind: rtas) into the `history` release, kept apart from the site data like
the rest of pipeline/history.py.

Under RTC+B, AS settles in two parts like energy: the DAM award at the DAM MCPC, and the
real-time award less the DAM award at the real-time MCPC.  These files carry both sides for
every technology, so the analysis can price each unit's AS at 15 minutes.

Three Parquet files per calendar month:

  rt-as-YYYY-MM.parquet    one row per resource and 15-minute interval with an AS award in SCED
                           (60-day SCED disclosure NP3-965-ER, generation and ESR files):
    date, he (1..24), interval (1..4), unit, tech
    regup, regdn, rrs, ecrs, nspin   MW awarded, mean over the interval's SCED runs (0 where none;
                                     a resource absent from the file that interval had none)

  rt-mcpc-YYYY-MM.parquet  date, he, interval and the real-time MCPC of each service ($/MW per
                           hour), NP6-331-CD, mean over the interval when a service has several rows

  dam-as-YYYY-MM.parquet   as as-YYYY-MM (pipeline/history.py) but every technology, batteries
                           included: date, he, unit, tech, regup, regdn, rrs, ecrs, nspin (MW)

Raw files: the 60-day zips go through ErcotAPI.download, which reads the raw store first and
keeps what it downloads.  The 15-minute MCPC files are many small documents fetched in one bulk
download per day, which ErcotAPI.download_many does not keep, so each day's bulk zip is stored
here under raw/np6-331-cd/day-YYYY-MM-DD and read from there before ERCOT is asked.
"""
import datetime as dt
import io
import time
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from .config import EMIL_DAM, EMIL_60DAY, EMIL_RT_MCPC, TECH_OF_TYPE
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs

SERVICES = ["regup", "regdn", "rrs", "ecrs", "nspin"]
RTCB_START = "2025-12-05"
_SEEN_HEADERS = set()


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def service_of(name) -> str | None:
    """'REGUP', 'AS Awards REGDN', 'RRSPFR', 'NonSpin', ... -> one of SERVICES, or None."""
    n = _norm(name).replace("asawards", "").replace("awards", "").replace("mcpc", "")
    if n.startswith(("regdn", "regdown")):
        return "regdn"
    if n.startswith("regup"):
        return "regup"
    if n.startswith("rrs"):
        return "rrs"
    if n.startswith("ecrs"):
        return "ecrs"
    if n.startswith(("nspin", "nonspin")):
        return "nspin"
    return None


# ------------------------------------------------------------ SCED awards --
def _award_frame(df: pd.DataFrame, name: str) -> pd.DataFrame:
    df.columns = [c.strip() for c in df.columns]
    cols = [c for c in df.columns if c.startswith("AS Awards")]
    unknown = [c for c in cols if service_of(c) is None]
    if unknown:
        warn(f"{name}: AS award columns not matched to a service: {unknown}")
    if not cols:
        return pd.DataFrame()
    ts = df["SCED Time Stamp"].astype(str).str.strip()
    f = pd.DataFrame({"date": to_iso_date(ts).values,
                      "he": ts.str.slice(11, 13).astype(int).values + 1,
                      "interval": ts.str.slice(14, 16).astype(int).values // 15 + 1,
                      "unit": df["Resource Name"].astype(str).str.strip().values,
                      "tech": df["Resource Type"].astype(str).str.strip().map(TECH_OF_TYPE).fillna("other").values})
    for k in SERVICES:
        mine = [c for c in cols if service_of(c) == k]
        f[k] = (np.nansum(np.column_stack([pd.to_numeric(df[c], errors="coerce").values for c in mine]), axis=1)
                if mine else 0.0)
    return f


def sced_awards(blob: bytes) -> tuple:
    """One 60-day SCED zip -> (operating day, 15-minute award rows).  Reads only the timestamp,
    resource and AS award columns of the generation and ESR files.  The repeated hour on the
    fall-back day is folded into one, as elsewhere in the history files."""
    frames = []
    for name, data in iter_csvs(blob, "x.zip"):
        low = name.lower()
        if not low.startswith(("60d_sced_gen_resource_data", "60d_esr_data_in_sced")):
            continue
        head = pd.read_csv(io.BytesIO(data), nrows=0).columns
        key = tuple(c.strip() for c in head if c.strip().startswith("AS Awards"))
        if (low[:12], key) not in _SEEN_HEADERS:
            _SEEN_HEADERS.add((low[:12], key))
            print(f"  {name}: AS award columns {list(key)}", flush=True)
        keep = {"SCED Time Stamp", "Resource Name", "Resource Type"}
        use = [c for c in head if c.strip() in keep or c.strip().startswith("AS Awards")]
        for chunk in pd.read_csv(io.BytesIO(data), usecols=use, chunksize=200000, low_memory=False):
            g = _award_frame(chunk, name)
            if len(g):
                frames.append(g)
    if not frames:
        raise ValueError("no SCED generation or ESR file with AS award columns in the zip")
    f = pd.concat(frames, ignore_index=True)
    date = f["date"].mode().iloc[0]
    f = f[f["date"] == date]
    f = f.groupby(["date", "he", "interval", "unit", "tech"], observed=True)[SERVICES].mean().reset_index()
    f = f[(f[SERVICES] != 0).any(axis=1)]
    return date, f


# ------------------------------------------------------------ RT MCPC ------
def read_rt_mcpc(csvs) -> pd.DataFrame:
    """NP6-331-CD CSVs -> date, he, interval and one column per service.  Takes either layout:
    one row per service (a type column and an MCPC column) or one column per service."""
    rows = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        norm = {_norm(c): c for c in f.columns}
        if tuple(norm) not in _SEEN_HEADERS:
            _SEEN_HEADERS.add(tuple(norm))
            print(f"  {EMIL_RT_MCPC} columns: {list(f.columns)}", flush=True)
        date_c = next((norm[k] for k in ("deliverydate", "operatingdate") if k in norm), None)
        hour_c = next((norm[k] for k in ("deliveryhour", "hourending") if k in norm), None)
        int_c = next((norm[k] for k in ("deliveryinterval", "interval") if k in norm), None)
        if date_c is None or hour_c is None or int_c is None:
            warn(f"{n}: unrecognised RT MCPC columns {list(f.columns)}")
            continue
        base = pd.DataFrame({"date": to_iso_date(f[date_c]).values,
                             "he": pd.to_numeric(f[hour_c], errors="coerce").values,
                             "interval": pd.to_numeric(f[int_c], errors="coerce").values})
        type_c = next((c for k, c in norm.items() if k in ("astype", "ancillarytype", "ancillaryservicetype", "asname")), None)
        price_c = next((c for k, c in norm.items() if k in ("mcpc", "price", "clearingprice")), None)
        if type_c is not None and price_c is not None:
            g = base.assign(service=f[type_c].map(service_of).values,
                            price=pd.to_numeric(f[price_c], errors="coerce").values)
            bad = sorted(set(f.loc[g["service"].isna().values, type_c].astype(str)))
            if bad:
                warn(f"{n}: AS types not matched to a service: {bad}")
            rows.append(g.dropna(subset=["service"]))
        else:
            wide = {c: service_of(c) for c in f.columns if c not in (date_c, hour_c, int_c) and service_of(c)}
            if not wide:
                warn(f"{n}: no MCPC columns found in {list(f.columns)}")
                continue
            for c, k in wide.items():
                rows.append(base.assign(service=k, price=pd.to_numeric(f[c], errors="coerce").values))
    if not rows:
        return pd.DataFrame(columns=["date", "he", "interval"] + SERVICES)
    g = pd.concat(rows, ignore_index=True).dropna(subset=["he", "interval"])
    g = g.groupby(["date", "he", "interval", "service"])["price"].mean().unstack("service")
    return g.reindex(columns=SERVICES).reset_index()


def _bulk(api, ids: list, d) -> bytes:
    """One bulk download of the documents.  ERCOT refuses the whole request (HTTP 400) when one
    document in it can't be served, so on a failure the list is split in halves until the bad
    documents are found and left out; the parts are packed into one zip of zips."""
    try:
        return api.download_many(EMIL_RT_MCPC, ids)[0]
    except RuntimeError as e:
        if len(ids) == 1:
            warn(f"{EMIL_RT_MCPC} {d}: document {ids[0]} left out ({str(e)[:120]})")
            return b""
    half = len(ids) // 2
    parts = [b for b in (_bulk(api, ids[:half], d), _bulk(api, ids[half:], d)) if b]
    if not parts:
        return b""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, b in enumerate(parts):
            z.writestr(f"part-{i}.zip", b)
    return buf.getvalue()


def rt_mcpc(api, days) -> pd.DataFrame:
    """15-minute RT MCPCs for the days.  Each day's bulk download is kept in the raw store and
    read from there first, so a rebuild never asks ERCOT for the same day again."""
    from .history import _t
    frames, missing = [], []
    for d in days:
        key = f"day-{d.isoformat()}"
        blob = api.raw.get(EMIL_RT_MCPC, key)
        src = "raw store"
        if blob is None:
            if api.store_only:
                missing.append(d.isoformat())
                continue
            docs = api.list_archives(EMIL_RT_MCPC, _t(d), _t(d + dt.timedelta(days=1)) + dt.timedelta(hours=2))
            if not docs:
                missing.append(d.isoformat())
                continue
            if len(docs) > 1000:
                warn(f"{EMIL_RT_MCPC} {d}: {len(docs)} documents, only the first 1,000 read")
            blob = _bulk(api, [x["docId"] for x in docs][:1000], d)
            if not blob:
                missing.append(d.isoformat())
                continue
            api.raw.put(EMIL_RT_MCPC, key, blob, {"friendlyName": f"bulk download of {len(docs)} documents posted {d}"})
            src = f"ERCOT, {len(docs)} files"
        m = read_rt_mcpc(iter_csvs(blob, "x.zip"))
        m = m[m["date"] == d.isoformat()]
        if m.empty:
            missing.append(d.isoformat())
            continue
        frames.append(m)
        print(f"  {EMIL_RT_MCPC} {d}: {len(m)} intervals from the {src}", flush=True)
    if missing:
        warn(f"{EMIL_RT_MCPC}: no RT MCPC for {len(missing)} day(s): {', '.join(missing)}")
    if not frames:
        return pd.DataFrame(columns=["date", "he", "interval"] + SERVICES)
    f = pd.concat(frames, ignore_index=True)
    # the fall-back day's repeated hour folds into one, as in the award file
    f = f.groupby(["date", "he", "interval"])[SERVICES].mean().reset_index()
    return f


# ------------------------------------------------------------ month build --
def build_month(api, month: str, out: Path, force: bool = False, max_days: int | None = None) -> None:
    from .history import _days, _disclosures
    out.mkdir(parents=True, exist_ok=True)
    days = [d for d in _days(month) if d.isoformat() >= RTCB_START][:max_days]
    if not days:
        warn(f"{month}: before RTC+B ({RTCB_START}); nothing to build")
        return
    paths = {k: out / f"{k}-{month}.parquet" for k in ("rt-as", "rt-mcpc", "dam-as")}
    t0 = time.time()

    if force or not paths["rt-mcpc"].exists():
        m = rt_mcpc(api, days)
        for k in SERVICES:
            m[k] = m[k].astype("float32")
        m["he"], m["interval"] = m["he"].astype("int8"), m["interval"].astype("int8")
        m.to_parquet(paths["rt-mcpc"], index=False)
        print(f"{paths['rt-mcpc'].name}: {len(m):,} intervals, {m['date'].nunique()} days, "
              f"services with prices: {[k for k in SERVICES if m[k].notna().any()]}", flush=True)

    if force or not paths["dam-as"].exists():
        got = [r for _, r in _disclosures(api, EMIL_DAM, days, "dam", ancillary="all")]
        if got:
            f = pd.concat([a for a, _ in got], ignore_index=True).sort_values(["date", "unit", "he"])
            for k in ("unit", "tech"):
                f[k] = f[k].astype("category")
            f.to_parquet(paths["dam-as"], index=False)
            print(f"{paths['dam-as'].name}: {len(f):,} rows, {f['unit'].nunique()} units "
                  f"({', '.join(f'{k}: {v}' for k, v in f.groupby('tech', observed=True)['unit'].nunique().items())})", flush=True)

    if force or not paths["rt-as"].exists():
        frames = [r for _, r in _disclosures(api, EMIL_60DAY, days, "60d", rtas=True)]
        if not frames:
            warn(f"{month}: no 60-day SCED days found; no RT AS awards written")
        else:
            f = pd.concat(frames, ignore_index=True).sort_values(["date", "unit", "he", "interval"]).reset_index(drop=True)
            f["he"], f["interval"] = f["he"].astype("int8"), f["interval"].astype("int8")
            for k in SERVICES:
                f[k] = f[k].astype("float32")
            for k in ("unit", "tech"):
                f[k] = f[k].astype("category")
            f.to_parquet(paths["rt-as"], index=False)
            print(f"{paths['rt-as'].name}: {len(f):,} rows, {f['date'].nunique()} days, {f['unit'].nunique()} units "
                  f"({', '.join(f'{k}: {v}' for k, v in f.groupby('tech', observed=True)['unit'].nunique().items())})", flush=True)
    print(f"{month}: {time.time() - t0:.0f}s", flush=True)
