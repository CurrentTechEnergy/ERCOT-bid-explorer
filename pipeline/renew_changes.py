"""Wind and solar bidding changes: every day, every unit, when its offer changes and whether
that change moved its dispatch.  Needs no downloads.  Read by Renewables (hedge signals) and the Unit page.

Each wind or solar unit-day gets a signature, from its hourly real-time offers (the median over
the hour's SCED runs of the submitted curve's price at half its MW, as in ppa.hourly_offers),
counting hours with HSL >= MIN_HSL and an offer:

  h     hours online with an offer; days with fewer than MIN_HOURS take no part in detection
  k     the day's kind: "x" a formula day (offers follow a x DA price + b at one settlement point,
        fitted per calendar year with ppa.infer_unit and kept when that day's own fit has a
        slope in ppa.SLOPE and an RMS error within ppa.HIT_USD, or when the year's formula held at
        a cap or floor explains the day: _clamped_days), "v" moving (4 or more prices
        to the nearest $0.50 but no formula), "f" a floor (one price most of the day)
  fl    the day's most common offer, md its median
  x     on formula days: [settlement point, a, b]
  dam   DAM energy award / real-time available (HSL) energy, over the online hours
  cur   curtailed share: HSL minus base point / HSL energy

A unit's regime is its floor price (within TOL), formula (same settlement point) or moving.  On
the unit's online days, in date order, a change is:

  floor_new / floor_back  the floor moves by TOL or more and at least MIN_HELD of the next HOLD
                          online days stay within TOL of the new floor; "back" when the unit
                          held that floor within NEW_DAYS before
  formula_on / formula_off, moving_on / moving_off   the same test for a switch of kind
  terms                   inside a formula regime, the slope moves by TERMS_A or the offer the
                          formula gives at a REF_DA price by TERMS_B, held the same way over
                          formula days
  episode                 1 to EP_MAX days away from a floor regime, with a median offer at least
                          EP_USD from it, then back to that floor

Units of one plant (name up to its unit number) changing the same way within a day of each other
are one event.  A unit with TOGGLE or more floor_back events or episodes in some 365 days is a
"toggler" (Frye moves between two fixed floors all year); its events are still listed.

PTC.  A floor between PTC_BAND prices a per-MWh credit.  A floor change inside the band of
PTC_STEP or less is tagged "level" (re-pricing the credit, as the yearly inflation adjustment
does); a floor leaving the band for PTC_OFF or above and never returning to it is tagged
"expired" (inferred: the credit runs 10 years from the plant's start, which the data does
not give).  ptc_trend is the monthly median of those floors by technology.

Moved dispatch.  A change's window is every online day the unit spent in the new regime, from the
change up to its next change (episodes left out), at most WINDOW_MAX calendar days; an episode's
window is its own days.  A window still running at the last data day is "open" and fills in as
data arrives; one that ran the full WINDOW_MAX is "capped".  Each online hour of the window is
compared with what the old regime would have offered: the old floor, or the old formula at that
hour's DA price.  The unit dispatched differently when the node price fell
between the two offers.  Priced up (new offer above the old): energy given up = HSL - base point.
Priced down: energy gained = base point.  Each is valued at the node price.  The price is the
hourly real-time node price where there is one (live: UNIT_DATA_DIR/nodes/; history: the
release's rt-prices-YYYY-MM.parquet files), else the DA node price, and "est" says what share of
those hours used the DA price.  A change moved dispatch when its window has at least MOVED_MWH_DAY
MWh per window day.  Hourly prices smooth over SCED's 5-minute prices, so the MWh are an
approximation.

Sources.  The live build (build_renew_changes, run by the update) reads the 60-day per-unit data
through the ppa cache, the DAM day files and the node prices.  The history build
(python -m pipeline.renew_changes --history DIR) reads the hourly Parquet files of the `history`
release (pipeline/history.py), 2019 on: units-* with DA node prices, and rt-prices-* with real-time
ones where the release has them.  Days the live data covers always come from it.

Writes:
  data/renew/sig-YYYY.json.gz   {year, dates, src (per date "l" live or "h" history), points,
                                 units: {name: {tech, sp, h, k (string, "." no data), fl, md,
                                 dam, cur, x: {date index: [point index, a, b]}}}}
  data/renew/impacts.json.gz    {"unit|date|kind": {chunk: [hours, up, dn, v_up, v_dn, n_price,
                                 n_da]}}, kept between runs: sums over the window days of one
                                 chunk of data ("l" the live days, "YYYY" a history year), so each
                                 build replaces only the chunks it has hourly data for and a
                                 window may cross years and the history/live boundary
  data/renew_changes.json.gz    params, kinds, first, last, years, n_units, togglers,
                                 ptc_band, ptc_trend {months, wind/solar: {median, units}},
                                 events: [{date, plant, units, tech, kind, before, after, days, ptc,
                                 gap, ctx [dam before, dam after, cur before, cur after],
                                 impact {hours, up, dn, v_up, v_dn, est, days, open, capped} or null}],
                                 newest first
  monthly counts are left to the page.
"""
import argparse
import datetime as dt
import glob
import re
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .dam_prices import load as load_dam_prices
from .ppa import HIT_USD, MIN_HSL, SLOPE, _arr, day_offers, fill_cache, infer_unit
from .parse_prices import node_hourly
from .store import read_json_gz, write_json_gz

