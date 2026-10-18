"""Cutoff history: each thermal unit's loss cutoff refitted at every month end on its most
recent decisions, and the months where the refit moved away from the cutoff the site was
showing.  Detection and display only: the forecast (thermal_cutoff) keeps the all-history
cutoff, which the backtest below shows predicts as well as any window across the fleet.

Why a decision count, not a calendar window: a unit only gets a decision day on a day it
started online (pipeline.decisions), and a cutoff needs MIN_DAYS of them with MIN_EACH
shutdowns and stays.  The median unit has about 30 decision days in a 250-day record, so a
30-calendar-day window holds a handful and almost nothing fits.  The last N_DEC decisions
give a daily-cycling unit a short, current window and a rarely-cycling unit the longer one
it needs.

At each month end M, for every unit with enough decisions:

  recent      _cutoff on the unit's last N_DEC decision days up to M
  site        _cutoff on every decision day up to the previous month end: the all-history
              cutoff the site showed through the month (what a reader would have been
              comparing the month's decisions against)
  move        recent differs from site by MOVE_SHARE or more of the larger of |site| and
              MOVE_FLOOR per MW of LSL, and calls at least MOVE_GAIN more of the N_DEC decisions with no
              award right than site does (the 25% test alone is noisy: a cutoff can sit
              anywhere in the gap between the highest loss stayed and the lowest loss shut)
  status      the move is "confirmed" once the following month's no-award decisions favour the
              new cutoff, "contradicted" when they favour the old one, else "pending"

Backtest on the record to Aug 2026 (python -m pipeline.models.cutoff_history --benchmark):
21 moves, 9 confirmed and 4 contradicted by the following month, and on those units'
next-month decisions the new cutoff was right 130 of 181 times against 115 for the site's
cutoff; fleet-wide that is a handful of calls in about 4,700, which is why the window choice
is invisible in the forecast score.  Calendar windows (60, 90, 120 days) found
moves that held up less well (+6 to +16); 20, 30 and 45 decisions are within noise of each
other on seven months of data and 30 is the default because it flags a move about a month
sooner than 45 for a daily-cycling unit and is less jumpy than 20.

Writes data/cutoff_history.json.gz (cutoffs in $ per MW of LSL so units compare, as on the
commitment curve; "_usd" fields in $):
  model, version, params
  months            the month ends scored, oldest first (the record's last day is included
                    as a partial month so the current month shows)
  units             {train: {"tech", "lsl", "rows": [[month, recent, site, n_recent], ...]}}
                    recent / site null where too few decisions
  moves             [{unit, tech, lsl, month, from, to, from_usd, to_usd, gain, next: {n,
                    site_right, new_right} or null, status}], newest first
  benchmark         the backtest table above for the current data: {moves, confirmed,
                    contradicted, next_decisions, site_right, new_right}
Read by pipeline.events (one event per move) and, later, the Unit page's decision chart.
"""
import argparse
import datetime as dt
import sys
from collections import defaultdict

from ..config import DATA_DIR
from ..decisions import HALF, _cutoff, PATH as DECISIONS_PATH
from ..store import read_json_gz, write_json_gz

NAME = "cutoff_history"
VERSION = "v0"
N_DEC = 30          # decision days in the recent window
MOVE_SHARE = 0.25   # a move is at least this share of the larger of |site cutoff| and one LSL-day
MOVE_GAIN = 3       # ... and the recent cutoff calls at least this many more recent decisions right
PATH = DATA_DIR / "cutoff_history.json.gz"
MOVE_FLOOR = 1.0    # $ per MW of LSL: the floor of the move scale for a unit whose site cutoff is
                    # near $0, so the decisions test (MOVE_GAIN) does the filtering there


def _month_ends(dates):
    """Last date in each calendar month of the record (the final month may be partial)."""
    last = {}
    for d in dates:
        last[d[:7]] = d
    return [last[m] for m in sorted(last)]


def _right(dec, c):
    """How many (loss, shut) decisions the rule 'off when loss > c' calls right."""
    return sum((l > c) == (s == 1) for l, s in dec)


def _fit(rows):
    c = _cutoff([(l, a, s) for _, l, a, s in rows])
    return c[0] if c else None


