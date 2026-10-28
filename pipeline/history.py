"""Hourly wind and solar history from 2019 on, for the hedge and basis analyses, and hourly
thermal history (--thermal) for training the commitment model on more than one year.

Kept apart from everything else the pipeline writes: it reads ERCOT's archive directly, never
reads or writes data/ (the site) or UNIT_DATA_DIR (the `data` branch), and writes only to its
own output folder (default history/, gitignored).  The "Build hourly history" workflow uploads
the files to the `history` release; to use them locally:

    gh release download history -D history/

One pair of Parquet files per calendar month:

  units-YYYY-MM.parquet   one row per wind or solar unit and operating hour
    date        operating day, YYYY-MM-DD
    he          hour ending, 1..24 (on the fall-back day the repeated hour is folded into one;
                on the spring-forward day hour ending 3 has no real-time values)
    unit, tech, sp      resource name, wind / solar, settlement point (resource node)
    offer       real-time offer: median over the hour's SCED runs of the submitted curve's price
                at half its MW ($/MWh; ppa.hourly_offers), null when offline or no curve
    spread      max - min of that price within the hour
    hsl         hourly mean HSL while online (MW)
    bp          hourly mean SCED base point (MW)
    out         hourly mean telemetered net output (MW)
    directed    MW ERCOT operators took off the unit's HDL by manual override, hourly mean
    award       DAM energy award (MW)
    dam_hsl     HSL in the DAM disclosure (the QSE's forecast; MW)
    da_node     DAM settlement point price at the unit's node ($/MWh)

  da-hubs-YYYY-MM.parquet  date, he, point, price: DAM settlement point prices at every hub and
                           load zone (NP4-190-CD)

  thermal-YYYY-MM.parquet  (--thermal) one row per thermal resource (nuclear, coal, combined-cycle
                           configuration, gas steam, combustion turbine) and operating hour:
    date, he, unit, tech, sp   as above
    state       the hour's state as data/unit_hours_60d.json.gz writes it (intraday.unit_hours):
                "m" running at minimum, "a" running above it, "0" offline, "o" outage, "-" no data
    lsl, hsl    hourly mean LSL and HSL over the hour's online SCED runs (MW; null when not running)
    out         hourly mean telemetered net output (MW)
    award       DAM energy award (MW)
    da_node     DAM settlement point price at the unit's node ($/MWh)
    dam_lsl     LSL in the DAM disclosure (MW)
    mingen      minimum-energy offer cost in the DAM three-part offer ($/MWh)
    hot_start   hot start-up offer cost ($ per start)

  as-YYYY-MM.parquet       (--as, from the 60-day DAM disclosure alone) one row per thermal resource
                           and operating hour with a DAM ancillary service award:
    date, he, unit, tech   as above
    regup, regdn, rrs, ecrs, nspin   MW awarded per service (0 where none)
  as-mcpc-YYYY-MM.parquet  (--as) date, he and the DAM market clearing price for capacity of each
                           of those services ($/MW per hour)

  rt-as-, rt-mcpc-, dam-as-YYYY-MM.parquet  (--rtas, from Dec 2025 on) real-time AS awards per
                           15-minute interval, RT MCPCs and DAM AS awards of every technology;
                           pipeline/rt_as.py documents them.

  dam-status-YYYY-MM.parquet (--dam-status, from the 60-day DAM disclosure alone) date, he,
                           unit, tech, status: every thermal resource's DAM resource status by hour
                           (blank where the file has none), for the operator model's history fits
                           (models/operator_history.py)

  rt-prices-YYYY-MM.parquet  (--rt, from NP6-905-CD alone) date, he, point, type, price: the real-time
                           settlement point price at every point (resource nodes, hubs, load zones),
                           the hourly mean of the four 15-minute prices, as parse_prices.node_hourly
                           gives the live node files.  Joins units-* and thermal-* on sp = point.

    python -m pipeline.history 2019-01 [2019-02 ...] [--out history] [--force] [--thermal | --as | --rt | --rtas [--days N]]
"""
import argparse
import calendar
import datetime as dt
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