OUT_DIR = DATA_DIR / "renew"
MIN_HOURS = 4      # online hours with an offer for a day to count
TOL = 1.0          # $/MWh: floors closer than this are the same floor
HOLD = 7           # online days a new regime is tested over
MIN_HELD = 6       # of which at least this many must be in it
EP_USD = 5.0       # an episode's median offer is at least this far from the floor
EP_MAX = 6         # longest episode, online days
NEW_DAYS = 90      # a floor held within this many days before is "back", not "new"
TERMS_A, TERMS_B = 0.1, 1.0   # formula terms: slope, and offer at REF_DA ($/MWh)
REF_DA = 30.0      # a typical DA price: day fits trade slope against intercept, so the
                   # intercept is compared through the offer the formula gives at this price
TOGGLE = 4         # floor_back events or episodes in 365 days that make a toggler
MOVED_MWH_DAY = 1.0   # an event moved dispatch when its window has at least this many MWh per window day
WINDOW_MAX = 365   # calendar days a change's moved-dispatch window may run
CLAMP_SHARE = 0.8  # share of a day's hours the clamped year formula must explain
PTC_BAND = [-60.0, -15.0]   # floors here price a per-MWh credit such as the PTC
PTC_STEP = 5.0     # a floor change inside the band of this much or less is "PTC level"
PTC_OFF = -5.0     # a floor leaving the band for this or higher, for good, may be the PTC running out
KINDS = {
    "floor_new": "New floor", "floor_back": "Back to an earlier floor",
    "formula_on": "Formula on", "formula_off": "Formula off", "terms": "Formula terms changed",
    "moving_on": "Started moving within the day", "moving_off": "Stopped moving within the day",
    "episode": "Episode",
}
_PLANT = re.compile(r"_?(UNIT|SOLAR|SLR|PV|WND|WIND|WTG|G|U|CC|BESS)?_?\d+[A-Z]?$")


def plant_of(name: str) -> str:
    p = _PLANT.sub("", name).rstrip("_")
    return p or name


def _r(x, nd=2):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# --------------------------------------------------------------- signatures --
def day_signature(off, spread, hsl, bp, award):
    """(h, k, fl, md, dam, cur) for one unit-day, without the formula test (k is "f" or "v"),
    or None when the unit had too few hours online with an offer."""
    on = np.isfinite(off) & (np.nan_to_num(hsl, nan=0.0) >= MIN_HSL)
    h = int(on.sum())
    if h < MIN_HOURS:
        return None
    o = off[on]
    vals, counts = np.unique(np.round(o, 1), return_counts=True)
    fl = float(vals[np.argmax(counts)])
    md = float(np.median(o))
    k = "v" if len(np.unique(np.round(o * 2))) >= 4 else "f"
    e = float(np.nansum(hsl[on]))
    aw = np.nan_to_num(award, nan=0.0)
    dam = float(np.sum(aw[on])) / e if e > 0 else None
    b = np.nan_to_num(bp, nan=np.nan)
    c = hsl[on] - b[on]
    cur = float(np.nansum(np.clip(c, 0, None))) / e if e > 0 and np.isfinite(b[on]).any() else None
    return h, k, fl, md, (None if dam is None else min(dam, 1.5)), cur


class Store:
    """Hourly rows of one build: per unit {date: (off, spread, hsl, bp, award, price, rt, da)}
    and per date {point: DA [24]}; da is the DA node price, rt marks a real-time price."""
    def __init__(self):
        self.rows = defaultdict(dict)
        self.hubs = {}
        self.tech, self.sp = {}, {}


def signatures(store: Store, points: list) -> dict:
    """{year: {name: {date: sig}}} with sig (h, k, fl, md, dam, cur, x) from the store; the
    formula is fitted per unit and calendar year on that year's days in the store."""
    out = defaultdict(lambda: defaultdict(dict))
    for name, days in store.rows.items():
        by_year = defaultdict(list)
        for d in sorted(days):
            by_year[d[:4]].append(d)
        for year, ds in by_year.items():
            base = {}
            rows = []
            for di, d in enumerate(ds):
                off, spread, hsl, bp, award, _, _, da_node = days[d]
                s = day_signature(off, spread, hsl, bp, award)
                if s is None:
                    continue
                base[d] = s
                da = dict(store.hubs.get(d) or {})
                da["node"] = da_node
                rows.append((di, off, spread, hsl, da))
            if not base:
                continue
            floor = Counter(round(s[2], 2) for s in base.values()).most_common(1)[0][0]
            xs = {}
            res = infer_unit(rows, points, floor) if len(rows) >= 2 else None
            if res:
                p = res["best"][1]
                for di, a, b, rmse, n in res["daily"]:
                    if SLOPE[0] <= a <= SLOPE[1] and rmse <= HIT_USD and n >= 4:
                        xs[ds[di]] = (p, a, b)
                if xs and SLOPE[0] <= res["best"][2] <= SLOPE[1]:
                    xs.update(_clamped_days(days, store.hubs, base, xs, p, res["best"][2], res["best"][3]))
            for d, (h, k, fl, md, dam, cur) in base.items():
                x = xs.get(d)
                out[year][name][d] = (h, "x" if x else k, fl, md, dam, cur, x)
    return out


