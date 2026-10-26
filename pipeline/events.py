"""One shared list of unit events: everything the site's detectors found that changed for a
unit, in one format, with the update run that first found it.  Needs no downloads.  Read by
the What's changing page, the Unit page's recent changes and the subscription emails
(pipeline/notify.py); the per-unit Atom feeds are written here too.

Sources (each already computed by its own module; nothing is detected twice):
  shutdown_new     decisions.py flags "new": a unit's first shutdown after 30 or more days
                   without one
  shutdown_award   decisions.py flags "award": a shutdown over a window a day-ahead award
                   covered in full
  group            groups.py rules applied to each calendar month: the unit moved between the
                   stays-on family (never, seasonal), multi-day and daily (both months need
                   MIN_MONTH_DAYS days of data).  Major when daily cycling starts or stops; a
                   month without a shutdown says little about a seasonal or multi-day unit,
                   and the daily sub-groups move with the month's prices, so neither is an
                   event
  bidding          trends.py detect_changes: a sustained shift in the share offered at or
                   below $0, in running without an offer curve, or in offer price against
                   peers (signal in "field")
  cutoff           models/cutoff_history.py: the unit's recent loss cutoff moved away from the
                   cutoff the site showed (status confirmed / contradicted / pending)
  renew_*          renew_changes.py events for wind and solar (floor_new, floor_back,
                   formula_on, formula_off, terms, moving_on, moving_off, episode), one event
                   per plant with its units listed
  fuel             fleet-wide, not one unit: a technology's median first offer price above $0
                   (trends_60d "first", the price trends.py measures each unit against its peers
                   with, so a fuel-price move that the bidding kind removes shows here instead)
                   shifting between K online days and the K before, by FUEL thresholds.  Unit
                   key "fleet:<tech>"; carries the Houston Ship Channel gas price over the same
                   two windows (gas_hubs) beside it
  battery_size     storage.py units.json.gz: a lasting change in a battery's HSL or maximum state
                   of charge: SIZE_SHARE or more for SIZE_WINDOW days, holding most of the SIZE_HOLD days after; major from SIZE_MAJOR.
                   Not in a battery's first SIZE_HOLD days charging or discharging
  battery_new      a battery's first day charging or discharging, after the fleet's first
                   NEW_GRACE days of data (every battery was renamed for RTC+B on Dec 5, 2025, so
                   its first day in SCED says nothing)
  new_unit         any other unit's first day in SCED (trends.py first_seen), after the record's
                   first NEW_GRACE days; combined-cycle configurations count by train, so a new
                   configuration of a known train is not a new unit
  control          qse.py history (unit_qse.json.gz): the unit's decision-making entity or QSE
                   changed (a new tolling, offtake or management agreement, or a transfer),
                   named from entities.json.gz.  One event per plant (resource-name prefix),
                   date and change, with its units listed.  Major when the DME changed; a QSE
                   change alone is a new scheduling agent for the same decision maker
  outage_start, outage_end
                   an outage spell of OUTAGE_DAYS days or more in the hourly states
                   (unit_hours_60d, outages rewritten as groups.py does), when it started and
                   when it ended; major from OUTAGE_MAJOR days

Every event:
  id        "<unit>|<date>|<kind>", stable across runs
  date      operating date the change is dated to (about sixty days old when found, since
            unit-level data comes from the 60-day disclosure)
  seen      the date of the update run that first wrote the event (UTC); the emails go by this.
            Events written by the first build carry its date, kept in the file as "baseline",
            and count as history rather than news
  unit      train or unit key as the Unit page uses it (plant for renewable events, with
            "units" listing the members)
  tech, kind, major (true for the changes shown by default; the rest sit behind "show all")
  title     one line a reader can scan
  before, after, value   the numbers behind it (value is one context number, see "field")
  field     what before / after / value are, in the kind's own terms

Writes
  data/events.json.gz        {updated, baseline, kinds, first, last, n, n_major, new_today,
                              events: [...]}, newest first
  data/feeds/all.xml         Atom feed of the latest FEED_ALL major events
  data/feeds/units/<unit>.xml  Atom feed per unit with at least one event (latest FEED_UNIT)
"""
import datetime as dt
import html
import re
from collections import defaultdict

import numpy as np

