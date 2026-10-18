"""Unit index: one small list of every unit the Unit page can open, for the header's "Find a
unit" box on every page and the Units directory on unit.html.  Needs no downloads; built last in
the update from files already written this run.

Membership is the Unit page's own list (site/unit.js buildList), so every entry opens a page:
thermal units from the 60-day trends, the decision record and the latest forecast (a combined-
cycle train is one entry, its configurations under it), and wind and solar from the hedge scan
(ppa.json.gz).  Batteries, hydro and "other" have no Unit page yet and are left out.

Names come from ERCOT's CDR report (pipeline/cdr.py, matched here on every build), other names a
unit goes by from pipeline/reference/unit_aliases.csv (a developer's project name the CDR does not
use; one row per unit and name, edited by hand), and the QSE from the 60-day files where they carry
one (pipeline/qse.py, data/unit_qse.json.gz).

Writes data/unit_index.json.gz:
  {updated, cdr (the CDR edition the names come from), columns: ["unit", "tech", "group", "mw", "sp", "configs", "plant", "county", "zone",
   "match", "qse", "aliases"], rows: [[...], ...]}
  unit     resource name (the train for combined cycle), sorted by name
  tech     config.TECH_OF_TYPE grouping
  group    the latest forecast's timescale group (thermal only; null when not in the forecast)
  mw       capacity: econ's hsl, the 95th percentile of each day's highest HSL (null without econ data)
  sp       settlement point, from econ or the hedge scan
  configs  combined-cycle configuration names, so a search for one finds its train ([] otherwise)
  plant    the CDR's name: the unit's own name on a "unit" match, the plant's on a "site" match
  county, zone   from the CDR
  match    "unit", "site" or null (cdr.Matcher)
  qse      the QSE last seen scheduling the unit (any configuration's, for a train); null when
           the 60-day files carry none
  aliases  other names from unit_aliases.csv ([] for most units)
"""
import csv
import datetime as dt
import re
from collections import defaultdict
from pathlib import Path

from . import cdr
from .config import DATA_DIR
from .qse import PATH as QSE_PATH
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_index.json.gz"
ALIASES_PATH = Path(__file__).parent / "reference" / "unit_aliases.csv"
COLUMNS = ["unit", "tech", "group", "mw", "sp", "configs", "plant", "county", "zone", "match", "qse", "aliases"]
TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar")
_TRAIN = re.compile(r"^(.*_CC\d+)_")


def train_of(name: str) -> str:
    m = _TRAIN.match(name)
    return m.group(1) if m else name


def load_aliases() -> dict:
    out = defaultdict(list)
    if ALIASES_PATH.exists():
        with open(ALIASES_PATH, newline="") as f:
            for r in csv.DictReader(f):
                if r.get("unit") and r.get("alias"):
                    out[r["unit"].strip()].append(r["alias"].strip())
    return out


def build(trends: dict, decisions: dict, forecast: dict, ppa: dict, econ: dict, cdr_rows=(), qses=None, aliases=None) -> dict:
    units = {}

    def add(name, tech, cfg=None):
        if not name:
            return
        e = units.setdefault(name, {"tech": tech, "configs": set()})
        if not e["tech"] and tech:
            e["tech"] = tech
        if cfg:
            e["configs"].add(cfg)

    for u in trends.get("units", []):
        add(train_of(u["unit"]) if u["tech"] == "combined_cycle" else u["unit"], u["tech"], u["unit"])
    for name, r in (decisions.get("units") or {}).items():
        add(name, r[0])
    fu = (forecast.get("units") or {})
    cols = fu.get("columns") or []
    group = {}
    if "unit" in cols and "group" in cols:
        iu, it, ig = cols.index("unit"), cols.index("tech"), cols.index("group")
        for r in fu.get("rows", []):
            add(r[iu], r[it])
            group[r[iu]] = r[ig]
    sp = {}
    for u in ppa.get("units", []):
        add(u["name"], u["tech"])
        if u.get("sp"):
            sp[u["name"]] = u["sp"]

    matcher, qses, aliases = cdr.Matcher(list(cdr_rows)), qses or {}, aliases or {}
    rows = []
    for name in sorted(units):
        e = units[name]
        ec = econ.get(name) or {}
        cfgs = set(e["configs"]) | set(ec.get("configs") or [])
        cfgs.discard(name)
        mw = ec.get("hsl")
        m, how = matcher.match(name, e["tech"], sorted(cfgs))
        q = next((qses[k][0] for k in (name, *sorted(cfgs)) if k in qses), None)
        rows.append([name, e["tech"], group.get(name), round(mw) if mw else None,
                     ec.get("sp") or sp.get(name), sorted(cfgs),
                     m["name"] if m else None, m["county"] if m else None, m["zone"] if m else None, how, q,
                     sorted({a for k in (name, *sorted(cfgs)) for a in aliases.get(k, [])})])
    return {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "cdr": cdr.edition(), "columns": COLUMNS, "rows": rows}


def build_unit_index(index: dict) -> dict:
    trends = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    decisions = read_json_gz(DATA_DIR / "decisions.json.gz", default={}) or {}
    fi = read_json_gz(DATA_DIR / "forecast" / "index.json.gz", default={}) or {}
    forecast = (read_json_gz(DATA_DIR / "forecast" / f"{fi['days'][-1]}.json.gz", default={}) or {}) if fi.get("days") else {}
    ppa = read_json_gz(DATA_DIR / "ppa.json.gz", default={}) or {}
    econ = {}
    for t in TECHS:
        econ.update((read_json_gz(DATA_DIR / "econ" / f"{t}.json.gz", default={}) or {}).get("units", {}))
    qses = (read_json_gz(QSE_PATH, default={}) or {}).get("units", {})
    aliases = load_aliases()
    out = build(trends, decisions, forecast, ppa, econ, cdr.load(), qses, aliases)
    unknown = sorted(set(aliases) - {r[0] for r in out["rows"]} - {c for r in out["rows"] for c in r[5]})
    if unknown:
        warn(f"unit_aliases.csv names units the unit index does not have: {unknown[:5]}")
    write_json_gz(PATH, out)
    named = sum(1 for r in out["rows"] if r[6])
    print(f"unit index: {len(out['rows'])} units, {named} with a CDR name, {sum(1 for r in out['rows'] if r[10])} with a QSE")
    return out


if __name__ == "__main__":
    build_unit_index({})
