"""Shutdown decisions against the day-ahead market: for every day a thermal unit started online,
what riding through the day's cheapest hours would have cost it at its own node's day-ahead
price, whether a DAM award covered those hours, and whether it shut down.  From that, each
unit's own cutoff: the day-ahead loss above which it turns off when it holds no award.  The
cutoff and tomorrow's day-ahead node prices then give the units expected to turn off tomorrow.
Needs no downloads.  Read by commitment.html and unit.html.

Decision days use only what was known when the day-ahead market cleared: the DAM price at the
unit's settlement point (data/dam/), its minimum-energy cost and LSL from its three-part offer
(its most recent one within COST_DAYS days, else the technology's generic cost), and its DAM
energy award.  For a unit online in hour ending 1:

  loss      the worst contiguous window of the day of (minimum-energy cost - DAM node price)
            x LSL, in $: what staying on at minimum through those hours loses day-ahead,
            before any start cost
  award     the share of the window's hours with an energy award of at least AWARD_LSL x LSL
  shut      1 if the unit went offline that day for at least OUT_MIN_H hours (the spell may run
            past midnight); a day the unit went on declared outage without such a shutdown is
            not a decision

A combined-cycle train's configurations are merged: the train is online when any of them is,
a single offline hour between online hours is a configuration change, and its LSL, costs and
award are the smallest LSL, smallest costs and summed awards of its configurations.  An
offline spell that is mostly declared outage, or has fewer than OUT_MIN_H hours OFF before
the outage, is an outage throughout (the rule trends.js uses for the cheap-stretch groups).

The cutoff is the loss that best separates a unit's shutdowns from its stays on days with no
award (award share below HALF), chosen once a unit has MIN_DAYS decision days with at least
MIN_EACH shutdowns and MIN_EACH stays.  The rule "off when no award covers the window and the
loss exceeds the cutoff, else on" is scored over all the unit's days (acc) against the share of
its commoner outcome (base).  The cutoff is chosen on those same days, so acc flatters the rule;
each no-award day is also scored with a cutoff chosen from the unit's other days (leave one out),
the accuracy to expect on a day the rule has not seen (acc on unseen days, shown on the pages).

Tomorrow: the latest day with day-ahead node prices (data/dam_nodes.json.gz, posted the day
before the operating day) is scored with each unit's latest costs and its cutoff.  The DAM
award for that day is not public until the 60-day disclosure, so the verdict leans on the
unit's award history: "off" when the loss exceeds the cutoff and the unit rarely holds an
award over its loss window, "maybe" when it often does, "on" when the loss is at or below the
cutoff, and no verdict for a unit without a cutoff.  Every day's verdicts are kept and scored
once its 60-day data arrives.

Writes data/decisions.json.gz:
  dates             the decision days (60-day days with a DAM file and hourly unit states)
  units             {train: [tech, lsl, mingen, hot start, est, days, shutdowns, award share,
                     base, cutoff ($), acc, highest loss stayed, lowest loss shut, acc on unseen days]}
                    cutoff, both accs, highest and lowest are null for a unit without a cutoff;
                    est is 0 when the costs are the unit's own latest offer, 2 when generic
  days              [[train, date, loss, first hour ending of the window, hours, award share,
                     shut, hours off]]
  tomorrow          {date, rows: [[train, tech, lsl, loss, first hour ending, hours, cutoff,
                     award share, verdict]]} for the latest day with node prices, or null
  predictions       {date: [[train, verdict, loss]]} every day scored so far
  scored            [[date, train, verdict, shut]] predictions for days whose decision is known
  flags             shutdowns that break the unit's pattern, newest first: [[train, date, kind,
                    loss, hours off, days since its previous shutdown (null if none in the
                    data), award share]]; kind is "new" for a unit's first shutdown after
                    NEW_DAYS or more days without one (with at least NEW_DAYS days of data
                    before it) and "award" for a shutdown over a window a DAM award covered in
                    full (award share at least AWARD_FULL)
"""
import numpy as np

from .config import DATA_DIR, GENERIC_COSTS
from .intraday import train_of
from .store import read_json_gz, write_json_gz
from .trends import UNIT_TECHS

