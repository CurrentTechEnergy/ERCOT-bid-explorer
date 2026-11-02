"""The Unit page's "Heat rate and fuel cost" panel (site/unit-fuel.js): each fossil unit's measured
heat rate and station use, and its cost of running at minimum by day against its own DAM
minimum-energy offer.  Needs no downloads.

  heat rate     pipeline/reference/unit_heat_rates.csv (pipeline/heat_rates): MMBtu per MWh of
                ERCOT net output at minimum and at full load, EPA hourly heat input over ERCOT
                telemetry; the technology median for a unit without one (basis "fallback")
  station use   pipeline/reference/station_use.csv (analysis/epa_heat_rates): EPA gross less
                ERCOT net output at minimum and at full load, gas steam and coal per unit, combined
                cycles per train (share only at full load); joint-ownership units carry the plant
                unit's numbers
  cost          $/MWh at minimum on each 60-day day: the unit's heat rate at minimum (a combustion
                turbine's measured one: the CT turn-on model itself reads 11.0) x the 7-day average
                of its own hub's gas price (the day-before prices of the day and the 6 before it,
                gas_by_hub; Henry Hub, with Ship Channel's monthly basis for Ship Channel units, on
                the days the hub has none, est 1 when any day of the 7 is filled), or for coal its
                delivered EIA-923 price that month (est 1 for the Texas average)
  offer         its DAM minimum-energy offer that day ($/MWh; a train's lowest configuration's)

The hub prices are licensed and are not published (pipeline/private.py): only the cost, a value
derived from them, reaches the file, as fuel_cost_60d does.

Writes data/unit_fuel.json.gz:
  {dates, units: {unit or CC train: {tech, hr_min, hr_full, min_hours, basis, epa, note,
   su: {gross_min, net_min, su_mw_min, su_share_min, su_mw_full, su_share_full, min_hours, epa,
   shared_with} | null, cost: [$/MWh | null per date], est: [0 | 1 per date], offer: [...]}}}
"""
import csv
import tempfile
from pathlib import Path

from . import heat_rates
from .config import DATA_DIR
from .decisions import _dam_trains
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "unit_fuel.json.gz"
SU_PATH = Path(__file__).parent / "reference" / "station_use.csv"
TECHS = ("coal", "gas_steam", "combined_cycle", "combustion_turbine")


def _num(v, kind=float):
    return None if v in (None, "") else kind(float(v))


AVG_DAYS = 7     # the gas price is the average of the day's and the 6 days before (Blair, Nov 2 2026)


def _gas_avg(gas, hub, dates):
    """{date: ($/MMBtu, estimated)}: the AVG_DAYS-day average of `hub`'s day-before price, filled
    from hub_fill and then Henry Hub on the days it has none."""
    import datetime as dt
    out = {}
    for d in dates:
        day = dt.date.fromisoformat(d)
        v, est = [], False
        for k in range(AVG_DAYS):
            x = (day - dt.timedelta(days=k)).isoformat()
            p = gas.get(hub, {}).get(x)
            if p is None:
                p = gas.get(f"{hub}_fill", {}).get(x)
                if p is None:
                    p = gas.get("hh", {}).get(x)
                est = est or p is not None
            if p is not None:
                v.append(p)
        out[d] = (sum(v) / len(v), est) if v else (None, True)
    return out


def build_unit_fuel(index=None) -> int:
    from .decision_table import gas_by_hub, hub_of
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    dates = [d for d in (uh.get("dates") or []) if (DATA_DIR / "dam" / f"{d}.json.gz").exists()]
    if not dates:
        return 0
    hr = {}
    with open(heat_rates.PATH, newline="") as f:
        for r in csv.DictReader(f):
            hr[(r["tech"], r["unit"])] = r
    su = {}
    with open(SU_PATH, newline="") as f:
        for r in csv.DictReader(f):
            su[r["unit"]] = {k: (_num(v, int) if k == "min_hours" else v or None if k in ("epa", "shared_with") else _num(v))
                             for k, v in r.items() if k not in ("unit", "tech")}
    with tempfile.TemporaryDirectory() as tmp:
        gas = gas_by_hub(Path(tmp))
    hubs = hub_of()
    avg = {h: _gas_avg(gas, h, dates) for h in ("hsc", "waha")}
    units = {}
    for i, d in enumerate(dates):
        for key, e in _dam_trains(read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") or {}).items():
            t = e["tech"]
            if t not in TECHS:
                continue
            u = units.get(key)
            if u is None:
                r = hr.get((t, key))
                fb = hr.get((t, "*"))
                own = r is not None and r["basis"] != "fallback"
                s = r if own else fb
                u = units[key] = {"tech": t, "hr_min": _num(s["hr_min"]), "hr_full": _num(s["hr_full"]),
                                  "min_hours": _num(s["min_hours"], int) if own else None, "basis": s["basis"],
                                  "epa": (r or {}).get("epa") or None, "note": (r or fb)["note"] or None,
                                  "su": su.get(key), "cost": [None] * len(dates), "est": [0] * len(dates), "offer": [None] * len(dates)}
            if t == "coal":
                p, own = heat_rates.coal_price(key, d)
                c, est = heat_rates.at_min(t, key)[0] * p, not own
            else:
                p, est = avg[hubs.get(key, "hsc")][d]
                c = None if p is None else heat_rates.at_min(t, key)[0] * p
            u["cost"][i] = None if c is None else round(c, 2)
            u["est"][i] = int(bool(est))
            u["offer"][i] = None if e["mingen"] is None else round(e["mingen"], 2)
    write_json_gz(PATH, {"dates": dates, "units": dict(sorted(units.items()))})
    print(f"unit_fuel: {len(units)} units, {len(dates)} days", flush=True)
    return len(units)