from .config import EMIL_60DAY, EMIL_DAM, EMIL_DAM_SPP, EMIL_SPP
from .dam_prices import read_dam_spp
from .parse_prices import read_spp
from .log import warn
from .intraday import unit_hours
from .ppa import hourly_offers
from .store import describe_blob, iter_csvs
from .update import curve_source, skip_reason

OUT = Path("history")
LAG = 60          # the 60-day disclosures post about 60 days after the operating day
SLACK = 4         # days either side of that a file may post
FLOAT_COLS = ["offer", "spread", "hsl", "bp", "out", "directed", "award", "dam_hsl", "da_node"]
THERMAL_TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine")
THERMAL_FLOAT = ["lsl", "hsl", "out", "award", "da_node", "dam_lsl", "mingen", "hot_start"]
AS_SERVICES = ["regup", "regdn", "rrs", "ecrs", "nspin"]


def _days(month: str):
    y, m = map(int, month.split("-"))
    return [dt.date(y, m, d) for d in range(1, calendar.monthrange(y, m)[1] + 1)]


def _t(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d, dt.time())


def _to24(v, hours: int):
    """A DAM hourly list in file order -> 24 values (hour ending 1..24)."""
    v = list(v or [None] * 24)
    if hours == 25 and len(v) == 25:      # fall back: average the repeated hour ending 2 into one
        a, b = v[1], v[2]
        v = v[:1] + [None if a is None or b is None else (a + b) / 2] + v[3:]
    elif hours == 23 and len(v) == 23:    # spring forward: no hour ending 3
        v = v[:2] + [None] + v[2:]
    return (v + [None] * 24)[:24]