def _clamped_days(days, hubs, base, xs, p, a, b) -> dict:
    """Days the year's formula (p, a, b) explains once it is clamped to the day's floor: a
    formula held at a cap or floor (PORT never offers above $0) leaves days that sit at that
    price, or follow the formula only in a few hours.  The clamp side is learned from the formula
    days: their hours at the day's floor must all have the formula beyond it on one side.  A day
    counts when CLAMP_SHARE of its online hours either follow the formula within HIT_USD or sit
    at its floor with the formula on that side."""
    def hours(d):
        off, _, hsl, _, _, _, _, da_node = days[d]
        x = da_node if p == "node" else (hubs.get(d) or {}).get(p)
        if x is None:
            return None
        on = np.isfinite(off) & (np.nan_to_num(hsl, nan=0.0) >= MIN_HSL) & np.isfinite(x)
        return off[on], a * x[on] + b, base[d][2]
    side = []
    for d in xs:
        r = hours(d) if d in base else None
        if r is None:
            continue
        off, pred, fl = r
        at = np.abs(off - fl) < 0.05
        side += list(np.sign(pred[at] - fl)[np.abs(pred[at] - fl) >= HIT_USD])
    if len(side) < 4 or abs(np.mean(side)) < 0.8:
        return {}
    sd = float(np.sign(np.mean(side)))
    out = {}
    for d in base:
        if d in xs:
            continue
        r = hours(d)
        if r is None or len(r[0]) < MIN_HOURS:
            continue
        off, pred, fl = r
        ok = (np.abs(off - pred) < HIT_USD) | ((np.abs(off - fl) < 0.05) & (np.sign(pred - fl) * sd > 0))
        if ok.mean() >= CLAMP_SHARE:
            out[d] = (p, a, b)
    return out


def _sig_path(year):
    return OUT_DIR / f"sig-{year}.json.gz"


def load_sig(year) -> dict:
    """{name: {date: sig}}, src {date: "l"|"h"}, tech {name}, sp {name} from one year file."""
    f = read_json_gz(_sig_path(year))
    if not f:
        return {}, {}, {}, {}
    dates, pts = f["dates"], f["points"]
    sig, tech, sp = {}, {}, {}
    for name, u in f["units"].items():
        tech[name], sp[name] = u["tech"], u.get("sp")
        x = {int(i): v for i, v in (u.get("x") or {}).items()}
        rec = {}
        for i, d in enumerate(dates):
            k = u["k"][i]
            if k == ".":
                continue
            xv = x.get(i)
            rec[d] = (u["h"][i], k, u["fl"][i], u["md"][i], u["dam"][i], u["cur"][i],
                      (pts[xv[0]], xv[1], xv[2]) if xv else None)
        sig[name] = rec
    return sig, dict(zip(dates, f["src"])), tech, sp


def save_sig(year, sig: dict, src: dict, tech: dict, sp: dict) -> None:
    dates = sorted(src)
    di = {d: i for i, d in enumerate(dates)}
    pts = sorted({s[6][0] for rec in sig.values() for s in rec.values() if s[6]})
    pi = {p: i for i, p in enumerate(pts)}
    n = len(dates)
    units = {}
    for name in sorted(sig):
        rec = sig[name]
        if not rec:
            continue
        h, fl, md, dam, cur, k, x = [None] * n, [None] * n, [None] * n, [None] * n, [None] * n, ["."] * n, {}
        for d, s in rec.items():
            i = di[d]
            h[i], k[i], fl[i], md[i], dam[i], cur[i] = s[0], s[1], _r(s[2]), _r(s[3]), _r(s[4], 3), _r(s[5], 3)
            if s[6]:
                x[str(i)] = [pi[s[6][0]], _r(s[6][1], 3), _r(s[6][2])]
        units[name] = {"tech": tech.get(name), "sp": sp.get(name), "h": h, "k": "".join(k), "fl": fl, "md": md,
                       "dam": dam, "cur": cur, "x": x}
    write_json_gz(_sig_path(year), {"year": int(year), "dates": dates, "src": [src[d] for d in dates],
                                    "points": pts, "units": units})


def merge_signatures(new: dict, src_tag: str, store: Store) -> None:
    """Write the store's signatures into the year files.  Live days replace whatever was there;
    history days never replace live ones."""
    days_by_year = defaultdict(set)
    for days in store.rows.values():
        for d in days:
            days_by_year[d[:4]].add(d)
    for year in sorted(set(days_by_year) | set(new)):
        sig, src, tech, sp = load_sig(year)
        mine = {d for d in days_by_year[year] if src_tag == "l" or src.get(d) != "l"}
        for rec in sig.values():
            for d in list(rec):
                if d in mine:
                    del rec[d]
        for name, rec in new.get(year, {}).items():
            tgt = sig.setdefault(name, {})
            for d, s in rec.items():
                if d in mine:
                    tgt[d] = s
            tech[name] = store.tech.get(name) or tech.get(name)
            sp[name] = store.sp.get(name) or sp.get(name)
        for d in mine:
            src[d] = src_tag
        save_sig(year, sig, src, tech, sp)


