"""How far back ERCOT's report archive goes, and whether the parsers read the old files.

Run by the "Probe ERCOT history" workflow (manual) before the 2019+ hourly backfill is built.
For each report (60-day disclosures, prices, and the two outage reports pipeline/outages.py
keeps) it lists the archive one week a quarter from 2016 on and reports the oldest
quarter with documents; then it downloads one 60-day SCED and one 60-day DAM disclosure per year
and runs parse_60day_zip / parse_dam_zip on them.  Writes nothing; the report goes to stdout and,
in Actions, the run summary.

  python -m pipeline.probe_history [--first-year 2016] [--parse-from 2019]
"""
import argparse
import datetime as dt
import os
import time
import traceback

from .config import EMIL_60DAY, EMIL_DAM, EMIL_SPP
from .ercot_api import ErcotAPI
from .parse_60day import parse_60day_zip
from .parse_dam import parse_dam_zip

EMIL_DAM_SPP = "np4-190-cd"     # DAM settlement point prices (also added to config.py by the hedge-signals PR)

REPORTS = [("60-day SCED disclosure", EMIL_60DAY, 7), ("60-day DAM disclosure", EMIL_DAM, 7),
           ("DAM settlement point prices", EMIL_DAM_SPP, 7), ("RT settlement point prices (15-min)", EMIL_SPP, 1),
           ("Unplanned resource outages", "np1-346-er", 7), ("Hourly resource outage capacity", "np3-233-cd", 1)]


def _t(d: dt.date) -> dt.datetime:
    return dt.datetime.combine(d, dt.time())


def coverage(api, emil, days, first_year):
    """[(quarter start, number of documents posted in its first `days` days)]"""
    out = []
    today = dt.date.today()
    for y in range(first_year, today.year + 1):
        for m in (1, 4, 7, 10):
            d = dt.date(y, m, 1)
            if d > today:
                break
            out.append((d, len(api.list_archives(emil, _t(d), _t(d + dt.timedelta(days=days))))))
    return out


def parse_sample(api, emil, parser, year):
    """Download one disclosure posted in mid-March of `year` and parse it."""
    d = dt.date(year, 3, 15)
    docs = api.list_archives(emil, _t(d), _t(d + dt.timedelta(days=4)))
    if not docs:
        return f"{year}: no documents posted Mar 15-18"
    doc = max(docs, key=lambda x: x.get("size") or 0)     # skip partial "SUPPLEMENTAL" reposts
    t0 = time.time()
    blob = api.download(emil, doc["docId"])
    try:
        date, day, summary, *extra = parser(blob)
    except Exception as e:
        return f"{year}: FAILED on {doc.get('friendlyName')}: {type(e).__name__}: {e}\n" + \
            "".join(traceback.format_exc().splitlines(True)[-6:])
    units = extra[0][0]["units"] if extra else day.get("units", {})
    techs = {}
    for u in (units.values() if isinstance(units, dict) else []):
        t = u.get("tech") if isinstance(u, dict) else None
        techs[t] = techs.get(t, 0) + 1
    top = ", ".join(f"{k}: {v}" for k, v in sorted(techs.items(), key=lambda kv: -kv[1])[:5] if k)
    return (f"{year}: ok, operating day {date}, {len(blob) / 1e6:.0f} MB zip, {len(units)} units"
            f"{' (' + top + ')' if top else ''}, {time.time() - t0:.0f}s")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--first-year", type=int, default=2016)
    ap.add_argument("--parse-from", type=int, default=2019)
    args = ap.parse_args(argv)
    api = ErcotAPI()
    lines = ["# ERCOT archive probe", ""]

    lines += ["## Archive coverage", "", "Documents listed in the first week of each quarter (first day for the 15-min RT prices).", ""]
    for name, emil, days in REPORTS:
        try:
            cov = coverage(api, emil, days, args.first_year)
        except Exception as e:
            lines.append(f"- **{name}** ({emil}): listing failed: {type(e).__name__}: {e}")
            continue
        have = [d for d, n in cov if n]
        gaps = [d.isoformat() for d, n in cov if not n and have and d > have[0]]
        lines.append(f"- **{name}** ({emil}): oldest quarter with documents "
                     f"{have[0].isoformat() if have else 'none'}"
                     f"{'; empty later quarters: ' + ', '.join(gaps) if gaps else ''}")
        print(lines[-1], flush=True)

    for name, emil, parser in (("60-day SCED disclosure", EMIL_60DAY, parse_60day_zip),
                               ("60-day DAM disclosure", EMIL_DAM, parse_dam_zip)):
        lines += ["", f"## Parse test: {name}", ""]
        for y in range(args.parse_from, dt.date.today().year + 1):
            try:
                r = parse_sample(api, emil, parser, y)
            except Exception as e:
                r = f"{y}: download failed: {type(e).__name__}: {e}"
            lines.append("- " + r.replace("\n", "\n  "))
            print(lines[-1], flush=True)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("\n".join(lines) + "\n")
    if os.environ.get("GITHUB_ACTIONS"):     # also as one annotation, readable from the checks API
        text = "\n".join(lines).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::notice title=ERCOT archive probe::{text}")


if __name__ == "__main__":
    main()
