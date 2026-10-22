"""SCED shadow prices and binding transmission constraints, hourly, for naming the constraint
behind a node's separation from system lambda (congestion curtailment, nodal marginality).

Report (ERCOT Public API):
  NP6-86-CD  SCED Shadow Prices and Binding Transmission Constraints (posted every SCED run;
             each row is one binding or violated constraint in one run: SCEDTimeStamp,
             RepeatedHourFlag, ConstraintID, ConstraintName, ContingencyName, ShadowPrice,
             MaxShadowPrice, Limit, Value, ViolatedMW, FromStation, ToStation, FromStationkV,
             ToStationkV, CCTStatus)
Columns are matched loosely by name; a file whose columns are not recognised is skipped with a
warning naming them.  A posting can repeat runs, so rows are de-duplicated on run timestamp,
constraint, contingency and stations.  Rows in the repeated DST hour are dropped, as in
pipeline/load.py.

A run's hour ending is its timestamp's hour + 1.  For each operating day, hour and constraint
(name, contingency, from and to station) the store keeps the mean and the largest shadow price
over the runs in which it bound, how many runs it bound in, the mean limit and the largest
violated MW.  A constraint that did not bind in a run has no row for it, so "runs" is how often
it bound, out of about 12 runs an hour.

Days from BACKFILL_FROM on are filled from the archive, oldest first, at most DAYS_PER_RUN a
run (about 290 postings a day, downloaded in bulk), so the history arrives over a few updates.
The last LOOKBACK_DAYS are re-read every run.

Writes data/shadow/YYYY-MM.json.gz:
  {"month", "dates": [operating days filled],
   "constraints": [[name, contingency, from station, to station, from kV, to kV], ...],
   "columns": ["date", "he", "c", "sp", "sp_max", "runs", "limit", "viol"],
   "rows": [[date, hour ending 1..24, index into constraints, mean $/MWh, max $/MWh,
             runs bound, mean limit MW, max violated MW], ...]}

  python -m pipeline.shadow --sample      # parse the last few postings and print them (CI check)
"""
import argparse
import datetime as dt
import io

import pandas as pd

from .config import DATA_DIR
from .log import warn
from .renew_forecast import _find
from .store import iter_csvs, read_json_gz, write_json_gz

DIR = DATA_DIR / "shadow"
EMIL = "np6-86-cd"
LOOKBACK_DAYS = 2
DAYS_PER_RUN = 45
BACKFILL_FROM = dt.date(2025, 11, 30)     # the first 60-day day on the site
KEY = ["name", "cont", "frm", "to"]


def read_runs(csvs) -> pd.DataFrame:
    """CSVs of NP6-86-CD -> one row per run and binding constraint (date, he, ts, name, cont,
    from, to, fkv, tkv, sp, limit, viol), de-duplicated."""
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        if f.empty:
            continue
        ts = _find(f.columns, "scedtimestamp") or _find(f.columns, "timestamp")
        name = _find(f.columns, "constraintname")
        sp = _find(f.columns, "shadowprice", exclude=("max",))
        if not (ts and name and sp):
            warn(f"shadow price file {n}: columns not recognised: {list(f.columns)}")
            continue

        def text(*parts, exclude=()):
            c = _find(f.columns, *parts, exclude=exclude)
            return f[c].astype(str).str.strip() if c else ""

        def num(*parts):
            c = _find(f.columns, *parts)
            return pd.to_numeric(f[c], errors="coerce") if c else float("nan")

        g = pd.DataFrame({
            "ts": pd.to_datetime(f[ts].astype(str).str.strip(), format="%m/%d/%Y %H:%M:%S", errors="coerce"),
            "flag": text("repeatedhour"),
            "name": f[name].astype(str).str.strip(),
            "cont": text("contingency"),
            "frm": text("fromstation", exclude=("kv",)),
            "to": text("tostation", exclude=("kv",)),
            "fkv": num("fromstationkv"),
            "tkv": num("tostationkv"),
            "sp": pd.to_numeric(f[sp], errors="coerce"),
            "limit": num("limit"),
            "viol": num("violatedmw"),
        })
        g["flag"] = g["flag"].astype(str).str.upper()
        frames.append(g[(g["flag"] != "Y") & g["ts"].notna() & g["sp"].notna()])
    if not frames:
        return pd.DataFrame(columns=["date", "he", "ts"] + KEY + ["fkv", "tkv", "sp", "limit", "viol"])
    r = pd.concat(frames, ignore_index=True).drop_duplicates(subset=["ts"] + KEY)
    r["date"] = r["ts"].dt.strftime("%Y-%m-%d")
    r["he"] = r["ts"].dt.hour + 1
    return r.drop(columns="flag")


def hourly(runs: pd.DataFrame) -> pd.DataFrame:
    """Runs -> one row per date, hour ending and constraint."""
    g = runs.groupby(["date", "he"] + KEY, sort=True)
    return g.agg(fkv=("fkv", "first"), tkv=("tkv", "first"), sp=("sp", "mean"), sp_max=("sp", "max"),
                 runs=("ts", "nunique"), limit=("limit", "mean"), viol=("viol", "max")).reset_index()


def _r(x, nd=2):
    return None if pd.isna(x) else round(float(x), nd)


