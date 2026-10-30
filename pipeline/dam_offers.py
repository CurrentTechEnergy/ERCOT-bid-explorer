"""Day-ahead three-part offers: every day, every unit, what it asked the DAM for and when that
changed.  Needs no downloads.  Read by the Day-ahead offers page, the Unit page and events.py.

Thermal units (combined cycle by configuration, gas steam, combustion turbines) and the wind and
solar units that file a DAM energy curve, from the DAM day files (parse_dam.py), DA lambda, the
unit's gas hub (fuel_hub.py) and hub prices (gas.py), and the wind/solar real-time floors kept by
renew_changes.py.

Fuel-cost line.  A unit's minimum-energy offer is set against REF_HR (MMBtu/MWh) times the gas
price at its own hub, Waha or Houston Ship Channel, on the last trading day before the operating
day.  REF_HR is EIA's average tested heat rate by prime mover for natural gas (Electric Power
Annual, Table 8.2, 2025: full load, US utilities and IPPs, weighted by net summer capacity).  A
unit burns more per MWh at its minimum than at full load, so an offer under the line is below fuel
cost with room to spare.  The implied heat rate is the offer over the gas price, as on the Offers
page.

Cheap hours are hours with DA lambda at or below CHEAP_USD.  On a day with any, a unit's
cheap-stretch offer is its minimum-energy cost averaged over those hours (the hourly values when
the day file has them, format 3 on, else the daily median), its margin is its node's mean DA price
over those hours less that offer, and it is awarded through the stretch with an energy award in at
least half of them.

Signature per unit-day (data/dam_offers/sig-YYYY.json.gz, one array per field, one value per
date, null where the unit has no value):
  thermal   f   1 three-part offer filed, 0 in the file without one
            mg  minimum-energy cost, daily median ($/MWh)       mc  cheap-stretch offer
            ih  implied heat rate (mg / gas)                     mk  mg less the fuel-cost line
            ma  cheap-stretch margin                             aw  1/0 awarded through it
            ho  hot start cost ($)                               ls  LSL (MW)
            iv  1 when the minimum-energy cost changed within the day
            hs  HSL (MW)
  renewable fl  DA floor: first price of the day's most used curve
            rt  real-time floor that day (renew_changes signature)
            as  DA award / HSL energy over hours with HSL

Changes, on each unit's filing days in date order (thresholds below):
  mingen_step   the offer moves STEP_USD or more from its prior PRIOR-day median (never reaching
                back past its last step) and at least MIN_HELD of the next HOLD filing days stay
                within STEP_TOL of the new level.  Tested on the offer, so a gas move alone is not a
                step; major when its markup crosses the fuel-cost line
  priced_out    1 to EP_MAX filing days PO_USD or more above the unit's prior 30-day median, then
                back within PO_USD / 2; major when it covers a cheap day
  start_change  the hot start moves START_PCT or more and holds the same way
  filing_off    a train or unit that filed on FILE_SHARE of the prior 30 days files nothing for
                HOLD days while listed on (ON...) on at least 3 of them: self-scheduled.  Major
  filing_on     no filing in the prior 30 days, then on MIN_HELD of the next HOLD.  Major
  renew_floor   a wind or solar DA floor moves STEP_USD and holds, as mingen_step
  renew_off / renew_on   a wind or solar unit stops filing a DA curve for RENEW_OFF days, or starts
Combustion turbines start rather than ride through, so their events are never major.  Units of
one plant (combined cycle configurations of one train) changing the same way within a day are one
event.  A plant with REPRICE or more mingen_step events in a year is a "re-pricer"; its events
stay listed.

Writes data/dam_offers.json.gz: ref (heat rates and source), params, kinds, first, last, events
(newest first), fleet (one value per day: combined cycle trains filing, awarded through the cheap
stretch, offering a configuration at or below ZERO_USD, offering HIGH_USD or more; on cheap days
the median train cheap-stretch offer less the fuel-cost line, kept on through the stretch (its awarded configuration) and not (its
lowest configuration); share of three-part LSL MW below the fuel line; median margin; median renewable
DA less RT floor), bins (award rate by cheap-stretch margin), mk_hist (the trains' offer less the
fuel-cost line, as in fleet, pooled over every cheap day: counts per MK_STEP bin, awarded through
the stretch and not, with each group's median), trains (per train or plant: cheap
days filed, share awarded, median lowest offer and implied heat rate, price-outs, steps, Unit page
name), renew (per wind or solar unit: days filed, median DA and RT floors, gap, award share) and
repricers.
"""
import bisect
import collections
import datetime as dt
import re