from .config import DATA_DIR, SITE_URL
from .groups import GROUPED_TECHS, GROUPS, assign_groups
from .entities import PATH as ENTITIES_PATH
from .models.cutoff_history import PATH as CUTOFF_PATH
from .qse import PATH as QSE_PATH
from .dam_offers import KINDS as DAM_KINDS
from .renew_changes import KINDS as RENEW_KINDS
from .store import read_json_gz, write_json_gz
from .trends import K, SIGNALS, UNIT_TECHS

PATH = DATA_DIR / "events.json.gz"
FEED_DIR = DATA_DIR / "feeds"
MIN_MONTH_DAYS = 20   # days of hourly data a month needs before its group counts
OUTAGE_DAYS = 7       # an outage this long or longer is an event when it starts and ends, ...
OUTAGE_MAJOR = 30     # ... and a major one from this length
# fuel: (minimum $/MWh, minimum share of the before median) a median shift must pass, and the
# share from which it is major.  Coal's bar sits above its largest swing in the record ($7, 47%
# from Nov 2025 to Aug 2026): 22 units, so the median steps between a few units' prices
FUEL = {"combined_cycle": (5, 0.2, 0.5), "gas_steam": (5, 0.2, 0.5), "combustion_turbine": (5, 0.2, 0.5),
        "coal": (12, 0.6, 0.6)}
FUEL_MIN_UNITS = 5    # units with a price that day before its median counts
FUEL_HUB = "hsc"      # gas hub shown beside the shift (gas_hubs.json.gz)
# battery size changes (see the docstring)
SIZE_WINDOW, SIZE_BASE, SIZE_MIN_BASE = 7, 30, 20      # days with a value
SIZE_SHARE, SIZE_MW, SIZE_HOLD, SIZE_MAJOR = 0.2, 5, 30, 0.5
NEW_GRACE = 14
FEED_ALL = 200        # entries in the all-units feed
FEED_UNIT = 30        # entries in a unit's feed
DAILY = ("daily1", "daily2", "daily3")
FAMILY = {"never": "on", "seasonal": "on", "multiday": "multiday", "daily1": "daily", "daily2": "daily", "daily3": "daily"}
GROUP_LABEL = {g[0]: g[1] for g in GROUPS}
KINDS = {
    "shutdown_new": "Shut down after a long run",
    "shutdown_award": "Shut down despite a day-ahead award",
    "group": "Timescale group changed",
    "bidding": "Bidding approach shifted",
    "cutoff": "Loss cutoff moved",
    "fuel": "Fleet median offer shifted",
    "battery_size": "Battery size changed",
    "battery_new": "New battery",
    "new_unit": "New unit",
    "control": "Decision maker or QSE changed",
    "outage_start": "Outage started",
    "outage_end": "Outage ended",
    **{f"renew_{k}": v for k, v in RENEW_KINDS.items()},
    **{f"dam_{k}": v for k, v in DAM_KINDS.items()},
}
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")


def _ev(unit, date, kind, tech, title, major, before=None, after=None, value=None, field=None, **extra):
    e = {"id": f"{unit}|{date}|{kind}", "date": date, "unit": unit, "tech": tech, "kind": kind,
         "major": bool(major), "title": title, "before": before, "after": after, "value": value, "field": field}
    e.update(extra)
    return e


def _usd(x):
    return f"-${abs(x):,.0f}" if x < 0 else f"${x:,.0f}"


# ------------------------------------------------------------------ sources ---
def shutdown_events(dec):
    out = []
    for key, date, kind, loss, off_h, since, cov in dec.get("flags", []):
        tech = (dec["units"].get(key) or [None])[0]
        if kind == "new":
            title = (f"Shut down for {off_h} h after {since} days without a shutdown" if since
                     else f"First shutdown in the record, off {off_h} h")
            out.append(_ev(key, date, "shutdown_new", tech, title, True, value=loss, field="stay-on loss $",
                           since=since, off_h=off_h))
        else:
            out.append(_ev(key, date, "shutdown_award", tech,
                           f"Shut down for {off_h} h although a day-ahead award covered {cov:.0%} of the window",
                           True, value=loss, field="stay-on loss $", award=cov, off_h=off_h))
    return out