def _merge_month(month: str, h: pd.DataFrame, dates: set) -> None:
    """Replace `dates` in the month file with the hourly rows `h` (already limited to month)."""
    path = DIR / f"{month}.json.gz"
    store = read_json_gz(path, default=None) or {"month": month, "dates": [], "constraints": [], "rows": []}
    cons = [tuple(c) for c in store["constraints"]]
    rows = [r for r in store["rows"] if r[0] not in dates]
    keep = sorted({r[2] for r in rows})        # drop constraints only the replaced days used
    remap = {old: new for new, old in enumerate(keep)}
    cons = [cons[i] for i in keep]
    rows = [[r[0], r[1], remap[r[2]]] + r[3:] for r in rows]
    pos = {c[:4]: i for i, c in enumerate(cons)}
    for x in h.itertuples(index=False):
        k = (x.name, x.cont, x.frm, x.to)
        if k not in pos:
            pos[k] = len(cons)
            cons.append(k + (_r(x.fkv, 0), _r(x.tkv, 0)))
        rows.append([x.date, int(x.he), pos[k], _r(x.sp), _r(x.sp_max), int(x.runs), _r(x.limit, 1), _r(x.viol, 1)])
    rows.sort(key=lambda r: (r[0], r[1], r[2]))
    store.update(constraints=[list(c) for c in cons], rows=rows,
                 columns=["date", "he", "c", "sp", "sp_max", "runs", "limit", "viol"],
                 dates=sorted(set(store["dates"]) | dates))
    write_json_gz(path, store)


def filled_dates() -> set:
    out = set()
    for p in DIR.glob("*.json.gz") if DIR.exists() else []:
        out |= set((read_json_gz(p, default=None) or {}).get("dates", []))
    return out


def _docs(api, start: dt.date, end: dt.date) -> list:
    """Archive postings for operating days start..end (a run is posted a few minutes after it)."""
    since = dt.datetime.combine(start, dt.time())
    until = dt.datetime.combine(end + dt.timedelta(days=1), dt.time(1))
    docs = api.list_archives(EMIL, since, until)
    return [x for x in docs if "xml" not in str(x.get("friendlyName", "")).lower()]


def fetch_shadow(api, index: dict = None, today: dt.date = None) -> None:
    today = today or dt.date.today()
    have = filled_dates()
    recent = {(today - dt.timedelta(days=k)).isoformat() for k in range(1, LOOKBACK_DAYS + 1)}
    span = [(BACKFILL_FROM + dt.timedelta(days=k)).isoformat() for k in range((today - BACKFILL_FROM).days)]
    missing = [d for d in span if d not in have and d not in recent][:DAYS_PER_RUN]
    batches = []
    if missing:      # one listing for the oldest contiguous stretch of missing days
        run = [missing[0]]
        for d in missing[1:]:
            if dt.date.fromisoformat(d) - dt.date.fromisoformat(run[-1]) == dt.timedelta(days=1):
                run.append(d)
            else:
                break
        batches.append(run)
    batches.append(sorted(recent))
    for days in batches:
        start, end = dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1])
        try:
            docs = _docs(api, start, end)
            csvs = []
            for blob in api.download_many(EMIL, [x["docId"] for x in docs]) if docs else []:
                csvs.extend(iter_csvs(blob, "x.zip"))
            runs = read_runs(csvs)
        except Exception as e:
            warn(f"shadow prices {days[0]} to {days[-1]}: failed: {type(e).__name__}: {e}")
            continue
        if not docs:
            print(f"shadow prices: no postings for {days[0]} to {days[-1]}")
            continue
        h = hourly(runs[runs["date"].isin(days)])
        # a day counts as filled once its postings were read, even if nothing bound in it
        done = {d for d in days if d < today.isoformat()}
        for month in sorted({d[:7] for d in done}):
            _merge_month(month, h[h["date"].str.startswith(month)], {d for d in done if d.startswith(month)})
        print(f"shadow prices: {len(docs)} posting(s), {days[0]} to {days[-1]}: "
              f"{h['name'].nunique() if len(h) else 0} constraint(s), {len(h)} constraint-hour(s)")
    have = filled_dates()
    left = [d for d in span if d not in have]
    print(f"shadow prices: {len(have)} day(s) held" + (f" ({min(have)} to {max(have)})" if have else "")
          + (f", {len(left)} still to fill" if left else ""))


def sample(api, hours=12):
    """Parse the last few hours' postings and print what was read.  Fails when there are none,
    so the PR check proves the parser on a real posting.  The window is wide because the
    archive's post times are Central while a runner's clock is UTC."""
    now = dt.datetime.now()
    docs = sorted(api.list_archives(EMIL, now - dt.timedelta(hours=hours), now), key=lambda x: x.get("postDatetime", ""))
    print(f"{EMIL}: {len(docs)} posting(s) in {hours} hours; names: {sorted({str(x.get('friendlyName'))[:60] for x in docs[:4]})}")
    docs = [x for x in docs if "xml" not in str(x.get("friendlyName", "")).lower()]
    if not docs:
        raise SystemExit(f"{EMIL}: no CSV postings in the last {hours} hours")
    csvs = list(iter_csvs(api.download(EMIL, docs[-1]["docId"]), "x.zip"))
    f = pd.read_csv(io.BytesIO(csvs[0][1]))
    print("  columns:", list(f.columns))
    print(f.head(3).to_string())
    h = hourly(read_runs(csvs))
    print(h.sort_values("sp", ascending=False).head(10).to_string())
    old = dt.datetime.combine(BACKFILL_FROM, dt.time())
    print(f"{EMIL}: {len(api.list_archives(EMIL, old, old + dt.timedelta(hours=2)))} posting(s) "
          f"in the first two hours of {BACKFILL_FROM}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", action="store_true", help="parse a few recent postings and print them")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    api = ErcotAPI()
    if args.sample:
        sample(api)
    else:
        fetch_shadow(api)


if __name__ == "__main__":
    main()