def all_signatures():
    """Every year file merged: {name: [(date, sig), ...]} in date order, plus tech, sp, src."""
    seq, tech, sp, src = defaultdict(list), {}, {}, {}
    for p in sorted(OUT_DIR.glob("sig-*.json.gz")):
        sig, s, t, spp = load_sig(p.name[4:8])
        src.update(s)
        tech.update(t)
        sp.update({k: v for k, v in spp.items() if v})
        for name, rec in sig.items():
            seq[name] += sorted(rec.items())
    return seq, tech, sp, src


# ---------------------------------------------------------------- detection --
def _at_ref(a, b):
    return a * REF_DA + b


def _same(s, R):
    """Is day signature s in regime R?  R = ("f", floor) | ("x", point, a, b) | ("v",)."""
    if R[0] == "f":
        return s[1] == "f" and abs(s[2] - R[1]) < TOL
    if R[0] == "x":
        return s[1] == "x" and s[6][0] == R[1]
    return s[1] == "v"


def _regime_from(window):
    """The regime the first day of window starts, if at least MIN_HELD days of window share it."""
    s0 = window[0][1]
    if s0[1] == "f":
        near = [s[2] for _, s in window if s[1] == "f" and abs(s[2] - s0[2]) < TOL]
        R = ("f", float(np.median(near)))
    elif s0[1] == "x":
        xs = [s[6] for _, s in window if s[1] == "x" and s[6][0] == s0[6][0]]
        R = ("x", s0[6][0], float(np.median([v[1] for v in xs])), float(np.median([v[2] for v in xs])))
    else:
        R = ("v",)
    held = sum(_same(s, R) for _, s in window)
    return R if held >= MIN_HELD and _same(s0, R) else None


def _desc(R):
    if R[0] == "f":
        return {"k": "f", "v": _r(R[1])}
    if R[0] == "x":
        return {"k": "x", "pt": R[1], "a": _r(R[2], 3), "b": _r(R[3])}
    return {"k": "v"}


def _ctx(days, i, j):
    """Median DAM share and curtailed share over HOLD online days before i and from j on."""
    def med(rng, f):
        v = [days[t][1][f] for t in rng if 0 <= t < len(days) and days[t][1][f] is not None]
        return _r(float(np.median(v)), 3) if v else None
    b, a = range(i - HOLD, i), range(j, j + HOLD)
    return [med(b, 4), med(a, 4), med(b, 5), med(a, 5)]


def detect_unit(days, last=None):
    """days: [(date, sig)] for one unit (any h); last: the last data day of the build.  Returns
    unit-level events: (date, kind, before R, after R or peak, window dates, extra)."""
    days = [(d, s) for d, s in days if s[0] >= MIN_HOURS]
    n = len(days)
    ev = []
    if n < HOLD:
        return ev
    R, i, start = None, 0, 0
    history = []      # (regime, first date, last date)
    while i < n and R is None:
        R = _regime_from(days[i:i + HOLD])
        if R is None:
            i += 1
    if R is None:
        return ev
    start = i
    i += 1
    last_in = days[start][0]
    while i < n:
        d, s = days[i]
        if _same(s, R):
            if R[0] == "x" and s[6]:
                # terms change inside a formula regime
                xs = [v for _, v in days[i:i + HOLD * 3] if v[1] == "x" and v[6][0] == R[1]][:HOLD]
                if len(xs) >= HOLD:
                    a = float(np.median([v[6][1] for v in xs]))
                    b = float(np.median([v[6][2] for v in xs]))
                    def near(v):
                        return abs(v[6][1] - a) < TERMS_A and abs(_at_ref(v[6][1], v[6][2]) - _at_ref(a, b)) < TERMS_B
                    ok = sum(near(v) for v in xs)
                    if (abs(a - R[2]) >= TERMS_A or abs(_at_ref(a, b) - _at_ref(R[2], R[3])) >= TERMS_B) \
                            and ok >= MIN_HELD and near(s):
                        newR = ("x", R[1], a, b)
                        win = [dd for dd, v in days[i:i + HOLD * 3] if v[1] == "x"][:HOLD]
                        ev.append((d, "terms", R, newR, win, {"ctx": _ctx(days, i, i)}))
                        R = newR
            last_in = d
            i += 1
            continue
        C = _regime_from(days[i:i + HOLD])
        if C is not None and not (C[0] == R[0] == "f" and abs(C[1] - R[1]) < TOL):
            if C[0] == "f" and R[0] == "f":
                d0 = dt.date.fromisoformat(d) - dt.timedelta(days=NEW_DAYS)
                seen = any(r[0] == "f" and abs(r[1] - C[1]) < TOL and e >= d0.isoformat() for r, _, e in history)
                kind = "floor_back" if seen else "floor_new"
            elif C[0] == "x" and R[0] != "x":
                kind = "formula_on"
            elif R[0] == "x" and C[0] != "x":
                kind = "formula_off"
            elif C[0] == "x":      # formula at another settlement point
                kind = "terms"
            elif C[0] == "v":
                kind = "moving_on"
            elif R[0] == "v":
                kind = "moving_off"
            else:
                kind = "floor_new"
            gap = (dt.date.fromisoformat(d) - dt.date.fromisoformat(last_in)).days
            ev.append((d, kind, R, C, [dd for dd, _ in days[i:i + HOLD]],
                       {"ctx": _ctx(days, i, i), "gap": gap if gap > 14 else None}))
            history.append((R, days[start][0], last_in))
            R, start, last_in = C, i, d
            i += 1
            continue
        # a short departure from a floor that comes back: an episode
        if R[0] == "f":
            j = i
            while j < n and j - i < EP_MAX + 1 and not _same(days[j][1], R):
                j += 1
            if j < n and j - i <= EP_MAX and _same(days[j][1], R):
                run = days[i:j]
                dev = [v[3] - R[1] for _, v in run]
                k = int(np.argmax(np.abs(dev)))
                if abs(dev[k]) >= EP_USD:
                    ev.append((d, "episode", R, ("peak", run[k][1][3], any(v[1] == "x" for _, v in run)),
                               [dd for dd, _ in run], {"ctx": _ctx(days, i, j)}))
                i = j
                continue
        i += 1
    return _windows(days, ev, last)


