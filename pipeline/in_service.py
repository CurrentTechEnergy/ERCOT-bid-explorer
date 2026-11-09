"""In-service years from EIA-860: when each unit started operating.  Built by hand once a year,
when EIA publishes a new EIA-860 (the annual release, every operable and retired generator with its
operating month and year), and kept in pipeline/reference/unit_in_service.csv.  The update reads
the CSV (unit_index.py shows it on the Unit page; renew_changes.py uses it to confirm that a wind
unit's PTC can have run out).  Needs no ERCOT downloads.

  python -m pipeline.in_service path/to/eia860YYYY.zip

Every unit in the unit index except batteries is matched to one EIA plant in Texas:
  1. the EIA-860 plant name in reference/unit_companies.csv (role "plant name"), when EIA-860 still
     has a plant of that name (names compared without case, punctuation or LLC/LP/Inc);
  2. otherwise a plant in the unit's CDR county whose name shares the most words with the CDR's
     name for the unit, its other names (unit_aliases.csv) and the unit code's letters; kept only
     when the best plant has the unit's technology and scores clearly above the next one.
Within the plant, the unit's generators are those of its technology (EIA's Technology column).
When the unit code's number picks out exactly one of them (WAP_WAP_G5 -> generator 5), that
generator's operating year is the unit's; otherwise the unit gets the range of its technology's
generators at the plant.  A wind or solar plant built in phases reports each phase as its own
generator, so a unit can carry a range (2007-2008).  EIA keeps a repowered wind plant's original
operating year, so a repowered plant looks older than its turbines (and its new PTC).

Writes reference/unit_in_service.csv: unit, tech, eia_plant (name), eia_code, first, last (years),
gens (EIA generator ids used), match ("plant name", "county words", "name words", or "manual" for rows edited by
hand, which a rebuild keeps).
"""
import argparse
import csv
import difflib
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

from .config import DATA_DIR
from .store import read_json_gz

REF = Path(__file__).parent / "reference"
PATH = REF / "unit_in_service.csv"
FIELDS = ["unit", "tech", "eia_plant", "eia_code", "first", "last", "gens", "match"]
TECH_OF = {
    "Onshore Wind Turbine": "wind", "Solar Photovoltaic": "solar", "Conventional Steam Coal": "coal",
    "Natural Gas Fired Combined Cycle": "combined_cycle", "Natural Gas Fired Combustion Turbine": "combustion_turbine",
    "Natural Gas Internal Combustion Engine": "combustion_turbine", "Petroleum Liquids": "combustion_turbine",
    "Natural Gas Steam Turbine": "gas_steam", "Nuclear": "nuclear", "Other Gases": "gas_steam",
    "Landfill Gas": "combustion_turbine", "Other Natural Gas": "combustion_turbine",
}
_DROP = {"llc", "lp", "inc", "l", "p", "ltd", "co", "company", "corp", "the", "project", "facility", "center",
         "plant", "station", "power", "energy", "generating", "electric", "farm", "park", "ranch", "i", "unit",
         "solar", "wind", "pv", "slr", "wnd", "ctg", "stg", "ct", "st", "ic", "cc", "gt", "hybrid", "storage",
         "and", "of", "ii", "iii", "iv", "texas", "tx", "county", "creek", "hill", "hills", "north", "south",
         "east", "west", "el", "la", "de", "del", "los", "las", "one", "two", "three", "four"}
_NUM = re.compile(r"(\d+)[A-Z]?$")
_PHASE_WORD = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "one": 1, "two": 2, "three": 3, "four": 4}
_UNIT_WORD = {"u", "unit", "ctg", "stg", "ct", "st", "gt", "ic", "cc", "g", "gen", "block"}


def phase(s: str):
    """A plant name's phase number (Panther Creek Wind 3, Sherbino II, ... Farm Three), not a
    unit's number (CTG 1, U2): None when it has none."""
    ws = re.sub(r"[^a-z0-9 ]+", " ", str(s).lower()).split()
    for i, w in enumerate(ws):
        if i and ws[i - 1] in _UNIT_WORD:
            continue
        if w in _PHASE_WORD and i:
            return _PHASE_WORD[w]
        if w.isdigit() and int(w) < 10 and i:
            return int(w)
    return None


def norm(s: str) -> str:
    return " ".join(w for w in re.sub(r"[^a-z0-9 ]+", " ", str(s).lower()).split() if w not in ("llc", "lp", "inc", "ltd"))


def words(s: str) -> set:
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", str(s))
    return {w for w in re.sub(r"[^a-z0-9 ]+", " ", s.lower().replace("_", " ")).split()
            if w not in _DROP and not w.isdigit() and len(w) > 1}


def read_eia(zip_path: str) -> list:
    """Texas generators, operable and retired: dicts with code, plant, county, gen, tech, year."""
    import pandas as pd
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if re.match(r"3_1_Generator_Y\d{4}\.xlsx$", Path(n).name))
        with z.open(name) as f:
            sheets = pd.read_excel(f, sheet_name=None, header=1)
    out = []
    for sheet, df in sheets.items():
        if sheet.startswith("Proposed"):
            continue
        df = df[df["State"] == "TX"]
        for d in df.to_dict("records"):
            y = d.get("Operating Year")
            if y is None or y != y or str(y).strip() == "":
                continue
            out.append({"code": int(d["Plant Code"]), "plant": str(d["Plant Name"]), "county": str(d["County"]).upper(),
                        "gen": str(d["Generator ID"]), "tech": TECH_OF.get(str(d["Technology"])), "year": int(y)})
    return out


