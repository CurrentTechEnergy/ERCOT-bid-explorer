"""Which gas price each gas-fired unit buys at: Waha (West Texas) or Houston Ship Channel.
Needs no downloads.  Read by econ.py (and through it economics.html).

Two signals, from the data already loaded:

  offers    the unit's own daily offer prices follow one gas price more closely than the
            other.  Two series per unit, each fitted on its own: its first SCED offer price
            above $0 (trends_60d "first") and its DAM minimum-energy offer (dam/ "mingen").
            Each is regressed on the Waha and on the Houston Ship Channel price of the last
            trading day before the operating day (gas trades the day before it flows).  A
            series votes for a hub when it has at least MIN_DAYS days, the better fit explains
            at least MIN_R2 of the variance with a heat rate (slope) in HR_RANGE, and beats the
            other hub's fit by at least R2_MARGIN.  The two prices move together most of the
            time, so the votes come from the days they part, chiefly the Waha discount.
  location  the ERCOT hub whose hourly real-time price the unit's resource node tracks most
            closely (median absolute gap over the node days loaded).  West and Panhandle
            nodes sit in the Permian / West Texas gas market, so they default to Waha;
            everything else to Houston Ship Channel.

The offers decide when the votes agree (or only one series votes); otherwise location does.
Writes data/fuel_hubs.json.gz:
  {"hubs": {"waha": "Waha", "hsc": "Houston Ship Channel"},
   "units": {name: {"tech", "sp", "hub": "waha"|"hsc", "method": "offers"|"location"|"default",
                    "loc": nearest electrical hub or null,
                    "fits": {"first"|"mingen": {"n", "r2": {"waha", "hsc"}, "hr": {"waha", "hsc"},
                                                "vote": hub or null}}}}}
"""
import datetime as dt
import warnings

import numpy as np

from .config import DATA_DIR, GAS_HUBS, UNIT_DATA_DIR
from .nodes import settlement_points
from .parse_prices import node_hourly
from .store import read_json_gz, write_json_gz

GAS_TECHS = ("combined_cycle", "combustion_turbine", "gas_steam")
LOC_HUBS = ["HB_WEST", "HB_PAN", "HB_NORTH", "HB_SOUTH", "HB_HOUSTON"]
WAHA_LOCS = {"HB_WEST", "HB_PAN"}
MIN_DAYS = 15
MIN_R2 = 0.3
R2_MARGIN = 0.1
HR_RANGE = (3.0, 25.0)


def _gas_before(hub: dict, dates: list) -> np.ndarray:
    """Price on the last trading day strictly before each date (NaN before the first)."""
    hd = hub.get("dates", [])
    hv = hub.get("value", [])
    out = np.full(len(dates), np.nan)
    j, last = 0, np.nan
    for i, d in enumerate(dates):
        while j < len(hd) and hd[j] < d:
            if hv[j] is not None:
                last = hv[j]
            j += 1
        out[i] = last
    return out


def _fit(y: np.ndarray, g: np.ndarray):
    """(n, r2, slope) of y = a + b*g over days where both exist, or (n, None, None)."""
    ok = np.isfinite(y) & np.isfinite(g)
    n = int(ok.sum())
    if n < MIN_DAYS or np.ptp(g[ok]) == 0 or np.ptp(y[ok]) == 0:
        return n, None, None
    b, a = np.polyfit(g[ok], y[ok], 1)
    resid = y[ok] - (a + b * g[ok])
    r2 = 1 - float(np.sum(resid ** 2)) / float(np.sum((y[ok] - y[ok].mean()) ** 2))
    return n, round(r2, 3), round(float(b), 2)


def score(y: np.ndarray, gas: dict) -> dict:
    """Fit one offer series against every hub's gas price; the hub it votes for, if any."""
    n, r2, hr = 0, {}, {}
    for h, g in gas.items():
        n, r2[h], hr[h] = _fit(y, g)
    fitted = {h: v for h, v in r2.items() if v is not None}
    vote = None
    if len(fitted) == len(gas) >= 2:
        best = max(fitted, key=fitted.get)
        rest = max(v for h, v in fitted.items() if h != best)
        if fitted[best] >= MIN_R2 and fitted[best] - rest >= R2_MARGIN and HR_RANGE[0] <= hr[best] <= HR_RANGE[1]:
            vote = best
    return {"n": n, "r2": r2, "hr": hr, "vote": vote}