OUT_MIN_H = 4        # an off spell needs this many hours to be a shutdown; see trends.js ST_OUT_MIN_H
AWARD_LSL = 0.9      # an hour is covered by an award of at least this share of LSL
HALF = 0.5           # award share at which a day's window counts as covered
COST_DAYS = 10       # how far back a unit's own DAM costs are carried
MIN_DAYS = 15        # decision days before a unit gets a cutoff, ...
MIN_EACH = 3         # ... with at least this many shutdowns and this many stays
NEW_DAYS = 30        # days without a shutdown after which the next one is new behaviour
AWARD_FULL = 0.9     # award share of the window above which a shutdown is flagged as despite an award
PATH = DATA_DIR / "decisions.json.gz"
NODES_PATH = DATA_DIR / "dam_nodes.json.gz"
TECHS = [t for t in UNIT_TECHS if t != "nuclear"]
RANK = {"a": 4, "m": 3, "0": 2, "o": 1, "-": 0}


def _r(x, nd=0):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _merge_strips(strips, techs):
    """{train: state array} with a combined-cycle train's configurations merged and outage-like
    off spells rewritten to "o"."""
    by, cc = {}, set()
    rank = np.vectorize(RANK.get)
    for name, s in strips.items():
        t = techs.get(name)
        if t not in TECHS:
            continue
        key = train_of(name) if t == "combined_cycle" else name
        if t == "combined_cycle":
            cc.add(key)
        a = np.frombuffer(s.encode(), dtype="S1").astype(str)
        cur = by.get(key)
        if cur is None:
            by[key] = a.copy()
            continue
        n = min(len(cur), len(a))
        pick = rank(a[:n]) > rank(cur[:n])
        cur[:n][pick] = a[:n][pick]
        if len(a) > len(cur):
            by[key] = np.concatenate([cur, a[len(cur):]])
    for key, st in by.items():
        run = np.isin(st, ["m", "a"])
        if key in cc:
            gap = (~run[1:-1]) & run[:-2] & run[2:] & (st[1:-1] == "0")
            st[1:-1][gap] = "m"
            run = np.isin(st, ["m", "a"])
        k, N = 0, len(st)
        while k < N:
            if run[k]:
                k += 1
                continue
            j = k
            while j < N and not run[j]:
                j += 1
            seg = st[k:j]
            off, outage = int((seg == "0").sum()), int((seg == "o").sum())
            if outage and (off < OUT_MIN_H or outage > off):
                seg[seg == "0"] = "o"
            k = j
    return by


def _dam_trains(dd):
    """Per train from a DAM day file: tech, lsl, mingen, hot start, settlement point, node
    prices [24], award [24]."""
    tr = {}
    for name, u in dd.get("units", {}).items():
        t = u.get("tech")
        if t not in TECHS:
            continue
        key = train_of(name) if t == "combined_cycle" else name
        e = tr.setdefault(key, {"tech": t, "lsl": None, "mingen": None, "hot": None, "sp": u.get("sp") or None,
                                "spp": None, "aw": np.zeros(24)})
        lsl = u.get("lsl")
        if lsl and lsl > 0:
            e["lsl"] = lsl if e["lsl"] is None else min(e["lsl"], lsl)
        if u.get("mingen") is not None:
            e["mingen"] = u["mingen"] if e["mingen"] is None else min(e["mingen"], u["mingen"])
        hot = (u.get("start") or [None])[0]
        if hot:
            e["hot"] = hot if e["hot"] is None else min(e["hot"], hot)
        spp = u.get("spp") or []
        if e["spp"] is None and len(spp) >= 24 and all(v is not None for v in spp[:24]):
            e["spp"] = np.array(spp[:24], dtype=float)
        aw = u.get("award") or []
        e["aw"][:min(24, len(aw))] += np.array([v or 0 for v in aw[:24]], dtype=float)
    return tr


def _window(loss):
    """Worst contiguous window of an hourly loss array: (total, first hour index, hours)."""
    best, cur, s, bs, be = 0.0, 0.0, 0, -1, -1
    for h, v in enumerate(loss):
        if cur <= 0:
            cur, s = v, h
        else:
            cur += v
        if cur > best:
            best, bs, be = cur, s, h
    return (best, bs, be - bs + 1) if bs >= 0 else (0.0, -1, 0)


def _shutdown(st, k0):
    """(shut, hours off) for the merged state from hour index k0 over the next 24 hours: an off
    spell of at least OUT_MIN_H hours that starts in the day, counted to its end."""
    N, k, best = len(st), k0 + 1, 0
    while k < k0 + 24 and k < N:
        if st[k] == "0" and st[k - 1] in "ma":
            j = k
            while j < N and st[j] in "0o-":
                j += 1
            n = j - k
            if n >= OUT_MIN_H:
                best = max(best, n)
            k = j
        else:
            k += 1
    return best > 0, best