def group_events(uh, tech_of):
    """Each unit's group month by month, and an event where it differs from the month before."""
    dates = uh.get("dates") or []
    by_month = defaultdict(list)
    for i, d in enumerate(dates):
        by_month[d[:7]].append(i)
    months = sorted(m for m, idx in by_month.items() if len(idx) >= MIN_MONTH_DAYS)
    groups = {}
    for m in months:
        idx = by_month[m]
        sub = {"dates": [dates[i] for i in idx],
               "units": {n: "".join(s[i * 24:(i + 1) * 24] for i in idx) for n, s in uh.get("units", {}).items()},
               "hsl": uh.get("hsl") or {}}
        _, units = assign_groups(sub, tech_of)
        groups[m] = {k: (e["group"], e["tech"]) for k, e in units.items() if e["ran"]}
    out = []
    for prev, m in zip(months, months[1:]):
        for key, (g, tech) in groups[m].items():
            p = groups[prev].get(key)
            if p is None or FAMILY[p[0]] == FAMILY[g]:
                continue
            major = "daily" in (FAMILY[p[0]], FAMILY[g])
            out.append(_ev(key, by_month[m] and dates[by_month[m][0]], "group", tech,
                           f"{GROUP_LABEL[p[0]]} in {prev} to {GROUP_LABEL[g]} in {m}", major,
                           before=p[0], after=g, field="timescale group", month=m))
    return out


def bidding_events(tr):
    out = []
    for name, tech, date, sig, before, after in tr.get("changes", []):
        label = SIGNALS[sig]["label"]
        if sig == "rel":
            title, major = f"{label}: {_usd(before)} to {_usd(after)}/MWh", abs(after - before) >= 20
            b, a = before, after
        else:
            title, major = f"{label}: {before:.0%} to {after:.0%} of the day", abs(after - before) >= 0.5 or sig == "noff"
            b, a = before, after
        out.append(_ev(name, date, "bidding", tech, title, major, before=b, after=a, field=sig))
    return out


def fuel_events(tr, hubs):
    dates, units = tr.get("dates", []), tr.get("units", [])
    hub = (hubs.get("hubs") or {}).get(FUEL_HUB) or {}
    gas = dict(zip(hub.get("dates", []), hub.get("value", [])))

    def gas_med(lo, hi):
        v = [x for d, x in gas.items() if lo <= d <= hi and x is not None]
        return round(float(np.median(v)), 2) if v else None
    out = []
    for tech, (thr_usd, thr_share, major_share) in FUEL.items():
        rows = [u["first"] for u in units if u["tech"] == tech]
        med, n = {}, {}
        for i in range(len(dates)):
            v = [r[i] for r in rows if r[i] is not None]
            if len(v) >= FUEL_MIN_UNITS:
                med[i], n[i] = float(np.median(v)), len(v)
        idx = sorted(med)
        cand = []
        for j in range(K, len(idx) - K + 1):
            b = float(np.median([med[i] for i in idx[j - K:j]]))
            a = float(np.median([med[i] for i in idx[j:j + K]]))
            if abs(a - b) >= thr_usd and b > 0 and abs(a - b) / b >= thr_share:
                cand.append((abs(a - b) / b, j, b, a))
        # the strongest point of each run of candidate days, at least K online days apart (as
        # trends.detect_changes does for a unit)
        taken = []
        for share, j, b, a in sorted(cand, reverse=True):
            if all(abs(j - t) >= K for t, *_ in taken):
                taken.append((j, b, a, share))
        for j, b, a, share in taken:
            i = idx[j]
            gb, ga = gas_med(dates[idx[j - K]], dates[idx[j - 1]]), gas_med(dates[i], dates[idx[j + K - 1]])
            g = f"; Houston Ship Channel gas ${gb:.2f} to ${ga:.2f}/MMBtu" if gb is not None and ga is not None else ""
            out.append(_ev(f"fleet:{tech}", dates[i], "fuel", tech,
                           f"Median offer {_usd(b)} to {_usd(a)}/MWh over {n[i]} units{g}", share >= major_share,
                           before=round(b, 1), after=round(a, 1), value=n[i],
                           field="median first offer above $0, $/MWh; value: units with a price",
                           gas_before=gb, gas_after=ga))
    return out


def cutoff_events(ch):
    out = []
    for mv in ch.get("moves", []):
        nx = mv.get("next")
        tail = (f"; the next month's decisions {'confirm it' if mv['status'] == 'confirmed' else 'contradict it' if mv['status'] == 'contradicted' else 'are split'}"
                f" ({nx['new_right']} of {nx['n']} right against {nx['site_right']})" if nx else "; not yet tested on a following month")
        out.append(_ev(mv["unit"], mv["month"], "cutoff", mv["tech"],
                       f"Loss cutoff {_usd(mv['from'])} to {_usd(mv['to'])} per MW of minimum output{tail}", True,
                       before=mv["from"], after=mv["to"], value=mv["gain"], field="$ per MW of LSL; value: recent decisions gained",
                       status=mv["status"], before_usd=mv["from_usd"], after_usd=mv["to_usd"]))
    return out


