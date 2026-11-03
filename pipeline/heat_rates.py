"""Each fossil unit's measured heat rate at minimum output and at full load (MMBtu per MWh of
ERCOT net output), from EPA's hourly stack data, with a technology fallback.

Source: pipeline/reference/unit_heat_rates.csv, built by analysis/epa_heat_rates (see its
README).  EPA CAMPD reports each boiler's or gas turbine's hourly heat input and gross load; the
build matches EPA units to ERCOT resources (plant code and unit number; combined-cycle gas
turbines to the train whose online hours they follow) and divides heat input by the unit's
hourly telemetered net output from the history release's thermal-YYYY-MM files, same hour,
steady hours only (gas steam and coal at least 6 hours into a run, combined cycles 4).
"At minimum" is ERCOT's running-at-minimum state ("m"), so station use behind the unit's meter
is inside the number: about 8% of gross at minimum for gas steam, 11% for coal, against 3% and
6% at full load.

Columns:
  unit        ERCOT unit (gas steam, coal) or CC train; "*" is the technology fallback
  tech        coal | combined_cycle | gas_steam | combustion_turbine
  hr_min      heat rate at minimum (MMBtu/MWh net)
  hr_full     heat rate in the unit's top 10% of hours by output
  min_hours   steady hours at minimum behind hr_min
  basis       ercot_net (measured on ERCOT telemetry), eia923 (EPA gross scaled by EIA-923 net,
              where telemetry had too few hours), fallback (the technology median)
  epa         EPA facility id / unit id
  note        why a unit is on the fallback

Fallbacks (medians of the measured units, Nov 2026): gas steam 13.4, coal 11.9, combined cycle
7.8 (cogeneration trains excluded: their net to the grid leaves out the host's load, so they take
the fallback), combustion turbine 13.4 (EPA gross with an assumed 2% station use).  107
combustion turbines have their own row (Nov 2026: matched to the EPA unit whose hourly output
tracks theirs, 2024-25, analysis/epa_heat_rates/ct_match.py and ct_hr.py; at least 30 steady hours
at minimum), shown on the Unit page; the CT turn-on model reads a flat 11.0 (gascost), which
backtested better.  Joint-ownership coal units (FPPYD1_FPP_G1_J01 and _J02, ...) share one value.
"""
import bisect
import csv
from pathlib import Path

PATH = Path(__file__).parent / "reference" / "unit_heat_rates.csv"
COAL_PATH = Path(__file__).parent / "reference" / "coal_prices.csv"
COAL_PRICE = 2.00    # $/MMBtu delivered coal without a month in COAL_PATH (Fleet economics' flat value)
_T = {}
_C = {}


def _load():
    if not _T:
        with open(PATH, newline="") as f:
            for r in csv.DictReader(f):
                _T[(r["tech"], r["unit"])] = (float(r["hr_min"]), float(r["hr_full"]), r["basis"])
    return _T


def fallback(tech):
    """(hr_min, hr_full) of the technology median, or None for a technology with none."""
    v = _load().get((tech, "*"))
    return v[:2] if v else None


AT_MIN = {t: fallback(t)[0] for t in ("coal", "combined_cycle", "gas_steam", "combustion_turbine")}   # per-technology


def at_min(tech, unit):
    """(heat rate at minimum MMBtu/MWh, measured): the unit's (or CC train's) own value, else its
    technology's fallback (measured False); None for a technology with no entry."""
    t = _load()
    v = t.get((tech, unit))
    if v is not None and v[2] != "fallback":
        return v[0], True
    fb = t.get((tech, "*"))
    return (fb[0], False) if fb else None


def _coal():
    """{EIA plant id or "*": (months, $/MMBtu)} from COAL_PATH, and {unit: plant id} for coal."""
    if not _C:
        by = {}
        with open(COAL_PATH, newline="") as f:
            for r in csv.DictReader(f):
                by.setdefault(r["fac"], []).append((r["month"], float(r["usd_mmbtu"])))
        _C["price"] = {k: ([m for m, _ in sorted(v)], [p for _, p in sorted(v)]) for k, v in by.items()}
        plant = {}
        with open(PATH, newline="") as f:
            for r in csv.DictReader(f):
                if r["tech"] == "coal" and r["epa"]:
                    plant[r["unit"]] = r["epa"].split("/")[0]
        _C["plant"] = plant
    return _C


def coal_price(unit, date):
    """($/MMBtu, own) delivered coal for coal `unit` in the month of `date` (YYYY-MM-DD), from
    EIA-923 Page 5 (Fuel Receipts and Costs, monthly by plant; pipeline/reference/coal_prices.csv):
    the plant's own price that month (own True) where it reports one (public power: Fayette,
    J K Spruce, San Miguel), else the month's average over the Texas plants reporting
    subbituminous coal (the merchant plants withhold theirs).  A month after the last in the file
    takes the latest month; before the first, the first; no file entry at all, COAL_PRICE.
    San Miguel's own price (about $3.2 to $4/MMBtu) is its mine-mouth South Texas lignite: 10.3
    MMBtu/ton and 30% ash, against about 17 and 5% for Powder River Basin coal, from a dedicated
    cost-plus mine whose fixed costs are spread over a falling burn, so much of it is not saved
    by backing down.  Oak Grove burns lignite too (13.6 MMBtu/ton) but withholds its price."""
    c = _coal()
    m = date[:7]
    for key, own in ((c["plant"].get(unit), True), ("*", False)):
        ms, ps = c["price"].get(key, ([], []))
        if key is None or not ms:
            continue
        i = bisect.bisect_right(ms, m) - 1
        if key != "*" and (i < 0 or ms[i] != m):
            continue        # the plant reported no price that month
        return ps[max(i, 0)], own
    return COAL_PRICE, False
