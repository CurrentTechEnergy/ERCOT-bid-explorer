"""Public offtakers: buyers of wind and solar output named in public announcements, for the
"Public contracts" box on the Unit page and the "Public buyer" column of the Renewables hedge
table.  Needs no downloads; copies the hand-curated pipeline/reference/offtakers.csv each run.

The CSV is not refreshed by the update.  Each row passed a verification pass: a page by the
developer, owner, buyer, a utility or city, or trade press names both the buyer and the project in
a quoted sentence, the project matches its ERCOT units, and aggregator-only finds are left out.
The deal type is what the quote says in words, never inferred.

Columns of offtakers.csv (one row per buyer and project):
  units            space-separated ERCOT resource names the buyer covers (the phase's units where
                   the source names the phase, else all of the project's units)
  project          the project as the source names it
  tech             wind or solar
  buyer            the buyer as the source names it
  mw, share_pct    contracted MW and share of output, where the source states them (else blank)
  term_years       contract term, where stated
  announced        the announcement date, YYYY-MM-DD (blank when the source gives none)
  deal             what the quote says: "vppa", "hedge", "ppa" (a PPA, type not stated),
                   "ppa_recs" (power and RECs), "recs" (RECs or attributes only, no power) or
                   "contract" (a contract, type not stated)
  phase            "stated", or "unclear" when the source does not say which phase it covers
  may_have_expired 1 when the stated term has run out
  pre2012_no_term  1 when announced before 2012 with no term stated
  source_kind      developer, owner, buyer, utility_or_city, trade_press or other
  source_url, quote

Writes data/offtakers.json.gz:
  {updated, columns: [the CSV columns, units as a list], rows: [[...], ...],
   units: {unit: [row index, ...]}}
Numbers are numbers or null, flags true or false, other blanks null.  A unit missing from the
hedge scan (ppa.json.gz) is kept but warned about, since it may be a renamed resource.
"""
import csv
import datetime as dt
from pathlib import Path

from .config import DATA_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "offtakers.json.gz"
CSV_PATH = Path(__file__).parent / "reference" / "offtakers.csv"
COLUMNS = ["units", "project", "tech", "buyer", "mw", "share_pct", "term_years", "announced", "deal", "phase",
           "may_have_expired", "pre2012_no_term", "source_kind", "source_url", "quote"]
NUMS = {"mw", "share_pct", "term_years"}
FLAGS = {"may_have_expired", "pre2012_no_term"}
DEALS = {"vppa", "hedge", "ppa", "ppa_recs", "recs", "contract"}


def _cell(k, v):
    v = (v or "").strip()
    if k == "units":
        return v.split()
    if k in FLAGS:
        return v == "1"
    if k in NUMS:
        return float(v) if v else None
    return v or None


def build(rows, known=None) -> dict:
    out, units = [], {}
    for r in rows:
        row = [_cell(k, r.get(k)) for k in COLUMNS]
        rec = dict(zip(COLUMNS, row))
        if not rec["units"] or not rec["buyer"] or not rec["source_url"]:
            warn(f"offtakers.csv: row for {rec['buyer'] or rec['project']!r} lacks units, buyer or source; skipped")
            continue
        if rec["deal"] not in DEALS:
            warn(f"offtakers.csv: {rec['buyer']!r} has unknown deal {rec['deal']!r}; shown as a contract, type not stated")
            row[COLUMNS.index("deal")] = "contract"
        i = len(out)
        out.append(row)
        for u in rec["units"]:
            units.setdefault(u, []).append(i)
    if known:
        missing = sorted(set(units) - known)
        if missing:
            warn(f"offtakers.csv: {len(missing)} units not in the hedge scan: {', '.join(missing[:10])}")
    return {"updated": dt.date.today().isoformat(), "columns": COLUMNS, "rows": out, "units": units}


def build_offtakers(index: dict = None) -> dict:
    if not CSV_PATH.exists():
        return {}
    with open(CSV_PATH, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    ppa = read_json_gz(DATA_DIR / "ppa.json.gz", default={}) or {}
    known = {u["name"] for u in ppa.get("units", [])}
    out = build(rows, known)
    write_json_gz(PATH, out)
    print(f"  offtakers: {len(out['rows'])} buyers on {len(out['units'])} units")
    return out