def _directed(rows) -> np.ndarray:
    """Hourly mean MW cut from HDL by operator overrides (units.py "overrides" rows)."""
    cut, n = np.zeros(24), np.zeros(24)
    for row in rows or []:
        m, orig, fin = row[0], row[1], row[3]
        if m < 1440 and orig is not None and fin is not None:
            cut[m // 60] += max(0.0, orig - fin)
            n[m // 60] += 1
    return np.where(n > 0, cut / np.maximum(n, 1), 0.0)


def unit_rows(ud: dict, dam: dict) -> pd.DataFrame:
    """Hourly rows for one operating day from a per-unit day file (parse_60day_zip) and the
    same day's DAM day file (parse_dam_zip)."""
    date = ud["date"]
    offers = hourly_offers(ud)
    du = (dam or {}).get("units") or {}
    hours = (dam or {}).get("hours", 24)
    over = ud.get("overrides") or {}
    cols = {k: [] for k in ["unit", "tech", "sp", "he"] + FLOAT_COLS}
    for name, o in offers.items():
        u, d = ud["units"][name], du.get(name) or {}
        dh = d.get("hsl_h")
        vals = {
            "offer": o["offer"], "spread": o["spread"], "hsl": o["hsl"], "bp": u.get("bp"),
            "out": u.get("out"), "directed": _directed(over.get(name)).tolist(),
            "award": _to24(d.get("award"), hours), "da_node": _to24(d.get("spp"), hours),
            "dam_hsl": _to24(dh, hours) if dh else [d.get("hsl")] * 24,
        }
        cols["unit"] += [name] * 24
        cols["tech"] += [o["tech"]] * 24
        cols["sp"] += [d.get("sp")] * 24
        cols["he"] += list(range(1, 25))
        for k in FLOAT_COLS:
            cols[k] += [None if x is None else x for x in ((vals[k] or [None] * 24) + [None] * 24)[:24]]
    f = pd.DataFrame(cols)
    for k in FLOAT_COLS:
        f[k] = pd.to_numeric(f[k], errors="coerce").astype("float32")
    f.insert(0, "date", date)
    f["he"] = f["he"].astype("int8")
    return f


def thermal_rows(ud: dict, dam: dict) -> pd.DataFrame:
    """Hourly thermal rows for one operating day from a per-unit day file and the same day's
    DAM day file (as unit_rows)."""
    du = (dam or {}).get("units") or {}
    hours = (dam or {}).get("hours", 24)
    cols = {k: [] for k in ["unit", "tech", "sp", "he", "state"] + THERMAL_FLOAT}
    for name, u in ud["units"].items():
        if u.get("tech") not in THERMAL_TECHS:
            continue
        st, out, lsl, hsl, _ = unit_hours(u, ud["runs"])
        d = du.get(name) or {}
        vals = {"lsl": lsl, "hsl": hsl, "out": out, "award": _to24(d.get("award"), hours),
                "da_node": _to24(d.get("spp"), hours), "dam_lsl": [d.get("lsl")] * 24,
                "mingen": [d.get("mingen")] * 24, "hot_start": [(d.get("start") or [None])[0]] * 24}
        cols["unit"] += [name] * 24
        cols["tech"] += [u["tech"]] * 24
        cols["sp"] += [d.get("sp")] * 24
        cols["he"] += list(range(1, 25))
        cols["state"] += list(st)
        for k in THERMAL_FLOAT:
            cols[k] += [None if x is None else x for x in (list(vals[k]) + [None] * 24)[:24]]
    f = pd.DataFrame(cols)
    for k in THERMAL_FLOAT:
        f[k] = pd.to_numeric(f[k], errors="coerce").astype("float32")
    f.insert(0, "date", ud["date"])
    f["he"] = f["he"].astype("int8")
    return f


def status_rows(dam: dict) -> pd.DataFrame:
    """DAM resource status by hour for every thermal resource in a DAM day file (parse_dam_zip):
    its hourly "status_h", else the day's one "status" for every hour."""
    rows = []
    for name, u in (dam.get("units") or {}).items():
        if u.get("tech") not in THERMAL_TECHS:
            continue
        sh = (list(u.get("status_h") or [u.get("status") or ""] * 24) + [""] * 24)[:24]
        rows += [(name, u["tech"], h + 1, str(sh[h] or "")) for h in range(24)]
    f = pd.DataFrame(rows, columns=["unit", "tech", "he", "status"])
    f.insert(0, "date", dam["date"])
    f["he"] = f["he"].astype("int8")
    return f


def as_rows(dam: dict, techs=THERMAL_TECHS):
    """-> (AS award rows for the techs, every technology when None; MCPC rows) for one operating
    day from a DAM day file (parse_dam_zip)."""
    hours = dam.get("hours", 24)
    rows = []
    for name, u in (dam.get("units") or {}).items():
        a = u.get("as") or {}
        if (techs is not None and u.get("tech") not in techs) or not a:
            continue
        v = {k: _to24(a.get(k), hours) for k in AS_SERVICES}
        for h in range(24):
            mw = [v[k][h] or 0.0 for k in AS_SERVICES]
            if any(mw):
                rows.append([name, u["tech"], h + 1] + mw)
    f = pd.DataFrame(rows, columns=["unit", "tech", "he"] + AS_SERVICES)
    m = pd.DataFrame({k: _to24((dam.get("mcpc") or {}).get(k), hours) for k in AS_SERVICES})
    m.insert(0, "he", range(1, 25))
    for g in (f, m):
        g.insert(0, "date", dam["date"])
        g["he"] = g["he"].astype("int8")
        for k in AS_SERVICES:
            g[k] = pd.to_numeric(g[k], errors="coerce").astype("float32")
    return f, m


DAM_KEEP = ("sp", "award", "spp", "hsl", "hsl_h")
DAM_KEEP_THERMAL = ("sp", "award", "spp", "lsl", "mingen", "start")
MEM_LIMIT = 5 * 2 ** 30    # bytes of address space a parse may use (hosted runners have 7 GB)


def _slim_dam(day: dict, thermal: bool = False) -> dict:
    """Only what unit_rows (thermal_rows) reads from a DAM day file."""
    keep, techs = (DAM_KEEP_THERMAL, THERMAL_TECHS) if thermal else (DAM_KEEP, ("wind", "solar"))
    return {"hours": day.get("hours", 24),
            "units": {n: {k: u[k] for k in keep if k in u} for n, u in (day.get("units") or {}).items()
                      if u.get("tech") in techs}}


def _parse(blob: bytes, source: str, dam: dict, thermal: bool = False, ancillary=False, rtas: bool = False):
    """Run in a child process: parse one disclosure and reduce it to what the month file keeps,
    -> (operating day, slim DAM day file or unit-hour frame).  The address-space cap makes a file
    too big to parse fail with MemoryError here instead of taking down the whole runner.
    ancillary="all" keeps DAM AS awards of every technology, ancillary="status" the thermal DAM
    resource status instead (status_rows); rtas reads only the SCED AS awards
    (pipeline/rt_as.py)."""
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT, MEM_LIMIT))
    found = curve_source(blob)
    if found is None or found[0] != source:
        raise ValueError(f"not a {source} disclosure ({describe_blob(blob)})")
    if rtas:
        from .rt_as import sced_awards
        return sced_awards(blob)
    parsed = found[1](blob)
    if source == "dam":
        if ancillary == "status":
            return parsed[0], status_rows(parsed[1])
        if ancillary:
            return parsed[0], as_rows(parsed[1], None if ancillary == "all" else THERMAL_TECHS)
        return parsed[0], _slim_dam(parsed[1], thermal)
    return parsed[0], (thermal_rows if thermal else unit_rows)(parsed[3][0], dam.get(parsed[0]))