def _windows(days, ev, last):
    """The moved-dispatch window of each change (see the module doc), with extra["open"] and
    extra["capped"]; episodes keep their own days."""
    if not ev:
        return ev
    last = last or days[-1][0]
    unit_last = days[-1][0]
    gone = (dt.date.fromisoformat(last) - dt.date.fromisoformat(unit_last)).days > 14   # no longer in the data
    changes = [k for k, e in enumerate(ev) if e[1] != "episode"]
    ep_days = {dd for e in ev if e[1] == "episode" for dd in e[4]}
    out = list(ev)
    for n, k in enumerate(changes):
        d, kind, R, C, _, extra = ev[k]
        cap = (dt.date.fromisoformat(d) + dt.timedelta(days=WINDOW_MAX)).isoformat()
        nxt = ev[changes[n + 1]][0] if n + 1 < len(changes) else None
        end = min(cap, nxt) if nxt else cap
        win = [dd for dd, s in days if d <= dd < end and dd not in ep_days and _same(s, C)]
        is_open = nxt is None and cap > last and not gone
        capped = end == cap and cap <= last and not (nxt is None and gone and unit_last < cap)
        out[k] = (d, kind, R, C, win, dict(extra, open=is_open, capped=capped))
    return out


# ----------------------------------------------------------------- impacts --
def impact(store: Store, name: str, R, window):
    """Moved dispatch over the window's days the store has, against the old regime R (see the
    module doc): [hours, up, dn, v_up, v_dn, n_price, n_da], or None without priced hours."""
    if R[0] == "v":
        return None
    days = store.rows.get(name) or {}
    hours = 0
    up = dn = vu = vd = 0.0
    n_price = n_da = 0
    for d in window:
        r = days.get(d)
        if r is None:
            continue
        off, _, hsl, bp, _, price, rt, da_node = r
        if R[0] == "f":
            old = np.full(24, R[1])
        else:
            x = da_node if R[1] == "node" else (store.hubs.get(d) or {}).get(R[1])
            if x is None:
                continue
            old = R[2] * x + R[3]
        ok = np.isfinite(off) & np.isfinite(old) & np.isfinite(price) & (np.nan_to_num(hsl, nan=0) >= MIN_HSL)
        for h in np.flatnonzero(ok):
            o, c, p = off[h], old[h], price[h]
            b = bp[h] if np.isfinite(bp[h]) else 0.0
            n_price += 1
            n_da += 0 if rt[h] else 1
            if c < p < o:                        # priced up: the old offer would have run
                e = max(hsl[h] - b, 0.0)
                if e > 0.1:
                    up += e
                    vu += e * p
                    hours += 1
            elif o < p < c:                      # priced down: the old offer would not have
                e = max(b, 0.0)
                if e > 0.1:
                    dn += e
                    vd += e * p
                    hours += 1
    if not n_price:
        return None
    return [hours, _r(up, 1), _r(dn, 1), _r(vu, 0), _r(vd, 0), n_price, n_da]


def _combine(chunks: dict, win, extra, kind) -> dict:
    """One event's impact from its stored chunks, or None when no chunk has priced hours."""
    got = [v for v in (chunks or {}).values() if v]
    if not got:
        return None
    t = [sum(_num(v[i]) for v in got) for i in range(7)]
    return {"hours": int(t[0]), "up": _r(t[1], 0), "dn": _r(t[2], 0), "v_up": _r(t[3], 0), "v_dn": _r(t[4], 0),
            "est": _r(t[6] / t[5], 2) if t[5] else None, "days": len(win),
            "open": kind != "episode" and bool(extra.get("open")), "capped": kind != "episode" and bool(extra.get("capped"))}


def _key(name, e):
    return f"{name}|{e[0]}|{e[1]}"


