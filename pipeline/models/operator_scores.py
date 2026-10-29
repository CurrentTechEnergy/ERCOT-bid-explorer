"""Scorecard for the operator-informed model (pipeline/models/operator_informed.py) against four
baselines, each adding one thing the operator plainly had:
  state         a unit stays as it went into the day (its state at HE24 of D - 1)
  award         on in awarded hours; unawarded, a unit that was on shuts and one that was off
                stays off (a unit with no award all day stays as it went in)
  ridethrough   as award, but an unawarded unit that is on shuts only when running on to its next
                award (or the end of the day) loses more than its own hot start, and one that is
                off starts when the day's best run ahead earns more than its hot start
  own_cutoff    as ridethrough, against the unit's own cutoff (pipeline.decisions) fitted on its
                decision days before the month, else its hot start: the decisions.py rule made
                time-honest
Losses and profits are at the unit's own day-ahead node price against its minimum-energy cost,
times its LSL, from the same day records the model uses.

Scored hour by hour on the days with an operator day file, in day mode (the model's call is on
at a chance of 0.5 or more).  Outage and unknown hours never count, and a day whose unit went in
on outage is left out.  Hours ERCOT had the unit committed by RUC (operator_informed.ruc_hours)
are not the operator's decision: they count only in ruc_hours, and a switch into or out of one
(actual or called) is neither caught nor false.  A turn-off or turn-on counts as caught when the call switches the same way
within MATCH hours of the actual switch; a call's switch that matches none is false.

Cells: month, technology, state going in (on or off), awarded (that hour, or the hour of the
switch), cheap (the day-ahead hub at CHEAP $/MWh or less that hour, or within CHEAP_NEAR hours
of the switch).

Writes data/operator/scores.json.gz:
  {"model", "version", "cheap", "models": [...], "live_from", "columns": [...], "rows": [[month, tech, start,
   award, cheap, model, hours, right, brier, off_n, off_caught, off_false, on_n, on_caught,
   on_false, ruc_hours], ...]}
brier is the summed squared error of the chance (the model only; null for the baselines).
live_from is the first day of the 60-day fits; months before it are history days, judged by the
reduced fits (operator_history.py).
Rebuilt in full by every update after the day files (a few seconds).
"""
from collections import defaultdict

import numpy as np

from ..decisions import PATH as DECISIONS_PATH, _cutoff
from ..forecast import context as C
from ..store import read_json_gz, write_json_gz
from .operator_informed import NAME, OUT_DIR, VERSION, _days, _on, _states, ruc_hours

PATH = OUT_DIR / "scores.json.gz"
CHEAP = 10.0           # $/MWh, day-ahead hub average
CHEAP_NEAR = 3         # hours either side of a switch that make it a cheap-stretch switch
MATCH = 1              # hours a call's switch may be off the actual one and still catch it
MODELS = ("operator", "state", "award", "ridethrough", "own_cutoff")
COLUMNS = ("month", "tech", "start", "award", "cheap", "model", "hours", "right", "brier",
           "off_n", "off_caught", "off_false", "on_n", "on_caught", "on_false", "ruc_hours")


def baseline(kind, r, on0, thr=None):
    """[24] bool: a baseline's call for one unit-day from its day record r (operator_informed._days)
    and its state going in."""
    aw, spp, mg, lsl, hot = r["aw"].astype(bool), r["spp"], r["mingen"], r["lsl"], r["hot"]
    if kind == "state" or (kind == "award" and not aw.any()):
        return np.full(24, on0)
    thr = hot if thr is None else thr
    out, s = np.zeros(24, bool), on0
    for h in range(24):
        if aw[h]:
            s = True
        elif kind == "award":
            s = False
        elif s:
            end = next((j for j in range(h, 24) if aw[j]), 24)
            s = not float(((mg - spp[h:end]) * lsl).sum()) > thr
        else:
            s = bool(np.cumsum((spp[h:] - mg) * lsl).max() > hot)
        out[h] = s
    return out


def _switches(prev, seq, valid):
    """[(hour, "on" | "off")] where seq changes from the hour before, both hours valid."""
    out, p = [], prev
    for h in range(24):
        if valid[h] and (h == 0 or valid[h - 1]) and seq[h] != p:
            out.append((h, "on" if seq[h] else "off"))
        p = seq[h]
    return out


def _cutoffs():
    """cutoff(train, date): the unit's cutoff from its decision days before date's month, or None."""
    rows = defaultdict(list)
    for k, d, loss, he, hrs, aw, shut, hoff in (read_json_gz(DECISIONS_PATH, default=None) or {}).get("days", []):
        rows[k].append((d, loss, aw, shut))
    memo = {}

    def cutoff(k, d):
        m = d[:7]
        if (k, m) not in memo:
            c = _cutoff([(l, a, s) for dd, l, a, s in rows.get(k, ()) if dd < m + "-01"])
            memo[(k, m)] = c[0] if c else None
        return memo[(k, m)]
    return cutoff