import numpy as np

from . import private
from .config import DATA_DIR
from .log import warn
from .renew_changes import plant_of as renew_plant
from .store import read_json_gz, write_json_gz

PATH = DATA_DIR / "dam_offers.json.gz"
SIG_DIR = DATA_DIR / "dam_offers"
REF_HR = {"combined_cycle": 7.535, "gas_steam": 10.293, "combustion_turbine": 10.975}
REF_SOURCE = {"name": "EIA, Electric Power Annual, Table 8.2: Average Tested Heat Rates by Prime Mover and Energy Source (natural gas, 2025)",
              "url": "https://www.eia.gov/electricity/annual/html/epa_08_02.html"}
THERMAL = tuple(REF_HR)
RENEW = ("wind", "solar")
ON = {"ON", "ONOS", "ONRUC", "ONREG", "ONOPTOUT", "ONEMR", "ONTEST", "ONDSR"}
CHEAP_USD = 10
STEP_USD, STEP_TOL = 5.0, 2.5
PO_USD, EP_MAX = 10.0, 6
START_PCT, START_TOL = 0.25, 0.10
PRIOR, HOLD, MIN_HELD, MIN_DAYS = 14, 7, 5, 20
FILE_SHARE, RENEW_OFF = 0.7, 14
REPRICE = 10
ZERO_USD, HIGH_USD = 1.0, 20.0
MK_LO, MK_HI, MK_STEP = -40, 30, 2      # offer less fuel cost histogram ($/MWh); values beyond fall in the end bins
BINS = [-10, -5, -2, 0, 2, 5, 10]
KINDS = {
    "mingen_step": "Minimum-energy offer stepped",
    "priced_out": "Priced out of the day-ahead",
    "start_change": "Start-up cost changed",
    "filing_off": "Stopped three-part offers",
    "filing_on": "Started three-part offers",
    "renew_floor": "Day-ahead floor changed",
    "renew_off": "Stopped day-ahead offers",
    "renew_on": "Started day-ahead offers",
}
FIELDS = {"thermal": ["f", "mg", "mc", "ih", "mk", "ma", "aw", "ho", "ls", "iv", "hs"], "renew": ["fl", "rt", "as"]}


def train_of(name: str) -> str:
    m = re.match(r"^(.*_CC\d+)_", name)
    return m.group(1) if m else name


def plant_of(name: str, tech: str) -> str:
    """Combined cycle by train; wind and solar as renew_changes groups them; other thermal units
    by their name up to a trailing unit number."""
    if tech == "combined_cycle":
        return train_of(name)
    if tech in RENEW:
        return renew_plant(name)
    return re.sub(r"_?(UNIT|CT|GT|ST|STG|G|U)?_?\d+[A-Z]?$", "", name).rstrip("_") or name


def _r(x, nd=2):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _gas_lookup(hubs):
    series = {k: (v.get("dates") or [], v.get("value") or []) for k, v in (hubs.get("hubs") or {}).items()}

    def gas(hub, day):
        d, v = series.get(hub) or series.get("hsc") or ([], [])
        i = bisect.bisect_left(d, day) - 1           # last trading day before the operating day
        while i >= 0 and v[i] is None:
            i -= 1
        return v[i] if i >= 0 else None
    return gas


def _rt_floors():
    out = {}
    for p in sorted(DATA_DIR.glob("renew/sig-*.json.gz")):
        s = read_json_gz(p, default={}) or {}
        dates = s.get("dates") or []
        for n, u in (s.get("units") or {}).items():
            for d, fl in zip(dates, u.get("fl") or []):
                if fl is not None:
                    out[(n, d)] = fl
    return out