def _disclosures(api, emil: str, days, source: str, dam=None, thermal: bool = False,
                 ancillary=False, rtas: bool = False):
    """Yield (date, result of _parse) for the month's operating days from a 60-day report,
    opening each file whose posting date maps to within SLACK days of the month.  Each file is
    parsed in a fresh child process, so its memory is returned and one file that fails (even by
    running out of memory) is reported and skipped."""
    lo, hi = days[0], days[-1]
    docs = api.list_archives(emil, _t(lo + dt.timedelta(days=LAG - SLACK)), _t(hi + dt.timedelta(days=LAG + SLACK + 1)))
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    want = {d.isoformat() for d in days}
    seen = set()
    for doc in docs:
        guess = dt.date.fromisoformat(doc["postDatetime"][:10]) - dt.timedelta(days=LAG)
        if not (lo - dt.timedelta(days=SLACK) <= guess <= hi + dt.timedelta(days=SLACK)):
            continue
        label = f"{emil} {doc.get('friendlyName', doc['docId'])} posted {doc['postDatetime'][:10]}"
        blob = b""
        try:
            blob = api.download(emil, doc["docId"])
            if blob[:2] != b"PK":
                time.sleep(10)
                blob = api.download(emil, doc["docId"])
            if skip_reason(blob):
                continue
            t0 = time.time()
            with ProcessPoolExecutor(max_workers=1) as ex:
                date, result = ex.submit(_parse, blob, source, dam or {}, thermal, ancillary, rtas).result()
            print(f"  {label}: {date}, {len(blob) / 1e6:.0f} MB zip, {time.time() - t0:.0f}s", flush=True)
        except Exception as e:     # BrokenProcessPool when the child was killed
            warn(f"{label} ({len(blob) / 1e6:.0f} MB): failed: {type(e).__name__}: {e}")
            continue
        if date in want:
            seen.add(date)
            yield date, result
    missing = sorted(want - seen)
    if missing:
        warn(f"{emil}: no file loaded for {len(missing)} day(s): {', '.join(missing)}")


