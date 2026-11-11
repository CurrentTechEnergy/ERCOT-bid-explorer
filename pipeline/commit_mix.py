"""The Day-ahead offers page's "How thermal is committed" panel: online thermal minimum output
(LSL) and output each hour, split by the unit's day-ahead position that hour.  Writes
data/commit_mix.json.gz.

  self   DAM resource status ON (or another on status): the owner committed it in the COP
  dam    status not on and a DAM energy award of at least AWARD_LSL x its DAM LSL: committed by
         the day-ahead market on its three-part offer (make-whole eligible)
  ruc    committed by ERCOT (RUC) that hour, from data/unit_hours_60d.json.gz; first, whatever its DAM
         position, since RUC is ERCOT's call (and purple wherever the site marks RUC)
  rt     online with none of these: committed after the DAM (real-time self-commitment)

Online: online in at least half the hour's SCED runs (online_share >= 0.5), as elsewhere on the
site.  Each hour is also put in price bands on the DA system lambda (the site's cheap-hour price):
"all", "lt10" (under $10) and "lt0" (under $0).  The status is the DAM file's hourly status where it
has one, else the day's.

Inputs (no ERCOT download; all already on hand, the update run's own files):
  data/dam/{date}.json.gz         DAM status, energy award and LSL per resource
  data/60d-units/{date}.json.gz   online share, LSL and base point per resource and hour
  data/dam_lambda.json.gz         DA system lambda per hour
  data/unit_hours_60d.json.gz     RUC hours per unit

File:
  {"built", "from", "through",
   "hours": [[month, he, band, hours]],
   "rows":  [[month, he, tech, position (self | dam | ruc | rt), band, lsl_mw_sum, output_mw_sum]]}
  MW sums over the month's hours in that band; the page divides by the hours for an average.

    python -m pipeline.commit_mix
"""
import datetime as dt
from collections import defaultdict

from .config import DATA_DIR
from .log import warn
from .models.operator_informed import ON_STATUS
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "commit_mix.json.gz"
TECHS = ("combined_cycle", "gas_steam", "coal", "combustion_turbine")
POSITIONS = ("self", "dam", "ruc", "rt")
BANDS = ("all", "lt10", "lt0")
AWARD_LSL = 0.95       # an award this share of the DAM LSL or more is a commitment (as make-whole/implied-make-whole.md)
ONLINE = 0.5


def _bands(price):
    out = ["all"]
    if price is not None and price < 10:
        out.append("lt10")
    if price is not None and price < 0:
        out.append("lt0")
    return out


def position(u, he):
    """self | dam | rt for a DAM unit record at hour ending he (None: no DAM record)."""
    if not u:
        return "rt"
    sh = u.get("status_h") or [u.get("status") or ""] * 24
    st = str(sh[he - 1] or "").upper()
    if st in ON_STATUS:
        return "self"
    aw = (u.get("award") or [None] * 24)[he - 1] or 0
    lsl = u.get("lsl") or 0
    return "dam" if aw > 0 and aw >= AWARD_LSL * lsl else "rt"


def build():
    lam = (read_json_gz(DATA_DIR / "dam_lambda.json.gz", default=None) or {}).get("days", {})
    ruc = set()
    for unit, spans in ((read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default=None) or {}).get("ruc") or {}).items():
        for day, hes in spans:
            ruc.update((unit, day, he) for he in hes)
    agg = defaultdict(lambda: [0.0, 0.0])
    hours = defaultdict(int)
    days = []
    for p in sorted((DATA_DIR / "dam").glob("*.json.gz")):
        day = p.name[:10]
        q = DATA_DIR / "60d-units" / p.name
        if not q.exists() or day not in lam:
            continue
        dam, u6 = read_json_gz(p, default=None), read_json_gz(q, default=None)
        if not dam or not u6:
            continue
        days.append(day)
        month, L = day[:7], lam[day]
        bands = [_bands(L[h] if h < len(L) else None) for h in range(24)]
        for h in range(24):
            for b in bands[h]:
                hours[(month, h + 1, b)] += 1
        cols = u6["columns"]
        io, il, ib = (cols.index(c) + 2 for c in ("online_share", "lsl", "base_point"))
        names, units = u6["units"], dam.get("units", {})
        for r in u6["rows"]:
            nm, tech = names[r[0]][0], names[r[0]][2]
            he = r[1]
            if tech not in TECHS or not 1 <= he <= 24 or (r[io] or 0) < ONLINE:
                continue
            pos = "ruc" if (nm, day, he) in ruc else position(units.get(nm), he)
            for b in bands[he - 1]:
                a = agg[(month, he, tech, pos, b)]
                a[0] += r[il] or 0
                a[1] += r[ib] or 0
    if not days:
        warn("commit_mix: no days with both DAM and 60-day unit files; commit_mix.json.gz left as it is")
        return
    write_json_gz(PATH, {
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": days[0], "through": days[-1],
        "hours": [[*k, v] for k, v in sorted(hours.items())],
        "rows": [[*k, round(v[0]), round(v[1])] for k, v in sorted(agg.items())],
    })
    print(f"commit_mix: {len(days)} days, {days[0]} to {days[-1]}")


if __name__ == "__main__":
    build()