def unit_day(u, day, cheap, ref, gas_price, rt):
    """One unit's signature values for one day (dict of FIELDS), or None."""
    t = u.get("tech")
    aw = [(a or 0) for a in (u.get("award") or [])]
    spp = u.get("spp") or []
    if t in THERMAL:
        mg = u.get("mingen")
        r = {"f": 1 if mg is not None else 0, "ls": u.get("lsl"), "hs": u.get("hsl")}
        if mg is None:
            return r
        hot = (u.get("start") or [None])[0]
        r.update(mg=mg, ho=hot, iv=1 if u.get("mingen_var") else None)
        if gas_price:
            r["ih"] = _r(mg / gas_price)
            r["mk"] = _r(mg - ref * gas_price)
        if cheap:
            mh = u.get("mingen_h")
            r["mc"] = _r(_mean([mh[i] for i in cheap if i < len(mh)])) if mh else mg
            node = _mean([spp[i] for i in cheap if i < len(spp)])
            if node is not None and r["mc"] is not None:
                r["ma"] = _r(node - r["mc"])
            r["aw"] = 1 if sum(1 for i in cheap if i < len(aw) and aw[i] > 0.5) >= len(cheap) / 2 else 0
        return r
    if t in RENEW:
        ci = [c for c in (u.get("curve") or []) if c is not None]
        if not ci or not u.get("curves"):
            return None
        c = collections.Counter(ci).most_common(1)[0][0]
        r = {"fl": u["curves"][c][0][0], "rt": rt}
        hh = u.get("hsl_h") or [u.get("hsl")] * len(aw)
        e = sum(h or 0 for h in hh)
        if e > 0:
            r["as"] = _r(sum(max(a, 0) for a in aw) / e, 3)
        return r
    return None


def build_signatures(days):
    """-> (dates, {unit: {"tech", "plant", "hub", field: [per date]}}, cheap-day flags, node prices kept per unit-day)"""
    lam = (read_json_gz(DATA_DIR / "dam_lambda.json.gz", default={}) or {}).get("days") or {}
    fh = (read_json_gz(DATA_DIR / "fuel_hubs.json.gz", default={}) or {}).get("units") or {}
    gas = _gas_lookup(private.read("gas_hubs.json.gz", default={}) or {})
    rt = _rt_floors()
    units, cheapdays, status = {}, [], {}
    for k, day in enumerate(days):
        d = read_json_gz(DATA_DIR / "dam" / f"{day}.json.gz", default=None)
        if not d:
            cheapdays.append(False)
            continue
        H = d.get("hours", 24)
        L = lam.get(day) or []
        cheap = [i for i, x in enumerate(L) if x is not None and x <= CHEAP_USD] if len(L) == H else []
        cheapdays.append(bool(cheap))
        for n, u in (d.get("units") or {}).items():
            t = u.get("tech")
            if t not in THERMAL and t not in RENEW:
                continue
            hub = (fh.get(n) or {}).get("hub") or "hsc"
            r = unit_day(u, day, cheap, REF_HR.get(t, 0), gas(hub, day) if t in THERMAL else None, rt.get((n, day)))
            if r is None:
                continue
            rec = units.get(n)
            if rec is None:
                kind = "thermal" if t in THERMAL else "renew"
                rec = units[n] = {"tech": t, "plant": plant_of(n, t), **({"hub": hub} if t in THERMAL else {}),
                                  **{f: [None] * len(days) for f in FIELDS[kind]}}
            for f, v in r.items():
                if f in rec:
                    rec[f][k] = v
            if t in THERMAL:
                status[(n, k)] = u.get("status") or ""
    return units, cheapdays, status