def _shutdown_days(st, dates, si):
    """Day indices on which a merged state starts an off spell of OUT_MIN_H hours or more."""
    out, N, k = set(), len(st), 1
    while k < N:
        if st[k] == "0" and st[k - 1] in "ma":
            j = k
            while j < N and st[j] in "0o-":
                j += 1
            if j - k >= OUT_MIN_H:
                out.add(k // 24)
            k = j
        else:
            k += 1
    return sorted(out)


def _cutoff(days):
    """(cutoff, acc, base, highest loss stayed, lowest loss shut) from a unit's decision rows
    (loss, award share, shut), or None when there are too few."""
    y = np.array([d[2] for d in days], dtype=int)
    if len(days) < MIN_DAYS or y.sum() < MIN_EACH or (1 - y).sum() < MIN_EACH:
        return None
    free = [(d[0], d[2]) for d in days if d[1] < HALF]
    if len(free) < MIN_EACH * 2 or sum(s for _, s in free) < 2 or sum(1 - s for _, s in free) < 2:
        return None
    v = np.array([l for l, _ in free]); s = np.array([s for _, s in free])
    best = (-1.0, None)
    for c in np.unique(np.r_[v.min() - 1, v]):
        acc = float(((v > c) == (s == 1)).mean())
        if acc > best[0]:
            best = (acc, float(c))
    c = best[1]
    pred = np.array([0 if d[1] >= HALF else int(d[0] > c) for d in days])
    acc = float((pred == y).mean())
    base = float(max(y.mean(), 1 - y.mean()))
    stayed = [d[0] for d in days if not d[2]]
    shut = [d[0] for d in days if d[2]]
    return c, acc, base, max(stayed), min(shut)


def _acc_unseen(days):
    """_cutoff's acc with each no-award day judged by a cutoff chosen from the unit's other days
    (leave one out): the share of days to expect the rule to call right on a day it has not seen.
    Days with an award are called "on" whatever the cutoff.  Only for the page; the forecast
    keeps _cutoff."""
    free = [(d[0], d[2]) for d in days if d[1] < HALF]
    v = np.array([l for l, _ in free]); s = np.array([s for _, s in free])
    right = sum(int(d[2] == 0) for d in days if d[1] >= HALF)
    keep = np.ones(len(v), bool)
    for i in range(len(v)):
        keep[i] = False
        cands = np.unique(np.r_[v[keep].min() - 1, v[keep]])
        hits = ((v[keep][None, :] > cands[:, None]) == (s[keep][None, :] == 1)).mean(axis=1)
        right += int((v[i] > cands[int(np.argmax(hits))]) == (s[i] == 1))   # lowest cutoff on a tie, as _cutoff
        keep[i] = True
    return right / len(days)


def _verdict(loss, cutoff, award_share):
    if cutoff is None:
        return None
    if loss <= cutoff:
        return "on"
    return "maybe" if award_share >= HALF else "off"


def build_decisions(index: dict) -> None:
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={})
    sdates, strips = uh.get("dates", []), uh.get("units", {})
    dam_dates = set(index["days"].get("dam", []))
    si = {d: i for i, d in enumerate(sdates)}
    dates = [d for d in sdates if d in dam_dates and (DATA_DIR / "dam" / f"{d}.json.gz").exists()]
    techs, latest, rows = {}, {}, []
    by_unit = {}
    dam_days = {}
    for d in dates:
        dd = read_json_gz(DATA_DIR / "dam" / f"{d}.json.gz")
        if not dd:
            continue
        for name, u in dd.get("units", {}).items():
            techs[name] = u.get("tech")
        dam_days[d] = _dam_trains(dd)
    merged = _merge_strips(strips, techs)
    # costs carried forward: the most recent own offer within COST_DAYS days, else generic
    carried = {}
    for d in dates:
        i = si[d]
        tr = dam_days.get(d, {})
        for key, e in tr.items():
            if e["mingen"] is not None and e["lsl"]:
                carried[key] = (i, e["mingen"], e["lsl"], e["hot"], e["sp"])
            elif key in carried and e["lsl"] and e["sp"]:
                carried[key] = (carried[key][0], carried[key][1], e["lsl"], carried[key][3], e["sp"])
        for key, e in tr.items():
            st = merged.get(key)
            if st is None or (i + 1) * 24 > len(st) or st[i * 24] not in "ma":
                continue
            if e["spp"] is None:
                continue
            c = carried.get(key)
            if c and i - c[0] <= COST_DAYS:
                mingen, lsl, hot, est = c[1], e["lsl"] or c[2], c[3], 0
            else:
                g = GENERIC_COSTS.get(e["tech"])
                if g is None or not e["lsl"]:
                    continue
                mingen, lsl, hot, est = g[3], e["lsl"], g[0], 2
            latest[key] = (e["tech"], lsl, mingen, hot, est, e["sp"])
            day = st[i * 24:(i + 1) * 24]
            shut, off_h = _shutdown(st, i * 24)
            if not shut and "o" in day:
                continue
            loss, bs, nh = _window((mingen - e["spp"]) * lsl)
            cov = float((e["aw"][bs:bs + nh] >= AWARD_LSL * lsl).mean()) if nh else 0.0
            rows.append([key, d, _r(loss), bs + 1 if nh else None, nh, _r(cov, 2), int(shut), off_h])
            by_unit.setdefault(key, []).append((loss, cov, int(shut)))
    units = {}
    for key, days in by_unit.items():
        tech, lsl, mingen, hot, est, _ = latest[key]
        y = [d[2] for d in days]
        aw = float(np.mean([d[1] >= HALF for d in days]))
        c = _cutoff(days)
        units[key] = [tech, _r(lsl, 1), _r(mingen, 2), _r(hot), est, len(days), int(sum(y)), _r(aw, 2),
                      _r(max(np.mean(y), 1 - np.mean(y)), 2) if days else None,
                      _r(c[0]) if c else None, _r(c[1], 2) if c else None, _r(c[3]) if c else None, _r(c[4]) if c else None,
                      _r(_acc_unseen(days), 2) if c else None]
    # tomorrow: the latest day with node prices, scored with the latest costs and cutoffs
    old = read_json_gz(PATH, default={}) or {}
    predictions = {k: v for k, v in (old.get("predictions") or {}).items()}
    nodes = read_json_gz(NODES_PATH, default=None) or {"days": {}}
    tomorrow = None
    for nd in sorted(nodes["days"]):
        prices = nodes["days"][nd]
        out = []
        for key, (tech, lsl, mingen, hot, est, sp) in latest.items():
            p = prices.get(sp) if sp else None
            if not p or any(v is None for v in p):
                continue
            u = units.get(key)
            cutoff, aw = (u[9], u[7]) if u else (None, None)
            loss, bs, nh = _window((mingen - np.array(p, dtype=float)) * lsl)
            v = _verdict(loss, cutoff, aw)
            out.append([key, tech, _r(lsl, 1), _r(loss), bs + 1 if nh else None, nh, cutoff, aw, v])
        if out:
            predictions[nd] = [[r[0], r[8], r[3]] for r in out if r[8]]
            tomorrow = {"date": nd, "rows": out}
    # shutdowns that break the pattern: the first after NEW_DAYS days without one, or one over a
    # window a DAM award covered in full
    flags = []
    first_day = {key: min(si[r[1]] for r in rows if r[0] == key) for key in by_unit}
    shut_days = {key: _shutdown_days(merged[key], sdates, si) for key in by_unit}
    for r in rows:
        key, d, loss, _, _, cov, shut, off_h = r
        if not shut:
            continue
        i = si[d]
        prev = [x for x in shut_days[key] if x < i]
        since = i - prev[-1] if prev else None
        new = (since is None or since >= NEW_DAYS) and i - first_day[key] >= NEW_DAYS
        if new or cov >= AWARD_FULL:
            flags.append([key, d, "new" if new else "award", loss, off_h, since, cov])
    flags.sort(key=lambda f: f[1], reverse=True)
    known = {(r[0], r[1]): r[6] for r in rows}
    scored = [[d, key, v, known[(key, d)]] for d in sorted(predictions) for key, v, _ in predictions[d] if (key, d) in known]
    write_json_gz(PATH, {
        "dates": dates, "out_min_h": OUT_MIN_H, "award_lsl": AWARD_LSL, "cost_days": COST_DAYS,
        "min_days": MIN_DAYS, "min_each": MIN_EACH,
        "units": units, "days": rows, "tomorrow": tomorrow, "predictions": predictions, "scored": scored,
        "new_days": NEW_DAYS, "award_full": AWARD_FULL, "flags": flags,
    })
    n_cut = sum(1 for u in units.values() if u[9] is not None)
    print(f"decisions: {len(dates)} days, {len(rows)} unit-days, {len(units)} units, {n_cut} with a cutoff, {len(flags)} flags"
          + (f", tomorrow {tomorrow['date']}: {len(tomorrow['rows'])} units" if tomorrow else ", no node prices for tomorrow"))