def _gen_pick(unit: str, gens: list) -> list:
    """The generators the unit code's trailing number picks out, else all of them."""
    m = _NUM.search(unit)
    if m:
        n = m.group(1).lstrip("0") or "0"
        hit = [g for g in gens if (re.findall(r"\d+", g["gen"]) or [""])[-1].lstrip("0") == n]
        if len(hit) == 1:
            return hit
    return gens


def match(units: list, eia: list, plant_names: dict, aliases: dict) -> list:
    by_code = defaultdict(list)
    for g in eia:
        by_code[g["code"]].append(g)
    by_name = defaultdict(set)
    for g in eia:
        by_name[norm(g["plant"])].add(g["code"])
    by_county = defaultdict(set)
    for g in eia:
        by_county[g["county"]].add(g["code"])
    rows = []
    for u in units:
        name, tech = u["unit"], u["tech"]
        code, how = None, None
        pn = plant_names.get(name)
        if pn:
            codes = [c for c in by_name.get(norm(pn), ()) if any(g["tech"] == tech for g in by_code[c])] \
                or list(by_name.get(norm(pn), ()))
            if len(codes) == 1:
                code, how = codes[0], "plant name"
        if code is None:
            want = words(u.get("plant") or "") | words(re.sub(r"_?(UNIT|G|CT|ST|U)?\d+[A-Z]?$", "", name))
            for a in aliases.get(name, ()):
                want |= words(a)
            want -= words(u.get("county") or "")   # Victoria Port is not every plant in Victoria County
            ph = phase(u.get("plant") or "")
            own =[words(u.get("plant") or ""), words(re.sub(r"_?(UNIT|G|CT|ST|U)?\d+[A-Z]?$", "", name))] \
                + [words(a) for a in aliases.get(name, ())]

            def best(codes, statewide):
                scored = []
                for c in codes:
                    if not any(g["tech"] == tech for g in by_code[c]):
                        continue
                    have = words(by_code[c][0]["plant"])
                    if not have or not want:
                        continue
                    p2 = phase(by_code[c][0]["plant"])
                    if (ph and p2 and ph != p2) or (p2 and p2 > 1 and not ph):
                        continue        # Panther Creek Wind 3 is not Panther Creek Wind Farm I
                    inter = len(want & have)
                    if statewide and not (inter and (have <= want or any(o and o <= have for o in own))):
                        continue        # far from the county: one name has to hold all of the other's words
                    fuzzy = max(difflib.SequenceMatcher(None, a, b).ratio() for a in want for b in have)
                    scored.append((inter + (fuzzy if fuzzy >= 0.8 else 0), c))
                scored.sort(reverse=True)
                if scored and scored[0][0] >= 1 and (len(scored) == 1 or scored[0][0] - scored[1][0] >= 0.5):
                    return scored[0][1]
                return None
            # in the unit's county; anywhere in Texas only when one name holds all of the other's
            # words (CDR and EIA sometimes disagree on the county of a plant that spans two)
            code = best(by_county.get((u.get("county") or "").upper(), ()), False)
            how = "county words" if code else None
            if code is None:
                code = best(by_code.keys(), True)
                how = "name words" if code else None
        if code is None:
            continue
        gens = [g for g in by_code[code] if g["tech"] == tech] or by_code[code]
        gens = _gen_pick(name, gens) if tech not in ("wind", "solar") else gens
        ys = [g["year"] for g in gens]
        rows.append({"unit": name, "tech": tech, "eia_plant": by_code[code][0]["plant"], "eia_code": code,
                     "first": min(ys), "last": max(ys), "gens": " ".join(sorted({g["gen"] for g in gens})), "match": how})
    return rows


def load() -> dict:
    """{unit: (first, last)} years from the CSV ({} without it)."""
    if not PATH.exists():
        return {}
    with open(PATH, newline="") as f:
        return {r["unit"]: (int(r["first"]), int(r["last"])) for r in csv.DictReader(f)}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("zip", help="EIA-860 annual release zip (eia860YYYY.zip)")
    args = ap.parse_args(argv)
    ui = read_json_gz(DATA_DIR / "unit_index.json.gz", default={}) or {}
    c = ui.get("columns") or []
    units = [{"unit": r[c.index("unit")], "tech": r[c.index("tech")], "plant": r[c.index("plant")],
              "county": r[c.index("county")]} for r in ui.get("rows", []) if r[c.index("tech")] != "storage"]
    with open(REF / "unit_companies.csv", newline="") as f:
        plant_names = {r["unit"]: r["company"] for r in csv.DictReader(f) if r["role"] == "plant name"}
    aliases = defaultdict(list)
    with open(REF / "unit_aliases.csv", newline="") as f:
        for r in csv.DictReader(f):
            aliases[r["unit"]].append(r.get("alias") or r.get("name") or "")
    manual = {}
    if PATH.exists():
        with open(PATH, newline="") as f:
            manual = {r["unit"]: r for r in csv.DictReader(f) if r["match"] == "manual"}
    rows = {r["unit"]: r for r in match(units, read_eia(args.zip), plant_names, aliases)}
    rows.update(manual)
    with open(PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for k in sorted(rows):
            w.writerow({x: rows[k][x] for x in FIELDS})
    by = defaultdict(lambda: [0, 0])
    for u in units:
        by[u["tech"]][0] += 1
        by[u["tech"]][1] += u["unit"] in rows
    print("in_service: " + ", ".join(f"{t} {m}/{n}" for t, (n, m) in sorted(by.items())), file=sys.stderr)


if __name__ == "__main__":
    main()