def _hub_hourly(day: dict) -> dict:
    """{hub: 24 hourly means} from a price day file's 15-minute hub prices."""
    out = {}
    for h in LOC_HUBS:
        v = ((day or {}).get("spp15") or {}).get(h)
        if not v or len(v) < 96:
            continue
        a = np.array([np.nan if x is None else x for x in v[:96]], float).reshape(24, 4)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out[h] = np.nanmean(a, axis=1)
    return out


def nearest_hubs(sps: set, node_days: list) -> dict:
    """{settlement point: the hub whose hourly price it tracks most closely}."""
    gaps = {sp: {h: [] for h in LOC_HUBS} for sp in sps}
    for d in node_days:
        nodes = node_hourly(read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz", default=None))
        hubs = _hub_hourly(read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz", default=None))
        if not nodes or not hubs:
            continue
        for sp in sps:
            v = nodes.get(sp)
            if not v:
                continue
            x = np.array([np.nan if p is None else p for p in v], float)
            for h, hv in hubs.items():
                gaps[sp][h].extend(np.abs(x - hv)[np.isfinite(x - hv)].tolist())
    out = {}
    for sp, g in gaps.items():
        med = {h: float(np.median(v)) for h, v in g.items() if len(v) >= 24}
        out[sp] = min(med, key=med.get) if med else None
    return out


def build_fuel_hubs(index: dict) -> None:
    hub_file = (read_json_gz(DATA_DIR / "gas_hubs.json.gz", default=None) or {}).get("hubs", {})
    if not all(h in hub_file for h in GAS_HUBS):
        print("fuel hubs: no Waha / Houston Ship Channel prices yet, skipped")
        return
    trends = read_json_gz(DATA_DIR / "trends_60d.json.gz", default=None) or {}
    tdates = trends.get("dates", [])
    gas_t = {h: _gas_before(hub_file[h], tdates) for h in GAS_HUBS}

    # DAM minimum-energy offers by unit and day
    dam_days = sorted(index["days"].get("dam", []))
    gas_d = {h: _gas_before(hub_file[h], dam_days) for h in GAS_HUBS}
    mingen, tech_of = {}, {}
    for i, d in enumerate(dam_days):
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz", default=None) or {}
        for name, u in (dd.get("units") or {}).items():
            if u.get("tech") not in GAS_TECHS:
                continue
            tech_of[name] = u["tech"]
            if u.get("mingen") is not None:
                mingen.setdefault(name, np.full(len(dam_days), np.nan))[i] = u["mingen"]

    first = {}
    for u in trends.get("units", []):
        if u.get("tech") in GAS_TECHS:
            tech_of.setdefault(u["unit"], u["tech"])
            first[u["unit"]] = np.array([np.nan if v is None else v for v in u.get("first", [])], float)

    sp_of = settlement_points(index)
    node_days = sorted(index["days"].get("nodes", []))
    loc_of = nearest_hubs({sp_of[n] for n in tech_of if n in sp_of}, node_days)

    units = {}
    for name in sorted(tech_of):
        fits = {}
        if name in first:
            fits["first"] = score(first[name], gas_t)
        if name in mingen:
            fits["mingen"] = score(mingen[name], gas_d)
        votes = {f["vote"] for f in fits.values() if f["vote"]}
        sp = sp_of.get(name)
        loc = loc_of.get(sp) if sp else None
        if len(votes) == 1:
            hub, method = votes.pop(), "offers"
        elif loc:
            hub, method = ("waha" if loc in WAHA_LOCS else "hsc"), "location"
        else:
            hub, method = "hsc", "default"
        units[name] = {"tech": tech_of[name], "sp": sp, "hub": hub, "method": method, "loc": loc, "fits": fits}
    write_json_gz(DATA_DIR / "fuel_hubs.json.gz", {
        "hubs": {h: name for h, (_, name) in GAS_HUBS.items()}, "units": units,
        "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    count = {}
    for u in units.values():
        count[(u["hub"], u["method"])] = count.get((u["hub"], u["method"]), 0) + 1
    print("fuel hubs: " + ", ".join(f"{h} by {m}: {n}" for (h, m), n in sorted(count.items())))