def load_impacts(detected: dict) -> dict:
    """The stored impact chunks of the detected events (an older file's one-dict-per-event
    entries are dropped, to be rebuilt)."""
    keys = {_key(n, e) for n, evs in detected.items() for e in evs}
    old = read_json_gz(OUT_DIR / "impacts.json.gz", default={}) or {}
    return {k: v for k, v in old.items() if k in keys and isinstance(v, dict) and "hours" not in v}


def fill_impacts(imp: dict, store: Store, detected: dict, chunk: str) -> int:
    """Replace chunk in every detected event's impact with the sums over the window days the
    store has (dropping it when the window has none of them).  Returns events filled."""
    n = 0
    for name, evs in detected.items():
        rows = store.rows.get(name) or {}
        for e in evs:
            k = _key(name, e)
            c = imp.setdefault(k, {})
            c.pop(chunk, None)
            if rows and any(d in rows for d in e[4]):
                v = impact(store, name, e[2], e[4])
                if v is not None:
                    c[chunk] = v
                    n += 1
            if not c:
                del imp[k]
    return n


def update_impacts(store: Store, detected: dict) -> None:
    """The live build's chunk of every detected event's impact; other chunks are kept."""
    imp = load_impacts(detected)
    n = fill_impacts(imp, store, detected, "l")
    write_json_gz(OUT_DIR / "impacts.json.gz", imp)
    print(f"renew_changes: moved-dispatch estimates over live days for {n} event(s), {len(imp)} kept")


# ------------------------------------------------------------------- output --
def _num(v):
    return 0.0 if v is None else v


def _in_band(r) -> bool:
    return r.get("k") == "f" and r.get("v") is not None and PTC_BAND[0] <= r["v"] <= PTC_BAND[1]


def _tag_ptc(events) -> None:
    """e["ptc"]: "level" for a floor change inside the PTC band of PTC_STEP or less (re-pricing
    the credit), "expired" for a floor leaving the band for PTC_OFF or above that never returns
    to the band in the data (the credit running out after 10 years, inferred)."""
    by_unit = defaultdict(list)
    for e in events:
        for u in e["units"]:
            by_unit[u].append(e)
    for e in events:
        e["ptc"] = None
        if e["kind"] not in ("floor_new", "floor_back"):
            continue
        b, a = e["before"], e["after"]
        if _in_band(b) and _in_band(a) and abs(a["v"] - b["v"]) <= PTC_STEP:
            e["ptc"] = "level"
        elif _in_band(b) and a.get("k") == "f" and a["v"] >= PTC_OFF:
            back = any(o["date"] > e["date"] and _in_band(o["after"]) and o["kind"] != "episode"
                       for u in e["units"] for o in by_unit[u])
            if not back:
                e["ptc"] = "expired"


def ptc_trend(seq, tech) -> dict:
    """Monthly median, over units, of each unit's median floor on floor days inside the PTC
    band, by technology, with the number of units behind each value."""
    per = defaultdict(list)             # (tech, month, unit) -> floors
    for name, days in seq.items():
        t = tech.get(name)
        for d, s in days:
            if s[0] >= MIN_HOURS and s[1] == "f" and PTC_BAND[0] <= s[2] <= PTC_BAND[1]:
                per[(t, d[:7], name)].append(s[2])
    months = sorted({k[1] for k in per})
    out = {"months": months}
    for t in ("wind", "solar"):
        med, n = [], []
        for m in months:
            v = [float(np.median(f)) for (tt, mm, _), f in per.items() if tt == t and mm == m]
            med.append(_r(float(np.median(v))) if len(v) >= 3 else None)
            n.append(len(v))
        out[t] = {"median": med, "units": n}
    return out


def _close(a, b) -> bool:
    """Two regime descriptions alike enough for units of one plant to share an event."""
    if a["k"] == "f":
        return abs(a["v"] - b["v"]) < TOL
    if a["k"] == "x":
        return a["pt"] == b["pt"]
    return True


