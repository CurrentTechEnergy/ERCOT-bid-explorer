"""Unit index: one small list of every unit the Unit page can open, for the header's "Find a
unit" box on every page and the Units directory on unit.html.  Needs no downloads; built last in
the update from files already written this run.

Membership is the Unit page's own list (site/unit.js buildList), so every entry opens a page:
thermal units from the 60-day trends, the decision record and the latest forecast (a combined-
cycle train is one entry, its configurations under it), wind and solar from the hedge scan
(ppa.json.gz), and batteries from their economics (data/econ/storage.json.gz).  Hydro and "other"
have no Unit page yet and are left out.  Batteries renamed for RTC+B (..._ESR1) mostly match the
CDR only by plant, since the CDR keeps the older ..._BESS codes.

Names come from ERCOT's CDR report (pipeline/cdr.py, matched here on every build), other names a
unit goes by from pipeline/reference/unit_aliases.csv (a developer's project name the CDR does not
use; one row per unit and name, edited by hand), the QSE and DME codes from the 60-day files where
they carry them (pipeline/qse.py, data/unit_qse.json.gz), and their names and the owner from ERCOT's
daily QSE and decision-making entity lists (pipeline/entities.py, data/entities.json.gz), the public buyers from
pipeline/reference/offtakers.csv (pipeline/offtakers.py), and operator, owner, developer and EIA plant names from
pipeline/reference/unit_companies.csv (one row per unit, company and role; built once from the EIA-860 plant
match and the offtaker web search's high and medium confidence answers, see that file's sources, and edited by hand).

Writes data/unit_index.json.gz:
  {updated, cdr (the CDR edition the names come from), columns: ["unit", "tech", "group", "mw", "sp", "configs", "plant", "county", "zone",
   "match", "qse", "aliases", "qse_name", "dme", "owner", "buyers", "companies"], rows: [[...], ...]}
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
  qse_name the QSE's name from ERCOT's QSE list (null when the code is not on it)
  dme      the decision-making entity: its name from the DME list for the unit (any configuration's,
           for a train), else the name for the DME code the 60-day files carry, else that code
  owner    the owning resource entity from the DME list (null when the unit is not on it)
  buyers   public buyers named for the unit in offtakers.csv, sorted ([] for most units)
  companies  [[name, role, source], ...] from unit_companies.csv (any configuration's, for a train): role
           "operator" (EIA-860), "owner" or "developer" (web search, with its confidence), or "plant name"
           (EIA-860's plant name); [] when the file has none
"""
import csv
import datetime as dt
import re
from collections import defaultdict
from pathlib import Path

from . import cdr
from .config import DATA_DIR
from .offtakers import CSV_PATH as OFFTAKERS_CSV
from .qse import PATH as QSE_PATH
from .entities import PATH as ENTITIES_PATH
from .log import warn
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_index.json.gz"
ALIASES_PATH = Path(__file__).parent / "reference" / "unit_aliases.csv"
COMPANIES_PATH = Path(__file__).parent / "reference" / "unit_companies.csv"
COLUMNS = ["unit", "tech", "group", "mw", "sp", "configs", "plant", "county", "zone", "match", "qse", "aliases",
           "qse_name", "dme", "owner", "buyers", "companies"]
TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar", "storage")
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


def load_buyers() -> dict:
    out = defaultdict(set)
    if OFFTAKERS_CSV.exists():
        with open(OFFTAKERS_CSV, newline="") as f:
            for r in csv.DictReader(f):
                for u in (r.get("units") or "").split():
                    if (r.get("buyer") or "").strip():
                        out[u].add(r["buyer"].strip())
    return out


def load_companies() -> dict:
    out = defaultdict(list)
    if COMPANIES_PATH.exists():
        with open(COMPANIES_PATH, newline="") as f:
            for r in csv.DictReader(f):
                if r.get("unit") and r.get("company"):
                    out[r["unit"].strip()].append([r["company"].strip(), r["role"].strip(), r["source"].strip()])
    return out


def build(trends: dict, decisions: dict, forecast: dict, ppa: dict, econ: dict, cdr_rows=(), qses=None, aliases=None,
          entities=None, buyers=None, companies=None) -> dict:
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
    for name, u in econ.items():
        if u.get("tech") == "storage" and u.get("hsl"):
            add(name, "storage")
    sp = {}
    for u in ppa.get("units", []):
        add(u["name"], u["tech"])
        if u.get("sp"):
            sp[u["name"]] = u["sp"]

    matcher, qses, aliases, ent = cdr.Matcher(list(cdr_rows)), qses or {}, aliases or {}, entities or {}
    buyers, companies = buyers or {}, companies or {}
    qse_names, dme_names, res = ent.get("qse") or {}, ent.get("dme") or {}, ent.get("resources") or {}
    rows = []
    for name in sorted(units):
        e = units[name]
        ec = econ.get(name) or {}
        cfgs = set(e["configs"]) | set(ec.get("configs") or [])
        cfgs.discard(name)
        mw = ec.get("hsl")
        m, how = matcher.match(name, e["tech"], sorted(cfgs))
        keys = (name, *sorted(cfgs))
        q = next((qses[k][0] for k in keys if k in qses), None)
        dcode = next((qses[k][1] for k in keys if k in qses and len(qses[k]) == 3 and qses[k][1]), None)
        r = next((res[k] for k in keys if k in res), None)
        dme = (r[1] if r and r[1] else None) or dme_names.get(dcode) or dcode
        rows.append([name, e["tech"], group.get(name), round(mw) if mw else None,
                     ec.get("sp") or sp.get(name), sorted(cfgs),
                     m["name"] if m else None, m["county"] if m else None, m["zone"] if m else None, how, q,
                     sorted({a for k in keys for a in aliases.get(k, [])}),
                     (qse_names.get(q) or [None])[0] if q else None, dme, r[0] if r else None,
                     sorted({b for k in keys for b in buyers.get(k, ())}),
                     [list(c) for c in sorted({tuple(c) for k in keys for c in companies.get(k, ())}, key=lambda c: (c[1], c[0]))]])
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
    entities = read_json_gz(ENTITIES_PATH, default={}) or {}
    companies = load_companies()
    out = build(trends, decisions, forecast, ppa, econ, cdr.load(), qses, aliases, entities, load_buyers(), companies)
    known = {r[0] for r in out["rows"]} | {c for r in out["rows"] for c in r[5]}
    for what, d in (("unit_aliases.csv", aliases), ("unit_companies.csv", companies)):
        unknown = sorted(set(d) - known)
        if unknown:
            warn(f"{what} names {len(unknown)} unit(s) the unit index does not have: {unknown[:5]}")
    write_json_gz(PATH, out)
    named = sum(1 for r in out["rows"] if r[6])
    print(f"unit index: {len(out['rows'])} units, {named} with a CDR name, {sum(1 for r in out['rows'] if r[10])} with a QSE, "
          f"{sum(1 for r in out['rows'] if r[12])} with a QSE name, {sum(1 for r in out['rows'] if r[13])} with a DME, "
          f"{sum(1 for r in out['rows'] if r[15])} with a public buyer, {sum(1 for r in out['rows'] if r[16])} with a company")
    return out


if __name__ == "__main__":
    build_unit_index({})