# ------------------------------------------------------------------ changes --
def _held(days, v, step, tol, rel=False):
    """Indices where a held step starts, with (prior median, new median).  The prior window never
    reaches back past the last step, so a window straddling both levels can't re-report it."""
    out, i, last = [], PRIOR, 0
    while i <= len(v) - HOLD:
        prior = float(np.median(v[max(last, i - PRIOR):i]))
        post = v[i:i + HOLD]
        new = float(np.median(post))
        mv = (new - prior) / prior if rel and prior else new - prior
        t = tol * abs(new) if rel else tol
        if abs(mv) >= step and (np.abs(post - new) <= t).sum() >= MIN_HELD and abs(v[i] - new) <= t:
            out.append((i, prior, new))
            last = i
            i += HOLD
        else:
            i += 1
    return out


def detect(dates, units, cheapdays, status):
    """-> unit-level change rows"""
    rows = []

    def add(unit, rec, k, kind, before, after, major, **extra):
        rows.append({"date": dates[k], "unit": unit, "plant": rec["plant"], "tech": rec["tech"], "kind": kind,
                     "before": before, "after": after, "major": bool(major) and rec["tech"] != "combustion_turbine", **extra})

    for n, rec in units.items():
        if rec["tech"] in THERMAL:
            ks = [k for k, v in enumerate(rec["mg"]) if v is not None]
            if len(ks) < MIN_DAYS:
                continue
            mg = np.array([rec["mg"][k] for k in ks], float)
            mk = np.array([rec["mk"][k] if rec["mk"][k] is not None else np.nan for k in ks], float)
            last = 0
            for i, a, b in _held(ks, mg, STEP_USD, STEP_TOL):
                ma, mb = np.nanmedian(mk[max(last, i - PRIOR):i]), np.nanmedian(mk[i:i + HOLD])
                last = i
                cross = np.isfinite(ma) and np.isfinite(mb) and (ma < 0) != (mb < 0)
                add(n, rec, ks[i], "mingen_step", _r(a), _r(b), cross, mk_before=_r(ma), mk_after=_r(mb))
            med = [None] * len(mg)
            for i in range(len(mg)):
                w = mg[max(0, i - 30):i]
                med[i] = float(np.median(w)) if len(w) >= 10 else None
            i = 0
            while i < len(mg):
                if med[i] is not None and mg[i] - med[i] >= PO_USD:
                    j = i
                    while j + 1 < len(mg) and med[j + 1] is not None and mg[j + 1] - med[i] >= PO_USD:
                        j += 1
                    if j - i + 1 <= EP_MAX and j + 1 < len(mg) and abs(mg[j + 1] - med[i]) <= PO_USD / 2:
                        span = [ks[q] for q in range(i, j + 1)]
                        aws = [rec["aw"][q] for q in span if rec["aw"][q] is not None]
                        add(n, rec, ks[i], "priced_out", _r(med[i]), _r(float(np.median(mg[i:j + 1]))),
                            any(cheapdays[q] for q in span), days=j - i + 1, aw=sum(aws) if aws else None)
                    i = j + 1
                else:
                    i += 1
            ho = np.array([rec["ho"][k] if rec["ho"][k] is not None else np.nan for k in ks], float)
            if np.isfinite(ho).all() and (ho > 0).all():
                for i, a, b in _held(ks, ho, START_PCT, START_TOL, rel=True):
                    add(n, rec, ks[i], "start_change", _r(a, 0), _r(b, 0), False)
        else:
            ks = [k for k, v in enumerate(rec["fl"]) if v is not None]
            if len(ks) >= MIN_DAYS:
                fl = np.array([rec["fl"][k] for k in ks], float)
                for i, a, b in _held(ks, fl, STEP_USD, STEP_TOL):
                    add(n, rec, ks[i], "renew_floor", _r(a), _r(b), False)
            f = [v is not None for v in rec["fl"]]
            for k in range(30, len(dates) - RENEW_OFF + 1):
                if sum(f[k - 30:k]) >= FILE_SHARE * 30 and f[k - 1] and not any(f[k:k + RENEW_OFF]):
                    add(n, rec, k, "renew_off", "day-ahead curve", "none", False)
                if not any(f[k - 30:k]) and f[k] and sum(f[k:k + HOLD]) >= MIN_HELD:
                    add(n, rec, k, "renew_on", "none", "day-ahead curve", False)
    # three-part filing by plant (train): any of its units filing that day, listed on that day
    by_plant = collections.defaultdict(list)
    for n, rec in units.items():
        if rec["tech"] in THERMAL:
            by_plant[rec["plant"]].append(n)
    for p, names in by_plant.items():
        rec = units[names[0]]
        filed = [any(units[n]["f"][k] == 1 for n in names) for k in range(len(dates))]
        on = [any(status.get((n, k)) in ON for n in names) for k in range(len(dates))]
        prow = {"plant": p, "tech": rec["tech"]}
        for k in range(30, len(dates) - HOLD + 1):
            if sum(filed[k - 30:k]) >= FILE_SHARE * 30 and filed[k - 1] and not any(filed[k:k + HOLD]) and sum(on[k:k + HOLD]) >= 3:
                add(p, prow, k, "filing_off", "three-part offer", "self-scheduled while on", True)
            if not any(filed[k - 30:k]) and filed[k] and sum(filed[k:k + HOLD]) >= MIN_HELD:
                add(p, prow, k, "filing_on", "no three-part offer", "three-part offer", True)
    return rows