def write_events(detected, seq, tech, src) -> None:
    imp = read_json_gz(OUT_DIR / "impacts.json.gz", default={}) or {}
    rows = []
    for name, evs in detected.items():
        for e in evs:
            d, kind, R, C, win, extra = e
            if C[0] == "peak":
                after = {"k": "peak", "v": _r(C[1]), "formula": C[2]}
            else:
                after = _desc(C)
            rows.append({"date": d, "unit": name, "plant": plant_of(name), "tech": tech.get(name), "kind": kind,
                         "before": _desc(R), "after": after, "days": len(win) if kind == "episode" else None,
                         "gap": extra.get("gap"), "ctx": extra.get("ctx"),
                         "impact": _combine(imp.get(_key(name, e)), win, extra, kind)})
    # togglers: units with TOGGLE or more floor_back events or episodes in some 365 days
    toggle = {}
    by_unit = defaultdict(list)
    for r in rows:
        if r["kind"] in ("floor_back", "episode"):
            by_unit[r["unit"]].append(dt.date.fromisoformat(r["date"]))
    for name, ds in by_unit.items():
        ds.sort()
        best = max(sum(1 for y in ds if x <= y < x + dt.timedelta(days=365)) for x in ds)
        if best >= TOGGLE:
            toggle[name] = best
    # one event per plant: same kind, within a day, same before and after (within TOL)
    def sig(r):
        b, a = r["before"], r["after"]
        return (r["plant"], r["kind"], b["k"], a["k"])
    rows.sort(key=lambda r: (sig(r), r["date"], r["unit"]))
    events = []
    for r in rows:
        last = events[-1] if events else None
        if last and sig(last) == sig(r) \
                and (dt.date.fromisoformat(r["date"]) - dt.date.fromisoformat(last["date"])).days <= 1 \
                and all(_close(last[s], r[s]) for s in (("before",) if r["kind"] == "episode" else ("before", "after"))):
            last["units"].append(r["unit"])
            if r["impact"]:
                li = last["impact"]
                if li is None:
                    last["impact"] = dict(r["impact"])
                else:
                    for k in ("hours", "up", "dn", "v_up", "v_dn"):
                        li[k] = _r(_num(li[k]) + _num(r["impact"][k]), 0)
                    li["est"] = max(_num(li["est"]), _num(r["impact"]["est"]))
                    li["days"] = max(li["days"], r["impact"]["days"])
                    li["open"] = li["open"] or r["impact"]["open"]
                    li["capped"] = li["capped"] or r["impact"]["capped"]
            continue
        r = dict(r)
        r["units"] = [r.pop("unit")]
        if r["impact"]:
            r["impact"] = dict(r["impact"])
        events.append(r)
    for e in events:
        im = e["impact"]
        e["moved"] = None if im is None else bool(_num(im["up"]) + _num(im["dn"]) >= MOVED_MWH_DAY * max(im["days"], 1))
        e["toggler"] = any(u in toggle for u in e["units"])
    _tag_ptc(events)
    events.sort(key=lambda e: (e["date"], e["plant"]), reverse=True)
    dates = sorted(src)
    n_units = Counter(tech.get(n) for n, days in seq.items() if any(s[0] >= MIN_HOURS for _, s in days))
    out = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "params": {"tol": TOL, "hold": HOLD, "min_held": MIN_HELD, "ep_usd": EP_USD, "ep_max": EP_MAX,
                   "new_days": NEW_DAYS, "terms_a": TERMS_A, "terms_b": TERMS_B, "ref_da": REF_DA, "toggle": TOGGLE,
                   "moved_mwh_day": MOVED_MWH_DAY, "window_max": WINDOW_MAX},
        "kinds": KINDS, "first": dates[0] if dates else None, "last": dates[-1] if dates else None,
        "live_first": min((d for d in dates if src[d] == "l"), default=None),
        "years": sorted({d[:4] for d in dates}), "n_units": dict(n_units), "togglers": toggle,
        "ptc_band": PTC_BAND, "ptc_trend": ptc_trend(seq, tech),
        "events": events,
    }
    write_json_gz(DATA_DIR / "renew_changes.json.gz", out)
    k = Counter(e["kind"] for e in events)
    print(f"renew_changes: {len(events)} plant event(s) from {sum(len(v) for v in detected.values())} unit "
          f"event(s), {sum(1 for e in events if e['moved'])} moved dispatch, {len(toggle)} toggler(s); "
          + ", ".join(f"{KINDS[x]} {k.get(x, 0)}" for x in KINDS))


def _finish(store: Store, tag: str, points: list) -> None:
    merge_signatures(signatures(store, points), tag, store)
    seq, tech, sp, src = all_signatures()
    last = max(src) if src else None
    detected = {name: detect_unit(days, last) for name, days in seq.items()}
    update_impacts(store, detected)
    write_events(detected, seq, tech, src)


