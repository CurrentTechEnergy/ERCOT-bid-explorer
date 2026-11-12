"""Real-time reserve prices (MCPC) for every 60-day day since RTC+B, for the reserve-price
tolerance on the margin charts (pipeline/marginal.py, pipeline/marginal_nodes.py) and the limited
stack's crossings (pipeline/actual_stack.py).

Under RTC+B (Dec 5, 2025) SCED prices energy and reserves together, so in a scarcity interval
system lambda sits above the marginal energy offer by about the reserve price the unit gives up:
a unit offering energy at $700 when Non-Spin clears at $230 is indifferent at a lambda of $930.
Reading lambda against offers then needs a band widened by that interval's reserve price.

Each day's NP6-331-CD files come through pipeline/rt_as.rt_mcpc: the day's bulk zip is read
from the raw store (R2) first, and only a day missing there is asked of ERCOT and kept in the
store.  A run asks ERCOT for at most MAX_NEW days, so a backfill spreads over runs.

data/rt_mcpc.json.gz  {"services": [...], "days": {date: {service: [96 x $/MW per hour, null]}}}
                      15-minute intervals in clock order from midnight (the fall-back day's
                      repeated hour folded into one, as rt_as does)
"""
import datetime as dt

import numpy as np

from .config import DATA_DIR, EMIL_RT_MCPC
from .log import warn
from .store import read_json_gz, write_json_gz

OUT = DATA_DIR / "rt_mcpc.json.gz"
SERVICES = ["regup", "regdn", "rrs", "ecrs", "nspin"]
UP = ["regup", "rrs", "ecrs", "nspin"]       # services that hold back output, priced into lambda in scarcity
RTCB_START = "2025-12-05"
MAX_NEW = 20                                  # days a run may ask ERCOT for (the rest come from the raw store)


def fetch_reserve_prices(api, dates) -> None:
    """Add the days in `dates` (RTC+B on) missing from rt_mcpc.json.gz."""
    from .rt_as import rt_mcpc
    have = read_json_gz(OUT, default=None) or {"services": SERVICES, "days": {}}
    want = sorted(d for d in set(dates) if d >= RTCB_START and d not in have["days"])
    if not want:
        return
    if not api.raw.enabled:
        warn("reserve prices: the raw store (R2) is not configured; not fetched")
        return
    if getattr(api.raw, "_failed", False):
        warn("reserve prices: the raw store is not keeping files this run; only days already in it are read")
    asked = 0
    got = 0
    for d in want:
        day = dt.date.fromisoformat(d)
        if not api.raw.has(EMIL_RT_MCPC, f"day-{d}"):     # a HEAD request: nothing downloaded
            if asked >= MAX_NEW or getattr(api.raw, "_failed", False):
                continue
            asked += 1
        try:
            f = rt_mcpc(api, [day])
        except Exception as e:           # one bad day must not stop the run
            warn(f"reserve prices {d}: {type(e).__name__}: {e}")
            continue
        if f.empty:
            continue
        slot = ((f["he"].astype(int) - 1) * 4 + f["interval"].astype(int) - 1).to_numpy()
        ok = (slot >= 0) & (slot < 96)
        have["days"][d] = {s: [None] * 96 for s in SERVICES}
        for s in SERVICES:
            v = f[s].to_numpy(float)
            for i, x in zip(slot[ok], v[ok]):
                have["days"][d][s][i] = round(float(x), 2) if np.isfinite(x) else None
        got += 1
    have["days"] = dict(sorted(have["days"].items()))
    write_json_gz(OUT, have)
    left = len(want) - got
    print(f"reserve prices: {got} day(s) added ({asked} asked of ERCOT, the rest from the raw store)"
          + (f", {left} still missing" if left else ""), flush=True)


def load() -> dict:
    return (read_json_gz(OUT, default=None) or {}).get("days") or {}


def up_price(days: dict, date: str) -> np.ndarray | None:
    """The highest real-time price among the up services in each 15-minute interval of the day
    (96 values, 0 where none), or None when the day has no prices (before RTC+B, or not fetched)."""
    day = days.get(date)
    if not day:
        return None
    a = np.array([[np.nan if v is None else v for v in (day.get(s) or [None] * 96)] for s in UP], float)
    return np.nan_to_num(np.nanmax(np.where(np.isfinite(a), a, -np.inf), axis=0), neginf=0.0).clip(min=0.0)


def at_runs(up: np.ndarray | None, runs) -> np.ndarray:
    """The up-reserve price in force at each SCED run (minutes from midnight), 0 without prices."""
    r = np.asarray(runs, int)
    if up is None:
        return np.zeros(r.size)
    return up[np.clip((r % 1440) // 15, 0, 95)]