def merge(rows):
    """One event per plant: same kind on the same or the next day."""
    rows = sorted(rows, key=lambda r: (r["plant"], r["kind"], r["date"]))
    out = []
    for r in rows:
        last = out[-1] if out else None
        if (last and last["plant"] == r["plant"] and last["kind"] == r["kind"]
                and (dt.date.fromisoformat(r["date"]) - dt.date.fromisoformat(last["_end"])).days <= 1):
            if r["unit"] not in last["units"]:
                last["units"].append(r["unit"])
            last["major"] = last["major"] or r["major"]
            last["_end"] = r["date"]
            continue
        e = {k: v for k, v in r.items() if k != "unit"}
        e["units"], e["_end"] = [r["unit"]], r["date"]
        out.append(e)
    for e in out:
        e.pop("_end")
        e["units"].sort()
    return sorted(out, key=lambda e: (e["date"], e["plant"], e["kind"]), reverse=True)


# -------------------------------------------------------------------- fleet --
def fleet(dates, units, cheapdays):
    n = len(dates)
    cc = {u: r for u, r in units.items() if r["tech"] == "combined_cycle"}
    trains = collections.defaultdict(list)
    for u, r in cc.items():
        trains[r["plant"]].append(r)
    keys = ("trains_filed", "trains_aw", "trains_zero", "trains_high", "mk_aw", "mk_no", "below_mw_share", "margin", "renew_gap")
    out = {k: [None] * n for k in keys}
    pool_a, pool_n = [], []
    for k in range(n):
        if cheapdays[k]:
            filed = aw = zero = high = 0
            for rs in trains.values():
                offers = [r["mc"][k] for r in rs if r["mc"][k] is not None]
                if not offers:
                    continue
                filed += 1
                aw += any(r["aw"][k] == 1 for r in rs)
                zero += min(offers) <= ZERO_USD
                high += min(offers) >= HIGH_USD
            out["trains_filed"][k], out["trains_aw"][k], out["trains_zero"][k], out["trains_high"][k] = filed, aw, zero, high
            ma = [r["ma"][k] for r in cc.values() if r["ma"][k] is not None]
            out["margin"][k] = _r(float(np.median(ma))) if ma else None
            # by train, since a train runs one configuration at a time: a train kept on through
            # the stretch at its awarded configuration's markup, one left out at its lowest.  The
            # markup here is the cheap-stretch offer less the fuel-cost line (mg less mk)
            mka, mkn = [], []
            for rs in trains.values():
                mk = [(r["mc"][k] - (r["mg"][k] - r["mk"][k]), r["aw"][k]) for r in rs
                      if r["mk"][k] is not None and r["mc"][k] is not None and r["aw"][k] is not None]
                if not mk:
                    continue
                won = [m for m, a in mk if a == 1]
                (mka if won else mkn).append(min(won) if won else min(m for m, _ in mk))
            out["mk_aw"][k] = _r(float(np.median(mka))) if mka else None
            out["mk_no"][k] = _r(float(np.median(mkn))) if mkn else None
            pool_a += mka
            pool_n += mkn
        tot = below = 0.0
        for r in units.values():
            if r["tech"] in ("combined_cycle", "gas_steam") and r["mk"][k] is not None and r["ls"][k]:
                tot += r["ls"][k]
                below += r["ls"][k] if r["mk"][k] < 0 else 0
        out["below_mw_share"][k] = _r(below / tot, 3) if tot else None
        gaps = [r["fl"][k] - r["rt"][k] for r in units.values() if r["tech"] in RENEW and r["fl"][k] is not None and r["rt"][k] is not None]
        out["renew_gap"][k] = _r(float(np.median(gaps))) if gaps else None
    # award rate by cheap-stretch margin, every combined cycle configuration-day with a cheap stretch
    edges = [-1e9] + BINS + [1e9]
    nb, ab = [0] * (len(edges) - 1), [0] * (len(edges) - 1)
    for r in cc.values():
        for m, a in zip(r["ma"], r["aw"]):
            if m is None or a is None:
                continue
            b = bisect.bisect_right(edges, m) - 1
            nb[b] += 1
            ab[b] += a
    bins = {"edges": BINS, "n": nb, "aw": ab}
    return out, bins, _mk_hist(pool_a, pool_n)


