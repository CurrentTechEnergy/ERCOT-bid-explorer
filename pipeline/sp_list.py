"""Two reference maps from ERCOT's Settlement Points List (NP4-160-SG, "Settlement Points List
and Electrical Buses Mapping"), for reading the outage reports (pipeline/outages.py) by unit in
the commitment forecast (Context.listed_out, Context.unseen_out).

Turbines of each combined-cycle train.  The unplanned outage report names turbines
(SUBSTATION_UNIT, e.g. FRNYPP_GT11); the 60-day disclosure names trains (FRNYPP_CC1).  The
list's Resource_Node_to_Unit table (RESOURCE_NODE, UNIT_SUBSTATION, UNIT_NAME) groups turbines by
the physical node they settle at, e.g. FRNYPP_1_CCU -> GT11, GT12, GT13, ST10.  A site with one
train takes every node there; at a site with several, the train number comes from the node name
(_1_CCU, CCU1, _CC1) or, failing that, from the one digit its turbines' names share.  A turbine
the 60-day disclosure reports as a resource of its own (an old steam unit or a peaker at the same
site, e.g. BRAUNIG_VHB1) is not part of a train.  Steam turbines are told apart by name (STEAM).

Zone of each resource node and substation.  The outage capacity report gives MW out by zone
(houston, north, south, west); the list's Settlement_Points table gives each node's and
substation's settlement load zone (LZ_HOUSTON, LZ_NORTH, LZ_SOUTH, LZ_WEST).

The list changes with the network model, a few times a year.  Refresh by hand from the zip on
ERCOT's site:
  python -m pipeline.sp_list SP_List_EB_Mapping/        (the unzipped folder)

Writes data/outages/cc_turbines.json.gz:
  {"source": file name, "trains": {train: {"gas": [turbine codes], "steam": [turbine codes]}}}
and data/outages/sp_zones.json.gz:
  {"source": file name, "node": {resource node: zone}, "sub": {substation: zone}}
"""
import io
import re
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd

from .config import DATA_DIR
from .store import read_json_gz, write_json_gz

TURBINES_PATH = DATA_DIR / "outages" / "cc_turbines.json.gz"
ZONES_PATH = DATA_DIR / "outages" / "sp_zones.json.gz"
STEAM = re.compile(r"(ST|STG|STM)_?\d*$|_S\d+$")     # steam turbine names; the rest are gas turbines
NODE_NUM = re.compile(r"_(\d+)_CCU|CCU(\d+)|_CC(\d+)")
ZONES = {"LZ_HOUSTON": "houston", "LZ_NORTH": "north", "LZ_SOUTH": "south", "LZ_WEST": "west"}


def build_turbines(csv_text: str, trains: list, others=()) -> dict:
    """Resource_Node_to_Unit CSV text, the CC train keys and every other unit key ->
    {train: {"gas": [...], "steam": [...]}}."""
    others = set(others)
    rn = pd.read_csv(io.StringIO(csv_text), dtype=str)
    rn.columns = [c.strip() for c in rn.columns]
    by_site = defaultdict(list)
    for k in trains:
        by_site[k.rsplit("_CC", 1)[0]].append(k)
    out = {}
    for (node, sub), g in rn.groupby(["RESOURCE_NODE", "UNIT_SUBSTATION"]):
        ts = by_site.get(sub)
        if not ts:
            continue
        if len(ts) == 1:
            t = ts[0]
        else:
            m = NODE_NUM.search(node)
            n = next((x for x in (m.groups() if m else ()) if x), None)
            if n is None:
                ds = {re.search(r"\d", u).group() for u in g["UNIT_NAME"] if re.search(r"\d", u)}
                n = ds.pop() if len(ds) == 1 else None
            t = f"{sub}_CC{n}" if n and f"{sub}_CC{n}" in ts else None
        if t is None:
            continue
        e = out.setdefault(t, {"gas": [], "steam": []})
        for u in g["UNIT_NAME"]:
            if f"{sub}_{u}" in others:
                continue
            e["steam" if STEAM.search(u) else "gas"].append(f"{sub}_{u}")
    return {t: {k: sorted(set(v)) for k, v in e.items()} for t, e in sorted(out.items())}


def build_zones(csv_text: str) -> dict:
    """Settlement_Points CSV text -> {"node": {resource node: zone}, "sub": {substation: zone}}."""
    sp = pd.read_csv(io.StringIO(csv_text), dtype=str)
    sp.columns = [c.strip() for c in sp.columns]
    sp["zone"] = sp["SETTLEMENT_LOAD_ZONE"].map(ZONES)
    sp = sp.dropna(subset=["zone"])
    node = {r: z for r, z in zip(sp["RESOURCE_NODE"], sp["zone"]) if isinstance(r, str) and r.strip()}
    sub = {}
    for s, z in zip(sp["SUBSTATION"], sp["zone"]):
        if isinstance(s, str) and s.strip():
            sub.setdefault(s, z)
    return {"node": dict(sorted(node.items())), "sub": dict(sorted(sub.items()))}


def save(folder: Path) -> None:
    rn = next(folder.glob("Resource_Node_to_Unit*.csv"))
    sp = next(folder.glob("Settlement_Points*.csv"))
    gu = (read_json_gz(DATA_DIR / "groups_60d.json.gz", default={}) or {}).get("units", {})
    cc = [k for k, v in gu.items() if v[0] == "combined_cycle"]
    trains = build_turbines(rn.read_text(), cc, [k for k in gu if k not in cc])
    write_json_gz(TURBINES_PATH, {"source": rn.name, "trains": trains})
    zones = build_zones(sp.read_text())
    write_json_gz(ZONES_PATH, {"source": sp.name, **zones})
    print(f"{len(trains)} of {len(cc)} CC trains mapped to turbines; {len(zones['node'])} resource nodes, "
          f"{len(zones['sub'])} substations zoned")


if __name__ == "__main__":
    save(Path(sys.argv[1]))
