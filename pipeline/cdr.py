"""Plant names from ERCOT's Capacity, Demand and Reserves (CDR) report, for the unit index.

The CDR's "Unit Details" tab lists every resource with its plant or unit name, unit code (the
resource name SCED uses, for most units), county and zone; it is published twice a year. This
module keeps an extract of that tab in the repository (pipeline/reference/cdr_units.csv) and
matches it to the site's units when the unit index is built, so new units pick up a name as
soon as the extract has them.

Refresh the extract from a new workbook (needs openpyxl, not used by the daily update):
    python -m pipeline.cdr CapacityDemandandReservesReport_<Month><Year>.xlsx

Matching, per unit (unit_index.py passes the name, technology and combined-cycle configurations):
  unit  the name, one of its configurations, or the name without a joint-ownership suffix
        (_J01.._J04, which SCED splits and the CDR does not) is a CDR unit code; or exactly one
        CDR code of the same plant prefix and technology ends with the unit's last part
        (BRAZ_WND_WND1 -> BRAZ_WND_BRAZ_WND1)
  site  no unit match, but CDR codes share the unit's plant prefix (the part before the first
        "_") and technology: the plant name is what their names have in common.  Combined
        cycle lands here, as the CDR lists each turbine and SCED the train.
"""
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

PATH = Path(__file__).parent / "reference" / "cdr_units.csv"
EDITION_PATH = PATH.with_name("cdr_edition.txt")     # "December 2025", from the workbook's file name
COLUMNS = ["code", "name", "tech", "fuel", "status", "county", "zone"]
# CDR technology codes to the site's techs (ST covers nuclear, coal and gas steam alike)
TECH = {"CC": {"combined_cycle"}, "GT": {"combustion_turbine"}, "IC": {"combustion_turbine"}, "WT": {"wind"}, "PV": {"solar"},
        "ST": {"nuclear", "coal", "gas_steam"}, "BA": {"storage"}}
_JOINT = re.compile(r"_J\d+$")
_NOTE = re.compile(r"\s*\((?:AS OF|AVAILABLE|EFFECTIVE|RETIRED|MOTHBALL)[^)]*\)", re.I)   # dated notes in a name
_UNIT_WORD = re.compile(r"\s+(?:CTG|STG|CT|GT|ST|U|UNIT|G|BLK|BLOCK)\s*[0-9A-Z]{1,3}$|\s+[0-9]{1,3}[A-Z]?$")


def extract(xlsx: str) -> list:
    import openpyxl
    wb = openpyxl.load_workbook(xlsx, read_only=True, data_only=True)
    ws = wb["Unit Details"]
    rows = ws.iter_rows(values_only=True)
    hdr = None
    for r in rows:     # the header row starts with UNIT NAME (row 3 in the Dec 2025 report)
        if r and isinstance(r[0], str) and r[0].strip().upper() == "UNIT NAME":
            hdr = [str(c or "").split("\n")[0].strip().upper() for c in r]
            break
    if hdr is None:
        raise ValueError("no UNIT NAME header row on the Unit Details tab")
    i = {k: hdr.index(k) for k in ("UNIT NAME", "UNIT CODE", "TECHNOLOGY", "FUEL", "CDR STATUS", "COUNTY", "ZONE")}
    out, seen = [], set()
    for r in rows:
        code = str(r[i["UNIT CODE"]] or "").strip()
        if not code or code in seen:     # a unit converting fuel is listed twice; the first is today's
            continue
        seen.add(code)
        out.append([code, _NOTE.sub("", str(r[i["UNIT NAME"]] or "")).strip(), str(r[i["TECHNOLOGY"]] or "").strip(), str(r[i["FUEL"]] or "").strip(),
                    str(r[i["CDR STATUS"]] or "").strip(), str(r[i["COUNTY"]] or "").strip(), str(r[i["ZONE"]] or "").strip()])
    return out


def edition() -> str:
    return EDITION_PATH.read_text().strip() if EDITION_PATH.exists() else ""


def load() -> list:
    if not PATH.exists():
        return []
    with open(PATH, newline="") as f:
        return [r for r in csv.DictReader(f)]


def _site_name(names):
    words = [n.split() for n in names]
    common = []
    for t in zip(*words):
        if len(set(t)) > 1:
            break
        common.append(t[0])
    name = " ".join(common) if len(names) > 1 else names[0]
    return _UNIT_WORD.sub("", name).strip() or name


# zones for the site's regional splits, west to east; the CDR's BEXAR (San Antonio) counts as SOUTH
ZONES = ["WEST", "PANHANDLE", "NORTH", "SOUTH", "COASTAL", "HOUSTON", "unmapped"]
ZONE_ALIAS = {"BEXAR": "SOUTH"}


def zone_lookup():
    """-> zone(name, tech): the unit's CDR zone (one of ZONES), "unmapped" without a match.
    The extract is a csv, not a tracked input of the memoized builders that use this: rerun them
    with REBUILD_ALL after refreshing it."""
    matcher, seen = Matcher(load()), {}

    def zone(name, tech):
        if name not in seen:
            m, _ = matcher.match(name, tech)
            z = (m or {}).get("zone")
            z = ZONE_ALIAS.get(z, z)
            seen[name] = z if z in ZONES else "unmapped"
        return seen[name]
    return zone


class Matcher:
    def __init__(self, rows: list):
        self.code = {r["code"]: r for r in rows}
        self.prefix = defaultdict(list)
        for r in rows:
            self.prefix[r["code"].split("_")[0]].append(r)

    def match(self, name: str, tech: str, configs=()) -> tuple:
        """-> (CDR row or a site's {name, county, zone}, "unit" | "site") or (None, None)"""
        for k in (name, *configs, _JOINT.sub("", name)):
            if k in self.code:
                return self.code[k], "unit"
        same = [r for r in self.prefix.get(name.split("_")[0], []) if tech in TECH.get(r["tech"], ())]
        last = _JOINT.sub("", name).rsplit("_", 1)[-1]
        ends = [r for r in same if len(last) >= 3 and r["code"].endswith(last)]
        if len(ends) == 1 and tech != "combined_cycle":
            return ends[0], "unit"
        if same:
            return {"name": _site_name([r["name"] for r in same]), "county": same[0]["county"], "zone": same[0]["zone"]}, "site"
        return None, None


if __name__ == "__main__":
    rows = extract(sys.argv[1])
    PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(PATH, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        w.writerows(rows)
    m = re.search(r"(January|February|March|April|May|June|July|August|September|October|November|December)[_ -]?(\d{4})", Path(sys.argv[1]).name)
    EDITION_PATH.write_text(f"{m.group(1)} {m.group(2)}\n" if m else "")
    print(f"{len(rows)} CDR units ({m.group(0) if m else 'edition not in the file name'}) -> {PATH}")