def _mk_hist(aw, no):
    """Offer less fuel cost over every cheap train-day, pooled: counts per MK_STEP bin from MK_LO
    to MK_HI (the end bins take everything beyond), with each group's median."""
    edges = list(range(MK_LO, MK_HI + 1, MK_STEP))
    def count(xs):
        c = [0] * (len(edges) - 1)
        for x in xs:
            c[min(max(bisect.bisect_right(edges, x) - 1, 0), len(c) - 1)] += 1
        return c
    return {"edges": edges, "aw": count(aw), "no": count(no),
            "med_aw": _r(float(np.median(aw))) if aw else None, "med_no": _r(float(np.median(no))) if no else None}


def train_table(dates, units, cheapdays, events):
    """Per train (combined cycle) or plant: [plant, tech, cheap days filed, share awarded through
    the stretch, median lowest cheap-stretch offer, median implied heat rate, price-outs, steps,
    the unit its Unit page is under (the train, or a gas steam plant's first unit), share of cheap
    days offered below the fuel-cost line (as fleet: the awarded configuration, else the lowest),
    gas hub]."""
    by, names = collections.defaultdict(list), collections.defaultdict(list)
    for u, r in units.items():
        if r["tech"] in ("combined_cycle", "gas_steam"):
            by[r["plant"]].append(r)
            names[r["plant"]].append(u)
    cnt = collections.Counter((e["plant"], e["kind"]) for e in events)
    rows = []
    for p, rs in sorted(by.items()):
        days_f = aw = 0
        low, ih, below = [], [], []
        for k in range(len(dates)):
            offers = [(r["mc"][k], r["ih"][k]) for r in rs if r["mc"][k] is not None]
            if not cheapdays[k] or not offers:
                continue
            days_f += 1
            aw += any(r["aw"][k] == 1 for r in rs)
            lo = min(offers, key=lambda x: x[0])
            low.append(lo[0])
            if lo[1] is not None:
                ih.append(lo[1])
            mk = [(r["mc"][k] - (r["mg"][k] - r["mk"][k]), r["aw"][k]) for r in rs
                  if r["mk"][k] is not None and r["mc"][k] is not None and r["aw"][k] is not None]
            if mk:
                won = [m for m, a in mk if a == 1]
                below.append((min(won) if won else min(m for m, _ in mk)) < 0)
        if not days_f:
            continue
        rows.append([p, rs[0]["tech"], days_f, _r(aw / days_f, 3), _r(float(np.median(low))),
                     _r(float(np.median(ih))) if ih else None, cnt[(p, "priced_out")], cnt[(p, "mingen_step")],
                     p if rs[0]["tech"] == "combined_cycle" else min(names[p]),
                     _r(sum(below) / len(below), 3) if below else None, rs[0].get("hub")])
    return rows


