"""Hourly wind and solar history from 2019 on, for the hedge and basis analyses.

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

    python -m pipeline.history 2019-01 [2019-02 ...] [--out history] [--force]
"""
import argparse
import calendar
import datetime as dt
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .config import EMIL_60DAY, EMIL_DAM, EMIL_DAM_SPP
from .dam_prices import read_dam_spp
from .log import warn
from .parse_60day import parse_60day_zip
from .parse_dam import parse_dam_zip
from .ppa import hourly_offers
from .store import describe_blob, iter_csvs
from .update import curve_source, skip_reason

OUT = Path("history")
LAG = 60          # the 60-day disclosures post about 60 days after the operating day
SLACK = 4         # days either side of that a file may post
FLOAT_COLS = ["offer", "spread", "hsl", "bp", "out", "directed", "award", "dam_hsl", "da_node"]


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


def _disclosures(api, emil: str, days, parser_source: str):
    """Yield (date, parsed) for the month's operating days from a 60-day report, opening each
    file whose posting date maps to within SLACK days of the month."""
    lo, hi = days[0], days[-1]
    docs = api.list_archives(emil, _t(lo + dt.timedelta(days=LAG - SLACK)), _t(hi + dt.timedelta(days=LAG + SLACK + 1)))
    docs.sort(key=lambda d: d.get("postDatetime", ""))
    want = {d.isoformat() for d in days}
    seen = set()
    for doc in docs:
        guess = dt.date.fromisoformat(doc["postDatetime"][:10]) - dt.timedelta(days=LAG)
        if not (lo - dt.timedelta(days=SLACK) <= guess <= hi + dt.timedelta(days=SLACK)):
            continue
        try:
            blob = api.download(emil, doc["docId"])
            if blob[:2] != b"PK":
                time.sleep(10)
                blob = api.download(emil, doc["docId"])
            if skip_reason(blob):
                continue
            found = curve_source(blob)
            if found is None or found[0] != parser_source:
                warn(f"{emil} doc {doc['docId']}: not a {parser_source} disclosure ({describe_blob(blob)})")
                continue
            parsed = found[1](blob)
        except Exception as e:
            warn(f"{emil} doc {doc['docId']} posted {doc['postDatetime'][:10]}: failed: {type(e).__name__}: {e}")
            continue
        if parsed[0] in want:
            seen.add(parsed[0])
            yield parsed[0], parsed
    missing = sorted(want - seen)
    if missing:
        warn(f"{emil}: no file found for {len(missing)} day(s): {', '.join(missing)}")


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


def build_month(api, month: str, out: Path = OUT, force: bool = False) -> None:
    out.mkdir(parents=True, exist_ok=True)
    days = _days(month)
    upath, hpath = out / f"units-{month}.parquet", out / f"da-hubs-{month}.parquet"
    if force or not hpath.exists():
        da_hubs(api, days).to_parquet(hpath, index=False)
        print(f"{hpath.name}: written")
    if upath.exists() and not force:
        print(f"{upath.name}: already there")
        return
    t0 = time.time()
    dam = {d: p[1] for d, p in _disclosures(api, EMIL_DAM, days, "dam")}
    frames = []
    for date, (_, _, _, (ud, _)) in _disclosures(api, EMIL_60DAY, days, "60d"):
        frames.append(unit_rows(ud, dam.get(date)))
        print(f"  {date}: {frames[-1]['unit'].nunique()} units", flush=True)
    if not frames:
        warn(f"{month}: no 60-day SCED days found; nothing written")
        return
    f = pd.concat(frames, ignore_index=True).sort_values(["date", "unit", "he"]).reset_index(drop=True)
    for k in ("unit", "tech", "sp"):
        f[k] = f[k].astype("category")
    f.to_parquet(upath, index=False)
    print(f"{upath.name}: {len(f):,} rows, {f['date'].nunique()} days, {f['unit'].nunique()} units, "
          f"{upath.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f}s")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("months", nargs="+", help="YYYY-MM")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--force", action="store_true", help="rebuild files that already exist")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    for m in args.months:
        build_month(api, m, Path(args.out), args.force)


if __name__ == "__main__":
    sys.exit(main())