def build(decisions: dict) -> dict:
    by = defaultdict(list)
    for key, date, loss, _, _, cov, shut, _ in decisions.get("days", []):
        by[key].append((date, float(loss), float(cov), int(shut)))
    for rows in by.values():
        rows.sort()
    months = _month_ends(decisions.get("dates", []))
    units, moves = {}, []
    for key, rows in sorted(by.items()):
        u = decisions["units"].get(key)
        if not u:
            continue
        tech, lsl = u[0], float(u[1] or 0) or 1.0
        out, last_to = [], None
        for i, m in enumerate(months):
            past = [r for r in rows if r[0] <= m]
            win = past[-N_DEC:]
            recent = _fit(win)
            site = _fit([r for r in rows if r[0] <= months[i - 1]]) if i else None
            out.append([m, None if recent is None else round(recent / lsl, 1) + 0.0,
                        None if site is None else round(site / lsl, 1) + 0.0, len(win)])
            if recent is None or site is None:
                continue
            if abs(recent - site) < MOVE_SHARE * max(abs(site), MOVE_FLOOR * lsl):
                continue
            free = [(l, s) for _, l, a, s in win if a < HALF]
            gain = _right(free, recent) - _right(free, site)
            if gain < MOVE_GAIN:
                continue
            # the site cutoff takes months to absorb a new regime, so the same move would be
            # found again at each month end: once a move is recorded, a later refit near its
            # "to" value is the same regime, not a new move
            if last_to is not None and abs(recent - last_to) < MOVE_SHARE * max(abs(last_to), MOVE_FLOOR * lsl):
                continue
            last_to = recent
            nxt_end = months[i + 1] if i + 1 < len(months) else None
            nxt = [(l, s) for d, l, a, s in rows if nxt_end and m < d <= nxt_end and a < HALF]
            if nxt:
                sr, nr = _right(nxt, site), _right(nxt, recent)
                status = "confirmed" if nr > sr else "contradicted" if nr < sr else "pending"
                next_ = {"n": len(nxt), "site_right": sr, "new_right": nr}
            else:
                status, next_ = "pending", None
            moves.append({"unit": key, "tech": tech, "lsl": round(lsl, 1), "month": m,
                          "from": round(site / lsl, 1) + 0.0, "to": round(recent / lsl, 1) + 0.0,
                          "from_usd": round(site), "to_usd": round(recent), "gain": gain,
                          "next": next_, "status": status})
        units[key] = {"tech": tech, "lsl": round(lsl, 1), "rows": out}
    moves.sort(key=lambda mv: (mv["month"], mv["unit"]), reverse=True)
    scored = [mv for mv in moves if mv["next"]]
    bench = {"moves": len(moves), "confirmed": sum(mv["status"] == "confirmed" for mv in moves),
             "contradicted": sum(mv["status"] == "contradicted" for mv in moves),
             "next_decisions": sum(mv["next"]["n"] for mv in scored),
             "site_right": sum(mv["next"]["site_right"] for mv in scored),
             "new_right": sum(mv["next"]["new_right"] for mv in scored)}
    return {"model": NAME, "version": VERSION,
            "params": {"n_dec": N_DEC, "move_share": MOVE_SHARE, "move_gain": MOVE_GAIN, "move_floor": MOVE_FLOOR},
            "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "months": months, "units": units, "moves": moves, "benchmark": bench}


def build_cutoff_history(index: dict) -> dict:
    dec = read_json_gz(DECISIONS_PATH, default=None)
    if not dec:
        print("cutoff_history: no decisions file, skipped")
        return {}
    out = build(dec)
    write_json_gz(PATH, out)
    b = out["benchmark"]
    print(f"cutoff_history {VERSION}: {len(out['months'])} months, {len(out['units'])} units, {b['moves']} moves "
          f"({b['confirmed']} confirmed, {b['contradicted']} contradicted); next-month calls right "
          f"{b['new_right']} new vs {b['site_right']} site of {b['next_decisions']}")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--benchmark", action="store_true", help="print the backtest table and write nothing")
    args = ap.parse_args(argv)
    dec = read_json_gz(DECISIONS_PATH, default=None)
    if not dec:
        print("no decisions file")
        return 1
    if args.benchmark:
        out = build(dec)
        b = out["benchmark"]
        print(f"{NAME} {VERSION}: window {N_DEC} decisions, move {MOVE_SHARE:.0%} and {MOVE_GAIN}+ decisions")
        print(f"moves {b['moves']}, confirmed {b['confirmed']}, contradicted {b['contradicted']}, "
              f"next-month decisions {b['next_decisions']}, site right {b['site_right']}, new right {b['new_right']}")
        for mv in out["moves"]:
            nx = mv["next"]
            print(f"  {mv['unit']:20s} {mv['month']}  {mv['from']:8.1f} -> {mv['to']:8.1f} $/MW LSL  gain {mv['gain']:2d}  "
                  + (f"next {nx['new_right']}/{nx['site_right']} of {nx['n']}  {mv['status']}" if nx else "pending"))
        return 0
    build_cutoff_history({})
    return 0


if __name__ == "__main__":
    sys.exit(main())