def _regime(r):
    if not r:
        return "?"
    k, v = r.get("k"), r.get("v")
    if k == "f":
        return f"floor {_usd(v)}" if v is not None else "floor"
    if k == "x":
        return "formula"
    if k == "m":
        return "moving within the day"
    if k == "peak":
        return f"{_usd(v)} for the episode" if v is not None else "episode"
    return str(k)


def renew_events(rc):
    out = []
    for e in rc.get("events", []):
        kind = e["kind"]
        before, after = e.get("before"), e.get("after")
        bv = before.get("v") if isinstance(before, dict) else None
        av = after.get("v") if isinstance(after, dict) else None
        big = bv is not None and av is not None and abs(av - bv) >= 10
        major = (not e.get("toggler")) and (kind in ("formula_on", "formula_off", "terms") or (kind in ("floor_new", "floor_back") and big))
        title = f"{RENEW_KINDS[kind]}: {_regime(before)} to {_regime(after)}"
        if kind == "episode" and e.get("days"):
            title += f" for {e['days']} day(s)"
        out.append(_ev(e["plant"], e["date"], f"renew_{kind}", e["tech"], title, major,
                       before=bv, after=av, value=e.get("days"), field="offer $/MWh; value: days",
                       units=e.get("units") or [], toggler=bool(e.get("toggler"))))
    return out


def dam_events(do):
    """Day-ahead offer changes (dam_offers.py), keyed by train (combined cycle) or plant."""
    out = []
    for e in do.get("events", []):
        kind, b, a = e["kind"], e.get("before"), e.get("after")
        units = e.get("units") or []
        if kind == "mingen_step":
            title = f"{DAM_KINDS[kind]}: {_usd(b)} to {_usd(a)}/MWh"
            if e.get("mk_before") is not None and e.get("mk_after") is not None:
                title += f" ({_usd(e['mk_before'])} to {_usd(e['mk_after'])} against the fuel-cost line)"
            field = "minimum-energy offer $/MWh"
        elif kind == "priced_out":
            title = f"{DAM_KINDS[kind]}: minimum energy at {_usd(a)}/MWh against a usual {_usd(b)} for {e.get('days')} day(s)"
            field = "minimum-energy offer $/MWh; value: days"
        elif kind == "start_change":
            title = f"{DAM_KINDS[kind]}: hot start {_usd(b)} to {_usd(a)}"
            field = "hot start $"
        elif kind == "renew_floor":
            title = f"{DAM_KINDS[kind]}: {_usd(b)} to {_usd(a)}/MWh"
            field = "day-ahead floor $/MWh"
        else:
            title = f"{DAM_KINDS[kind]}: {b} to {a}"
            field, b, a = None, None, None
        unit = units[0] if len(units) == 1 and e["tech"] != "combined_cycle" else e["plant"]
        out.append(_ev(unit, e["date"], f"dam_{kind}", e["tech"], title, e.get("major"), before=b, after=a,
                       value=e.get("days"), field=field, units=units, repricer=bool(e.get("repricer"))))
    return out


