"""Unit index: one small list of every unit the Unit page can open, for the header's "Find a
unit" box on every page and the Units directory on unit.html.  Needs no downloads; built last in
the update from files already written this run.

Membership is the Unit page's own list (site/unit.js buildList), so every entry opens a page:
thermal units from the 60-day trends, the decision record and the latest forecast (a combined-
cycle train is one entry, its configurations under it), and wind and solar from the hedge scan
(ppa.json.gz).  Batteries, hydro and "other" have no Unit page yet and are left out.

Writes data/unit_index.json.gz:
  {updated, columns: ["unit", "tech", "group", "mw", "sp", "configs"], rows: [[...], ...]}
  unit     resource name (the train for combined cycle), sorted by name
  tech     config.TECH_OF_TYPE grouping
  group    the latest forecast's timescale group (thermal only; null when not in the forecast)
  mw       capacity: econ's hsl, the 95th percentile of each day's highest HSL (null without econ data)
  sp       settlement point, from econ or the hedge scan
  configs  combined-cycle configuration names, so a search for one finds its train ([] otherwise)
"""
import datetime as dt
import re

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_index.json.gz"
COLUMNS = ["unit", "tech", "group", "mw", "sp", "configs"]
TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar")
_TRAIN = re.compile(r"^(.*_CC\d+)_")


def train_of(name: str) -> str:
    m = _TRAIN.match(name)
    return m.group(1) if m else name


def build(trends: dict, decisions: dict, forecast: dict, ppa: dict, econ: dict) -> dict:
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

    rows = []
    for name in sorted(units):
        e = units[name]
        ec = econ.get(name) or {}
        cfgs = set(e["configs"]) | set(ec.get("configs") or [])
        cfgs.discard(name)
        mw = ec.get("hsl")
        rows.append([name, e["tech"], group.get(name), round(mw) if mw else None,
                     ec.get("sp") or sp.get(name), sorted(cfgs)])
    return {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "columns": COLUMNS, "rows": rows}


def build_unit_index(index: dict) -> dict:
    trends = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    decisions = read_json_gz(DATA_DIR / "decisions.json.gz", default={}) or {}
    fi = read_json_gz(DATA_DIR / "forecast" / "index.json.gz", default={}) or {}
    forecast = (read_json_gz(DATA_DIR / "forecast" / f"{fi['days'][-1]}.json.gz", default={}) or {}) if fi.get("days") else {}
    ppa = read_json_gz(DATA_DIR / "ppa.json.gz", default={}) or {}
    econ = {}
    for t in TECHS:
        econ.update((read_json_gz(DATA_DIR / "econ" / f"{t}.json.gz", default={}) or {}).get("units", {}))
    out = build(trends, decisions, forecast, ppa, econ)
    write_json_gz(PATH, out)
    print(f"unit index: {len(out['rows'])} units")
    return out


if __name__ == "__main__":
    build_unit_index({})