# --------------------------------------------------------------- live build --
def build_renew_changes(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    if not dates:
        return
    dam_days = set(index["days"].get("dam", []))
    node_days = set(index["days"].get("nodes", []))
    hubs = load_dam_prices()
    points = ["node"] + (hubs.get("points") or [])
    fill_cache(dates)
    store = Store()
    for d in dates:
        offers = day_offers(d)
        if not offers:
            continue
        dam = ((read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz") if d in dam_days else None) or {}).get("units") or {}
        nodes = node_hourly(read_json_gz(UNIT_DATA_DIR / "nodes" / f"{d}.json.gz")) if d in node_days else {}
        store.hubs[d] = {p: _arr(v) for p, v in (hubs["days"].get(d) or {}).items()}
        for name, u in offers.items():
            du = dam.get(name) or {}
            if du.get("sp"):
                store.sp[name] = du["sp"]
            store.tech[name] = u["tech"]
            da_node = _arr(du.get("spp"))
            sp = store.sp.get(name)
            rt = _arr(nodes.get(sp)) if sp and nodes.get(sp) else np.full(24, np.nan)
            is_rt = np.isfinite(rt)
            price = np.where(is_rt, rt, da_node)
            store.rows[name][d] = (_arr(u["offer"]), _arr(u["spread"]), _arr(u["hsl"]), _arr(u["bp"]),
                                   _arr(du.get("award")), price, is_rt, da_node)
    _finish(store, "l", points)


# ------------------------------------------------------------ history build --
def _rt_node(files: list, sps: set, skip: set) -> dict:
    """{(date, settlement point): 24 hourly real-time prices} from the rt-prices files beside
    the units files, for the points in sps; {} where the release has none."""
    import pandas as pd
    rt_files = [f for f in (x.replace("units-", "rt-prices-") for x in files) if Path(f).exists()]
    if not rt_files:
        return {}
    r = pd.concat([pd.read_parquet(f, columns=["date", "he", "point", "price"]) for f in rt_files], ignore_index=True)
    r["point"] = r["point"].astype(str)
    r = r[r["point"].isin(sps) & ~r["date"].isin(skip) & r["he"].between(1, 24)]
    out = {}
    for (d, p), g in r.groupby(["date", "point"], sort=False):
        a = np.full(24, np.nan, np.float32)
        a[g["he"].to_numpy().astype(int) - 1] = g["price"].to_numpy(dtype=float)
        out[(d, p)] = a
    return out


def _year_store(files: list, skip: set, rt: bool = True) -> Store:
    """Hourly rows of one year of the history release, without the days in skip; with rt, the
    price is the real-time node price where the release has one (rt-prices-*), else DA."""
    import pandas as pd
    store = Store()
    u = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    u = u[~u["date"].isin(skip)]
    rtn = _rt_node(files, {str(x) for x in u["sp"].dropna().unique()}, skip) if rt else {}
    hub_files = [f for f in (x.replace("units-", "da-hubs-") for x in files) if Path(f).exists()]
    if hub_files:
        hf = pd.concat([pd.read_parquet(f) for f in hub_files], ignore_index=True)
        for (d, p), g in hf.groupby(["date", "point"]):
            a = np.full(24, np.nan, np.float32)
            he = g["he"].to_numpy().astype(int)
            ok = (he >= 1) & (he <= 24)
            a[he[ok] - 1] = g["price"].to_numpy(dtype=float)[ok]
            store.hubs.setdefault(d, {})[p] = a
    u = u.sort_values(["unit", "date", "he"])
    cols = ["offer", "spread", "hsl", "bp", "award", "da_node"]
    for (name, d), g in u.groupby(["unit", "date"], sort=False):
        he = g["he"].to_numpy().astype(int)
        ok = (he >= 1) & (he <= 24)
        arr = {}
        for c in cols:
            a = np.full(24, np.nan, np.float32)
            a[he[ok] - 1] = g[c].to_numpy(dtype=float)[ok]
            arr[c] = a
        sp = g["sp"].iloc[0]
        rtv = rtn.get((d, str(sp))) if isinstance(sp, str) and sp else None
        is_rt = np.isfinite(rtv) if rtv is not None else np.zeros(24, bool)
        price = np.where(is_rt, rtv, arr["da_node"]) if rtv is not None else arr["da_node"]
        store.rows[name][d] = (arr["offer"], arr["spread"], arr["hsl"], arr["bp"], arr["award"],
                               price, is_rt, arr["da_node"])
        store.tech[name] = g["tech"].iloc[0]
        if isinstance(sp, str) and sp:
            store.sp[name] = sp
    return store


def build_from_history(folder: str, years=None) -> None:
    """Signatures and moved-dispatch estimates from the history release's Parquet files, one
    calendar year at a time; days the live build covers are left alone.  Two passes over the
    files: signatures first (detection needs every year), then the hourly rows again for the
    moved-dispatch estimates of the events each year holds."""
    files = sorted(glob.glob(str(Path(folder) / "units-*.parquet")))
    by_year = defaultdict(list)
    for f in files:
        by_year[Path(f).name[6:10]].append(f)
    todo = [y for y in sorted(by_year) if not years or y in years]
    live = set()
    for p in OUT_DIR.glob("sig-*.json.gz"):
        live |= {d for d, s in load_sig(p.name[4:8])[1].items() if s == "l"}
    for year in todo:
        store = _year_store(by_year[year], live, rt=False)
        pts = sorted({p for v in store.hubs.values() for p in v})
        merge_signatures(signatures(store, ["node"] + pts), "h", store)
        print(f"renew_changes: history {year}: {len(store.rows)} units, "
              f"{len({d for r in store.rows.values() for d in r})} days")
    seq, tech, sp, src = all_signatures()
    last = max(src) if src else None
    detected = {name: detect_unit(days, last) for name, days in seq.items()}
    imp = load_impacts(detected)
    for year in todo:
        store = _year_store(by_year[year], live)
        n = fill_impacts(imp, store, detected, year)
        n_rt = sum(int(r[6].sum()) for days in store.rows.values() for r in days.values())
        print(f"renew_changes: history {year}: moved-dispatch estimates for {n} event(s), "
              f"{n_rt:,} unit-hours with a real-time node price")
    write_json_gz(OUT_DIR / "impacts.json.gz", imp)
    write_events(detected, seq, tech, src)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--history", metavar="DIR", help="build from the history release's Parquet files in DIR")
    ap.add_argument("--years", nargs="*", help="with --history: only these years")
    args = ap.parse_args(argv)
    if args.history:
        build_from_history(args.history, set(args.years) if args.years else None)
    else:
        from .store import load_index
        build_renew_changes(load_index())


if __name__ == "__main__":
    main()