def outage_events(uh, tech_of):
    dates = uh.get("dates") or []
    if not dates:
        return []
    out = []
    # thermal units with a group (CC trains merged), plus nuclear from the raw strips
    _, units = assign_groups(uh, {n: t for n, t in tech_of.items() if t in GROUPED_TECHS})
    strips = {k: (e["tech"], e["st"]) for k, e in units.items()}
    d0 = dt.date.fromisoformat(dates[0])
    for n, t in tech_of.items():
        if t == "nuclear" and n in uh.get("units", {}):
            s = uh["units"][n]
            strips[n] = (t, [s[i * 24 + h] if i * 24 + h < len(s) else "-"
                             for i, d in enumerate(dates) for h in range(24)])
    for key, (tech, st) in strips.items():
        N, k = len(st), 0
        while k < N:
            if st[k] != "o":
                k += 1
                continue
            j = k
            while j < N and st[j] == "o":
                j += 1
            days = (j - k) / 24
            if days >= OUTAGE_DAYS:
                start = (d0 + dt.timedelta(days=k // 24)).isoformat()
                if k > 0:   # an outage already running when the record starts has no start
                    out.append(_ev(key, start, "outage_start", tech, f"Outage began, lasting {days:.0f} days" if j < N
                                   else f"Outage began, still on at the end of the data ({days:.0f} days so far)",
                                   days >= OUTAGE_MAJOR, value=round(days), field="days"))
                if j < N:
                    end = (d0 + dt.timedelta(days=(j - 1) // 24)).isoformat()
                    out.append(_ev(key, end, "outage_end", tech, f"Back from a {days:.0f}-day outage",
                                   days >= OUTAGE_MAJOR, value=round(days), field="days"))
            k = j
    return out


def _size_changes(x):
    """Positions j in a daily series (days with a value) where the SIZE_WINDOW days from j moved
    SIZE_SHARE or more from the median of the SIZE_BASE days before, every one of them at least
    half that far, and held by most of the SIZE_HOLD days after; strongest first, SIZE_BASE apart."""
    W, cand = SIZE_WINDOW, []
    for j in range(SIZE_MIN_BASE, len(x) - W - SIZE_HOLD + 1):
        b, w, a = x[max(0, j - SIZE_BASE):j], x[j:j + W], x[j + W:j + W + SIZE_HOLD]
        mb, mw, ma = np.median(b), np.median(w), np.median(a)
        d = mw - mb
        moved = mb > 0 and abs(d) >= max(SIZE_MW, SIZE_SHARE * mb) and (np.sign(w - mb) == np.sign(d)).all() \
            and (abs(w - mb) >= abs(d) / 2).all()
        kept = (np.sign(a - mb) == np.sign(d)).mean() >= 0.9 and abs(ma - mb) >= abs(d) / 2
        if moved and kept:
            cand.append((abs(d), j))
    taken = []
    for _, j in sorted(cand, reverse=True):
        if all(abs(j - t) >= SIZE_BASE for t in taken):
            taken.append(j)
    return taken


def battery_events(su):
    dates, units = su.get("dates") or [], su.get("units") or {}
    if not dates:
        return []
    active = [i for i in range(len(dates)) if any((u["dis"][i] or 0) > 0 or (u["chg"][i] or 0) > 0 for u in units.values())]
    if not active:
        return []
    out, W = [], SIZE_WINDOW
    for name, u in sorted(units.items()):
        act = [i for i in range(len(dates)) if (u["dis"][i] or 0) > 0 or (u["chg"][i] or 0) > 0]
        if act and act[0] >= active[0] + NEW_GRACE:
            first = act[:W]
            mw = max((u["hsl"][i] or 0 for i in first), default=0)
            mwh = max((u["soc_max"][i] or 0 for i in first), default=0)
            size = ", ".join(t for t in (f"{mw:,.0f} MW" if mw else "", f"{mwh:,.0f} MWh" if mwh else "") if t)
            out.append(_ev(name, dates[act[0]], "battery_new", "storage",
                           "First day charging or discharging" + (f": {size}" if size else ""), True,
                           value=mw or None, field="MW", mwh=mwh or None))
        size = defaultdict(list)
        for f, label in (("hsl", "MW"), ("soc_max", "MWh")):
            # a new battery ramps up to its size over its first weeks: not a change
            pts = [(i, x) for i, x in enumerate(u[f]) if x and act and i >= act[0] + SIZE_HOLD]
            if len(pts) < SIZE_MIN_BASE + W + SIZE_HOLD:
                continue
            idx, x = [i for i, _ in pts], np.array([v for _, v in pts], float)
            for j in _size_changes(x):
                b, a = float(np.median(x[max(0, j - SIZE_BASE):j])), float(np.median(x[j:j + W]))
                size[idx[j]].append((f, label, round(b), round(a)))
        for i, sig in sorted(size.items()):
            parts = [f"{'Maximum output' if f == 'hsl' else 'Maximum state of charge'} {b:,} to {a:,} {label}"
                     for f, label, b, a in sig]
            f, label, b, a = sig[0]
            out.append(_ev(name, dates[i], "battery_size", "storage", "; ".join(parts),
                           any(abs(a - b) >= SIZE_MAJOR * b for _, _, b, a in sig), before=b, after=a, field=label,
                           signals=[[f, b, a] for f, _, b, a in sig]))
    return out


def new_unit_events(tr):
    seen, dates = tr.get("first_seen") or {}, tr.get("dates") or []
    have = [d for d, h in zip(dates, tr.get("has_units") or []) if h]
    if not seen or len(have) <= NEW_GRACE:
        return []
    trains = defaultdict(list)
    for name, (d, tech, d_hsl, top) in seen.items():
        if tech != "storage":
            trains[_train(name)].append((d, tech, d_hsl, top))
    out = []
    for key, rows in sorted(trains.items()):
        d, tech = min(rows)[:2]
        if d <= have[NEW_GRACE - 1]:
            continue
        on = min((r[2] for r in rows if r[2]), default=None)
        top = max(r[3] for r in rows)     # a train: its largest configuration
        title = "First day in SCED" + (f", first HSL above zero {on}" if on and on != d else "") + (f"; up to {top:,.0f} MW so far" if top else ", no HSL yet")
        out.append(_ev(key, d, "new_unit", tech, title, True, value=round(top) if top else None, field="MW",
                       online=on))
    return out


def control_events(qh, ent, tech_of):
    hist, dme_names, qse_names = qh.get("history") or {}, ent.get("dme") or {}, ent.get("qse") or {}
    def name(code, names):      # dme names are strings, qse names [name, date]; a code no list names stays a code
        n = names.get(code)
        n = n[0] if isinstance(n, list) else n
        return n or (f"ERCOT code {code}" if code else "unknown")
    plants = defaultdict(list)     # (plant, date, new qse, new dme) -> [(unit, old qse, old dme)]
    for unit, rows in hist.items():
        for a, b in zip(rows, rows[1:]):        # a combined-cycle configuration counts as its train
            plants[(unit.split("_")[0], b[0], b[1], b[2])].append((_train(unit), a[1], a[2]))
    out = []
    for (plant, date, q1, d1), got in sorted(plants.items()):
        units = sorted({u for u, _, _ in got})
        d0s = sorted({d for _, _, d in got if d and d != d1})
        q0s = sorted({q for _, q, _ in got if q and q != q1})
        dme = bool(d1 and d0s)
        if dme:
            title = f"Offers now decided by {name(d1, dme_names)}, was {', '.join(name(d, dme_names) for d in d0s)}"
        else:
            title = f"Scheduled by {name(q1, qse_names)}, was {', '.join(name(q, qse_names) for q in q0s) or 'unknown'}"
        key = units[0] if len(units) == 1 else plant
        tech = next((tech_of[u] for u in units if u in tech_of), "other")
        out.append(_ev(key, date, "control", tech, title, dme, before=[q0s, d0s], after=[q1, d1], field="QSE, DME codes",
                       units=units))
    return out


def _train(u):
    m = re.match(r"^(.*_CC\d+)_", u)
    return m.group(1) if m else u


# -------------------------------------------------------------------- feeds ---
def _atom(title, link, entries):
    # the feed's own "updated" is its newest entry's, not the run time, so a feed file only
    # changes (and is only committed) when it has a new entry
    updated = max((e["seen"] for e in entries), default="1970-01-01") + "T00:00:00Z"
    lines = ['<?xml version="1.0" encoding="utf-8"?>', '<feed xmlns="http://www.w3.org/2005/Atom">',
             f"  <title>{html.escape(title)}</title>", f'  <link href="{html.escape(link)}"/>',
             f"  <id>{html.escape(link)}</id>", f"  <updated>{updated}</updated>"]
    for e in entries:
        unit_link = f"{SITE_URL}unit.html?unit={e['unit']}"
        lines += ["  <entry>", f"    <title>{html.escape(e['unit'] + ': ' + KINDS[e['kind']] + ' (' + e['date'] + ')')}</title>",
                  f'    <link href="{html.escape(unit_link)}"/>',
                  f"    <id>{html.escape(unit_link + '#' + e['id'].replace('|', '/'))}</id>",
                  f"    <updated>{e['seen']}T00:00:00Z</updated>",
                  f"    <summary>{html.escape(e['title'])}</summary>",
                  "  </entry>"]
    lines.append("</feed>")
    return "\n".join(lines) + "\n"


def _write_if_changed(path, text):
    if not path.exists() or path.read_text() != text:
        path.write_text(text)


def write_feeds(events):
    FEED_DIR.mkdir(parents=True, exist_ok=True)
    (FEED_DIR / "units").mkdir(exist_ok=True)
    major = [e for e in events if e["major"]][:FEED_ALL]
    _write_if_changed(FEED_DIR / "all.xml", _atom("ERCOT bid explorer: unit changes", SITE_URL, major))
    per = defaultdict(list)
    for e in events:
        if e["kind"] == "fuel":       # fleet-wide: in the all-units feed only
            continue
        for u in [e["unit"], *e.get("units", [])]:
            if len(per[u]) < FEED_UNIT:
                per[u].append(e)
    written = set()
    for u, es in per.items():
        name = _SAFE.sub("_", u)
        _write_if_changed(FEED_DIR / "units" / f"{name}.xml", _atom(f"{u}: bidding and operating changes", f"{SITE_URL}unit.html?unit={u}", es))
        written.add(f"{name}.xml")
    for p in (FEED_DIR / "units").glob("*.xml"):      # units with no events any more
        if p.name not in written:
            p.unlink()
    return len(written)


# -------------------------------------------------------------------- build ---
def build_events(index: dict) -> dict:
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    dec = read_json_gz(DATA_DIR / "decisions.json.gz", default={}) or {}
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    rc = read_json_gz(DATA_DIR / "renew_changes.json.gz", default={}) or {}
    do = read_json_gz(DATA_DIR / "dam_offers.json.gz", default={}) or {}
    ch = read_json_gz(CUTOFF_PATH, default={}) or {}
    hubs = read_json_gz(DATA_DIR / "gas_hubs.json.gz", default={}) or {}
    su = read_json_gz(DATA_DIR / "storage" / "units.json.gz", default={}) or {}
    qh = read_json_gz(QSE_PATH, default={}) or {}
    ent = read_json_gz(ENTITIES_PATH, default={}) or {}
    tech_of = {u["unit"]: u["tech"] for u in tr.get("units", []) if u["tech"] in UNIT_TECHS}
    # every unit's technology for the control events, from the last unit index (built after this)
    ui = read_json_gz(DATA_DIR / "unit_index.json.gz", default={}) or {}
    ic = ui.get("columns") or []
    tech_all = {r[ic.index("unit")]: r[ic.index("tech")] for r in ui.get("rows", [])} if "unit" in ic else {}
    tech_all.update({u["unit"]: u["tech"] for u in tr.get("units", [])})
    tech_all.update({_train(u["unit"]): u["tech"] for u in tr.get("units", [])})
    tech_all.update({u: "storage" for u in (su.get("units") or {})})
    events = (shutdown_events(dec) + group_events(uh, tech_of) + bidding_events(tr) + cutoff_events(ch)
              + renew_events(rc) + dam_events(do) + outage_events(uh, tech_of) + fuel_events(tr, hubs) + battery_events(su)
              + new_unit_events(tr) + control_events(qh, ent, tech_all))
    old = read_json_gz(PATH, default=None) or {}
    seen = {e["id"]: e["seen"] for e in old.get("events", [])}
    # the first build has no earlier file to compare with, so every event it writes is history,
    # not news: they are dated to that run and the run's date is kept as the baseline, which
    # notify.py skips, so the first email never carries years of past events
    baseline = old.get("baseline") or today
    # likewise a kind the earlier file did not have (a detector added since, such as the battery
    # events): its first run finds the whole record, which is history too, so it takes the baseline
    old_kinds = {e["kind"] for e in old.get("events", [])}
    by_id = {}
    for e in events:
        if e["id"] in by_id:
            continue
        e["seen"] = seen.get(e["id"], today if not old_kinds or e["kind"] in old_kinds else baseline)
        by_id[e["id"]] = e
    events = sorted(by_id.values(), key=lambda e: (e["date"], e["unit"], e["kind"]), reverse=True)
    updated = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"updated": updated, "kinds": KINDS, "baseline": baseline,
           "first": events[-1]["date"] if events else None, "last": events[0]["date"] if events else None,
           "n": len(events), "n_major": sum(e["major"] for e in events),
           "new_today": sum(e["seen"] == today for e in events) if today != baseline else 0,
           "events": events}
    write_json_gz(PATH, out)
    n_feeds = write_feeds(events)
    counts = defaultdict(int)
    for e in events:
        counts[e["kind"]] += 1
    print(f"events: {len(events)} ({out['n_major']} major, {out['new_today']} new this run), {n_feeds} unit feeds; "
          + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    return out