def renew_table(units):
    """Per wind or solar unit with a DA curve: [unit, tech, days filed, median DA floor, median RT
    floor, median DA less RT floor, median DA award share]."""
    rows = []
    med = lambda xs: _r(float(np.median(xs)), 3) if xs else None
    for n, r in sorted(units.items()):
        if r["tech"] not in RENEW:
            continue
        fl = [v for v in r["fl"] if v is not None]
        if not fl:
            continue
        gap = [a - b for a, b in zip(r["fl"], r["rt"]) if a is not None and b is not None]
        rows.append([n, r["tech"], len(fl), med(fl), med([v for v in r["rt"] if v is not None]), med(gap),
                     med([v for v in r["as"] if v is not None])])
    return rows


def write_signatures(dates, units):
    by_year = collections.defaultdict(list)
    for k, d in enumerate(dates):
        by_year[d[:4]].append(k)
    for y, ks in sorted(by_year.items()):
        out = {}
        for n, r in units.items():
            kind = "thermal" if r["tech"] in THERMAL else "renew"
            vals = {f: [r[f][k] for k in ks] for f in FIELDS[kind]}
            if not any(v is not None for f in FIELDS[kind] for v in vals[f]):
                continue
            out[n] = {"tech": r["tech"], "plant": r["plant"], **({"hub": r["hub"]} if "hub" in r else {}), **vals}
        write_json_gz(SIG_DIR / f"sig-{y}.json.gz", {"year": int(y), "dates": [dates[k] for k in ks], "fields": FIELDS, "units": out})


def build_dam_offers(index: dict) -> dict:
    dates = sorted(index.get("days", {}).get("dam", []))
    if not dates:
        warn("dam_offers: no DAM days loaded")
        return {}
    units, cheapdays, status = build_signatures(dates)
    rows = detect(dates, units, cheapdays, status)
    events = merge(rows)
    steps = collections.Counter((e["plant"], e["date"][:4]) for e in events if e["kind"] == "mingen_step")
    repricers = sorted({p for (p, _), c in steps.items() if c >= REPRICE})
    for e in events:
        e["repricer"] = e["plant"] in repricers
    fl, bins, mk_hist = fleet(dates, units, cheapdays)
    write_signatures(dates, units)
    out = {"updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "ref": {"hr": REF_HR, **REF_SOURCE}, "cheap_usd": CHEAP_USD,
           "params": {"step_usd": STEP_USD, "step_tol": STEP_TOL, "po_usd": PO_USD, "ep_max": EP_MAX, "start_pct": START_PCT,
                      "prior": PRIOR, "hold": HOLD, "min_held": MIN_HELD, "file_share": FILE_SHARE, "renew_off": RENEW_OFF,
                      "reprice": REPRICE, "zero_usd": ZERO_USD, "high_usd": HIGH_USD},
           "kinds": KINDS, "first": dates[0], "last": dates[-1], "dates": dates, "cheap": [int(c) for c in cheapdays],
           "fleet": fl, "bins": bins, "mk_hist": mk_hist,
           "train_cols": ["plant", "tech", "cheap_days_filed", "share_awarded", "median_lowest_offer", "median_implied_hr", "priced_out", "steps", "unit", "share_below_fuel", "hub"],
           "trains": train_table(dates, units, cheapdays, events),
           "renew_cols": ["unit", "tech", "days_filed", "median_da_floor", "median_rt_floor", "median_gap", "median_award_share"],
           "renew": renew_table(units), "repricers": repricers, "events": events}
    write_json_gz(PATH, out)
    c = collections.Counter(e["kind"] for e in events)
    print(f"dam_offers: {len(units)} units, {len(events)} event(s) ({sum(e['major'] for e in events)} major), "
          f"{len(repricers)} re-pricer(s); " + ", ".join(f"{k} {v}" for k, v in sorted(c.items())))
    return out
