"""The Turn-ons and Turn-offs page's "How the output was sold day-ahead" panel: each hour's real-time
output of thermal, wind and solar units, split by how much of it was sold in the day-ahead market.
Writes data/da_sold.json.gz.

Each unit-hour's output (telemetered, the 60-day SCED average) is split three ways, in this order:
  3p   covered by the unit's own three-part DAM energy award (the award, capped at the output)
  eo   covered by energy-only offer awards at the unit's settlement point by a QSE that represents
       a resource there (the DAM day file's eo.nodes "own"): the plant's own day-ahead sale,
       shared over the point's units in proportion to the output each has left after its
       three-part award, and capped at it
  rt   the rest: output with no day-ahead sale visible at the plant, settled at the real-time price
       (it may still be hedged at a hub, bilaterally or through a PPA, none of which ERCOT shows)
and, beside them, not part of the stack:
  over day-ahead sales beyond the output (an award or own energy-only sale the unit did not
       produce), bought back at the real-time price; energy-only sales the point's output could not
       cover are shared over its units by DAM HSL

Hours are put in the same price bands as commit_mix.py on the DA system lambda: "all", "lt10"
(under $10) and "lt0" (under $0).  Only DAM day files of format 4 on (with "eo") are used, so the
panel starts where the energy-only awards were parsed.  "ctx" carries the hour's energy-only awards
at hubs and load zones, and those by other QSEs at the resource points of these technologies, for
the panel's note.

Inputs (no ERCOT download; all the update run's own files):
  data/dam/{date}.json.gz         three-part awards, settlement points, HSL, energy-only awards
  data/60d-units/{date}.json.gz   output per resource and hour
  data/dam_lambda.json.gz         DA system lambda per hour

File:
  {"built", "from", "through",
   "hours": [[month, he, band, hours]],
   "rows":  [[month, he, tech, way (3p | eo | rt | over), band, mw_sum]],
   "ctx":   [[month, he, band, hub_eo_mw_sum, other_qse_eo_at_these_points_mw_sum]]}
  MW sums over the month's hours in that band; the page divides by the hours for an average.

    python -m pipeline.da_sold
"""
import datetime as dt
from collections import defaultdict

from .config import DATA_DIR
from .log import warn
from .commit_mix import BANDS, _bands
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "da_sold.json.gz"
TECHS = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine", "wind", "solar")
WAYS = ("3p", "eo", "rt", "over")
MIN_FORMAT = 4


def split_hour(units, own_eo):
    """One settlement point, one hour.  units: [(key, output, award, hsl)] -> {key: [3p, eo, rt, over]}."""
    out = {}
    left = {}
    for k, o, a, _ in units:
        o, a = max(o or 0.0, 0.0), max(a or 0.0, 0.0)
        p3 = min(a, o)
        out[k] = [p3, 0.0, 0.0, a - p3]
        left[k] = o - p3
    tot = sum(left.values())
    eo = max(own_eo or 0.0, 0.0)
    if tot > 0 and eo > 0:
        for k in left:
            x = min(left[k], eo * left[k] / tot)
            out[k][1] = x
            left[k] -= x
        eo = max(eo - tot, 0.0)
    if eo > 1e-9:
        wt = {k: max(h or 0.0, 0.0) for k, *_, h in units}
        if not sum(wt.values()):
            wt = {k: 1.0 for k in wt}
        s = sum(wt.values())
        for k in wt:
            out[k][3] += eo * wt[k] / s
    for k in out:
        out[k][2] = left[k]
    return out


def build():
    lam = (read_json_gz(DATA_DIR / "dam_lambda.json.gz", default=None) or {}).get("days", {})
    agg = defaultdict(float)
    ctx = defaultdict(lambda: [0.0, 0.0])
    hours = defaultdict(int)
    days = []
    for p in sorted((DATA_DIR / "dam").glob("*.json.gz")):
        day = p.name[:10]
        q = DATA_DIR / "60d-units" / p.name
        if not q.exists() or day not in lam:
            continue
        dam = read_json_gz(p, default=None)
        if not dam or (dam.get("format") or 0) < MIN_FORMAT or "eo" not in dam:
            continue
        u6 = read_json_gz(q, default=None)
        if not u6:
            continue
        days.append(day)
        month, L = day[:7], lam[day]
        bands = [_bands(L[h] if h < len(L) else None) for h in range(24)]
        for h in range(24):
            for b in bands[h]:
                hours[(month, h + 1, b)] += 1
        units, nodes = dam.get("units", {}), dam["eo"].get("nodes", {})
        cols = u6["columns"]
        io_ = cols.index("output") + 2
        names = u6["units"]
        # (sp, he) -> [(name, output, award, hsl)], every unit at the point (storage and hydro share
        # the point's own sale, though only TECHS are drawn); units with no DAM record are all rt
        at = defaultdict(list)
        tech_of = {}
        for r in u6["rows"]:
            nm, tech = names[r[0]][0], names[r[0]][2]
            he = r[1]
            if not 1 <= he <= 24:
                continue
            u = units.get(nm) or {}
            aw = (u.get("award") or [None] * 24)
            aw = aw[he - 1] if he - 1 < len(aw) else None
            at[(u.get("sp") or f"~{nm}", he)].append((nm, r[io_] or 0.0, aw, u.get("hsl")))
            tech_of[nm] = tech
        seen_sp = defaultdict(set)
        for (sp, he), us in at.items():
            own = nodes.get(sp)
            res = split_hour(us, (own[0][he - 1] if own and he - 1 < len(own[0]) else 0.0))
            for nm, v in res.items():
                t = tech_of[nm]
                if t not in TECHS:
                    continue
                for b in bands[he - 1]:
                    for w, x in zip(WAYS, v):
                        if x:
                            agg[(month, he, t, w, b)] += x
                seen_sp[he].add(sp)
        hub = dam["eo"].get("hub") or []
        for h in range(24):
            oth = sum(nodes[sp][1][h] for sp in seen_sp[h + 1] if sp in nodes and h < len(nodes[sp][1]))
            for b in bands[h]:
                c = ctx[(month, h + 1, b)]
                c[0] += hub[h] if h < len(hub) else 0.0
                c[1] += oth
    if not days:
        warn("da_sold: no days with format-4 DAM files and 60-day unit files; da_sold.json.gz left as it is")
        return
    write_json_gz(PATH, {
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": days[0], "through": days[-1],
        "hours": [[*k, v] for k, v in sorted(hours.items())],
        "rows": [[*k, round(v)] for k, v in sorted(agg.items()) if round(v)],
        "ctx": [[*k, round(v[0]), round(v[1])] for k, v in sorted(ctx.items())],
    })
    print(f"da_sold: {len(days)} days, {days[0]} to {days[-1]}")


if __name__ == "__main__":
    build()