def da_hubs(api, days) -> pd.DataFrame:
    docs = api.list_archives(EMIL_DAM_SPP, _t(days[0] - dt.timedelta(days=2)), _t(days[-1] + dt.timedelta(days=1)))
    blobs = api.download_many(EMIL_DAM_SPP, [d["docId"] for d in docs]) if docs else []
    got = read_dam_spp([c for b in blobs for c in iter_csvs(b, "x.zip")])
    want = {d.isoformat() for d in days}
    rows = [(d, h + 1, p, v) for d, pts in got.items() if d in want for p, vs in pts.items() for h, v in enumerate(vs)]
    f = pd.DataFrame(rows, columns=["date", "he", "point", "price"])
    f["he"] = f["he"].astype("int8")
    f["price"] = f["price"].astype("float32")
    missing = sorted(want - set(f["date"]))
    if missing:
        warn(f"{EMIL_DAM_SPP}: no DA hub prices for {len(missing)} day(s): {', '.join(missing)}")
    return f.sort_values(["date", "point", "he"]).reset_index(drop=True)


def build_month(api, month: str, out: Path = OUT, force: bool = False, thermal: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    days = _days(month)
    upath, hpath = out / f"{'thermal' if thermal else 'units'}-{month}.parquet", out / f"da-hubs-{month}.parquet"
    if force or not hpath.exists():
        da_hubs(api, days).to_parquet(hpath, index=False)
        print(f"{hpath.name}: written")
    if upath.exists() and not force:
        print(f"{upath.name}: already there")
        return
    t0 = time.time()
    dam = dict(_disclosures(api, EMIL_DAM, days, "dam", thermal=thermal))
    frames = [rows for _, rows in _disclosures(api, EMIL_60DAY, days, "60d", dam, thermal)]
    if not frames:
        warn(f"{month}: no 60-day SCED days found; nothing written")
        return
    f = pd.concat(frames, ignore_index=True).sort_values(["date", "unit", "he"]).reset_index(drop=True)
    for k in ("unit", "tech", "sp") + (("state",) if thermal else ()):
        f[k] = f[k].astype("category")
    f.to_parquet(upath, index=False)
    print(f"{upath.name}: {len(f):,} rows, {f['date'].nunique()} days, {f['unit'].nunique()} units, "
          f"{upath.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f}s")


def rt_prices(api, days) -> pd.DataFrame:
    """Hourly real-time price at every settlement point for the days, from NP6-905-CD: one
    listing and one bulk download per day, as update.fetch_prices does for the live node files
    (the last intervals of a day post just after midnight, so the listing runs to 02:00)."""
    frames, missing = [], []
    for d in days:
        docs = api.list_archives(EMIL_SPP, _t(d), _t(d + dt.timedelta(days=1)) + dt.timedelta(hours=2))
        blobs = api.download_many(EMIL_SPP, [x["docId"] for x in docs]) if docs else []
        spp = read_spp([c for b in blobs for c in iter_csvs(b, "x.zip")])
        spp = spp[spp["date"] == d.isoformat()]
        if spp.empty:
            missing.append(d.isoformat())
            continue
        g = spp.assign(he=spp["he"].astype(int).clip(1, 24)).groupby(["date", "he", "point", "type"], observed=True)["price"].mean()
        frames.append(g.reset_index())
        print(f"  {EMIL_SPP} {d}: {len(docs)} files, {g.index.get_level_values('point').nunique()} points", flush=True)
    if missing:
        warn(f"{EMIL_SPP}: no RT prices for {len(missing)} day(s): {', '.join(missing)}")
    if not frames:
        return pd.DataFrame(columns=["date", "he", "point", "type", "price"])
    f = pd.concat(frames, ignore_index=True)
    f["he"] = f["he"].astype("int8")
    f["price"] = f["price"].astype("float32")
    for k in ("point", "type"):
        f[k] = f[k].astype("category")
    return f.sort_values(["date", "point", "he"]).reset_index(drop=True)


def build_rt_month(api, month: str, out: Path = OUT, force: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"rt-prices-{month}.parquet"
    if path.exists() and not force:
        print(f"{path.name}: already there")
        return
    t0 = time.time()
    f = rt_prices(api, _days(month))
    if f.empty:
        warn(f"{month}: no RT settlement point prices found; nothing written")
        return
    f.to_parquet(path, index=False)
    print(f"{path.name}: {len(f):,} rows, {f['date'].nunique()} days, {f['point'].nunique()} points, "
          f"{path.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f}s")


def build_as_month(api, month: str, out: Path = OUT, force: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    apath, mpath = out / f"as-{month}.parquet", out / f"as-mcpc-{month}.parquet"
    if apath.exists() and mpath.exists() and not force:
        print(f"{apath.name}: already there")
        return
    t0 = time.time()
    got = [r for _, r in _disclosures(api, EMIL_DAM, _days(month), "dam", ancillary=True)]
    if not got:
        warn(f"{month}: no DAM days found; nothing written")
        return
    f = pd.concat([a for a, _ in got], ignore_index=True).sort_values(["date", "unit", "he"]).reset_index(drop=True)
    for k in ("unit", "tech"):
        f[k] = f[k].astype("category")
    m = pd.concat([b for _, b in got], ignore_index=True).sort_values(["date", "he"]).reset_index(drop=True)
    f.to_parquet(apath, index=False)
    m.to_parquet(mpath, index=False)
    print(f"{apath.name}: {len(f):,} rows, {m['date'].nunique()} days, {f['unit'].nunique()} units, "
          f"{time.time() - t0:.0f}s")


def build_status_month(api, month: str, out: Path = OUT, force: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"dam-status-{month}.parquet"
    if path.exists() and not force:
        print(f"{path.name}: already there")
        return
    t0 = time.time()
    got = [r for _, r in _disclosures(api, EMIL_DAM, _days(month), "dam", ancillary="status")]
    if not got:
        warn(f"{month}: no DAM days found; nothing written")
        return
    f = pd.concat(got, ignore_index=True).sort_values(["date", "unit", "he"]).reset_index(drop=True)
    for k in ("unit", "tech", "status"):
        f[k] = f[k].astype("category")
    f.to_parquet(path, index=False)
    print(f"{path.name}: {len(f):,} rows, {f['date'].nunique()} days, {f['unit'].nunique()} units, statuses "
          + ", ".join(f"{k or 'blank'} {v:.0%}" for k, v in f["status"].value_counts(normalize=True).head(6).items())
          + f", {time.time() - t0:.0f}s")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("months", nargs="+", help="YYYY-MM")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--force", action="store_true", help="rebuild files that already exist")
    kind = ap.add_mutually_exclusive_group()
    kind.add_argument("--thermal", action="store_true", help="build the thermal files instead of wind and solar")
    kind.add_argument("--as", dest="ancillary", action="store_true",
                      help="build the thermal ancillary service award and MCPC files instead")
    kind.add_argument("--rt", action="store_true", help="build the real-time settlement point price files instead")
    kind.add_argument("--rtas", action="store_true",
                      help="build the RT AS award, RT MCPC and all-technology DAM AS files instead (pipeline/rt_as.py)")
    kind.add_argument("--dam-status", action="store_true",
                      help="build the thermal DAM resource status files instead (60-day DAM disclosure alone)")
    ap.add_argument("--store-only", action="store_true",
                    help="read ERCOT's files only from the raw store (pipeline/raw_store.py); never download one")
    ap.add_argument("--days", type=int, help="--rtas only: build just the first N days of each month (smoke test)")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    api.store_only = args.store_only
    for m in args.months:
        if args.dam_status:
            build_status_month(api, m, Path(args.out), args.force)
            continue
        if args.ancillary:
            build_as_month(api, m, Path(args.out), args.force)
        elif args.rt:
            build_rt_month(api, m, Path(args.out), args.force)
        elif args.rtas:
            from .rt_as import build_month as build_rtas_month
            build_rtas_month(api, m, Path(args.out), args.force, args.days)
        else:
            build_month(api, m, Path(args.out), args.force, args.thermal)
    if api.raw.enabled:
        print(api.raw.summary(), flush=True)


if __name__ == "__main__":
    sys.exit(main())