def build_scores(ctx, days) -> int:
    """Write the score file for the operator day files `days`; returns the unit-days scored."""
    states, recs, day0, cutoff, ruc = _states(ctx), _days(ctx), ctx.stats["day0"], _cutoffs(), ruc_hours(ctx)
    T = defaultdict(lambda: np.zeros(len(COLUMNS) - 6))   # (month, tech, start, award, cheap, model) -> counts
    n = 0
    for d in days:
        units = (read_json_gz(OUT_DIR / f"{d}.json.gz", default=None) or {}).get("units", {})
        hub = ctx.hub(d)
        cheap = hub <= CHEAP if hub is not None else np.zeros(24, bool)
        m = d[:7]
        for key, u in units.items():
            r = recs.get(d, {}).get(key)
            if r is None or key not in states:
                continue
            t, st = states[key]
            k0 = (C._d(d) - day0).days * 24
            if k0 < 1 or st[k0 - 1] not in "ma0":
                continue
            seg = st[k0:k0 + 24]
            valid, truth, on0 = np.isin(seg, list("ma0")), np.isin(seg, list("ma")), _on(st[k0 - 1])
            rk = ruc.get(key, ())
            in_ruc = np.array([k0 + h in rk for h in range(24)]) & valid
            near_ruc = in_ruc | np.array([k0 + h - 1 in rk for h in range(24)])     # a switch into or out of RUC
            if not valid.any():
                continue
            p = np.array([np.nan if v is None else v for v in u["p"]], float)
            calls = {"operator": p >= 0.5, "state": baseline("state", r, on0), "award": baseline("award", r, on0),
                     "ridethrough": baseline("ride", r, on0)}
            c = cutoff(key, d)
            calls["own_cutoff"] = baseline("ride", r, on0, c) if c is not None else calls["ridethrough"]
            start, aw = "on" if on0 else "off", r["aw"].astype(bool)
            actual = _switches(on0, truth, valid)
            for name in MODELS:
                call = calls[name]
                for h in np.flatnonzero(in_ruc):
                    T[(m, t, start, int(aw[h]), int(cheap[h]), name)][9] += 1
                for h in np.flatnonzero(valid & ~in_ruc):
                    v = T[(m, t, start, int(aw[h]), int(cheap[h]), name)]
                    v[0] += 1
                    v[1] += call[h] == truth[h]
                    if name == "operator" and np.isfinite(p[h]):
                        v[2] += (p[h] - truth[h]) ** 2
                mine, used = _switches(on0, call, np.ones(24, bool)), set()
                for h, kind in actual:
                    if near_ruc[h]:
                        continue
                    v = T[(m, t, start, int(aw[h]), int(cheap[max(0, h - CHEAP_NEAR):h + CHEAP_NEAR + 1].any()), name)]
                    j = 3 if kind == "off" else 6
                    v[j] += 1
                    hit = next((i for i, (hh, kk) in enumerate(mine) if kk == kind and abs(hh - h) <= MATCH and i not in used), None)
                    if hit is not None:
                        used.add(hit)
                        v[j + 1] += 1
                for i, (h, kind) in enumerate(mine):
                    if i not in used and valid[h] and not near_ruc[h]:
                        v = T[(m, t, start, int(aw[h]), int(cheap[max(0, h - CHEAP_NEAR):h + CHEAP_NEAR + 1].any()), name)]
                        v[(3 if kind == "off" else 6) + 2] += 1
            n += 1
    rows = [list(k) + [int(v[0]), int(v[1]), round(float(v[2]), 3) if k[5] == "operator" else None] + [int(x) for x in v[3:]]
            for k, v in sorted(T.items())]
    live = (read_json_gz(OUT_DIR / "index.json.gz", default=None) or {}).get("days") or [None]
    write_json_gz(PATH, {"model": NAME, "version": VERSION, "cheap": CHEAP, "models": list(MODELS),
                         "live_from": live[0], "columns": list(COLUMNS), "rows": rows})
    return n


def summary(path=None, tech=None, cheap=None):
    """{model: totals} from the score file, optionally for one technology and cheap (1) or not (0)."""
    s = read_json_gz(path or PATH, default=None) or {}
    ci = {c: i for i, c in enumerate(s.get("columns", []))}
    out = {}
    for r in s.get("rows", []):
        if (tech and r[ci["tech"]] != tech) or (cheap is not None and r[ci["cheap"]] != cheap):
            continue
        o = out.setdefault(r[ci["model"]], defaultdict(float))
        for c in COLUMNS[6:]:
            o[c] += r[ci[c]] or 0
    return out


if __name__ == "__main__":
    from ..store import load_index
    ctx = C.Context(load_index())
    days = (read_json_gz(OUT_DIR / "index.json.gz", default=None) or {}).get("days", [])
    print(build_scores(ctx, days), "unit-days scored")
    for t in ("combined_cycle", "gas_steam"):
        for ch in (None, 1):
            print(f"\n{t}{' cheap' if ch else ''}")
            for mdl, o in summary(tech=t, cheap=ch).items():
                print(f"  {mdl:12s} right {o['right'] / max(o['hours'], 1):6.1%}  off {int(o['off_caught'])}/{int(o['off_n'])} false {int(o['off_false'])}"
                      f"  on {int(o['on_caught'])}/{int(o['on_n'])} false {int(o['on_false'])}")
