"""Each unit's turn-off point by the operator-informed model (pipeline/models/operator_informed.py),
for the Commitment cutoff curve: on every day with an operator day file, for every CC train and gas
steam unit online going into the day, how much being off would have saved, and how much it would
have to save before the model's day call turns the unit off.

The saving (SAVING): the most the unit saves by being off over one stretch of the day at least its
minimum down time long (or to the end of the day, if less is left), at its own day-ahead node price
against its minimum-energy cost, times its LSL: sum over the stretch of (min-energy cost - price)
x LSL.  Its minimum down time is its shortest off spell of at least MIN_DOWN hours before the month,
from the 60-day states, once it has MIN_SPELLS of them; MIN_DOWN until then.  The day ends at HE24:
the next day's prices are not known when the operator decides.

The turn-off point: every hour's price shifted down by the same $/MWh until the model's day call
(p_day under 0.5 in any hour) first turns the unit off, found by bisection on SHIFT, with the
award, state and everything else as they were; reported as the saving at that shift.  The search
starts from the day's own prices and goes one way only: down (toward a bigger saving) when the
model keeps the unit on at them, up when it turns it off at them, so a model that turns a unit off
only at prices far above the day's (JCKCNTY2_CC1 in summer 2026: off at +$200, on at every price
below) reads "never", not the bottom of SHIFT.  "never" when it stays on through the top of SHIFT
(an award all day holds it on), and below 0 when the model turns it off even with nothing saved.  An Oct 2026 check on 8,731 decision days: the saving ranks CC days
that shut above those that stayed on better than the loss over the worst stretch (0.861 against
0.835); subtracting the hot start, or costing at gas, does worse.

Writes data/operator/cutoffs.json.gz:
  {"model", "version", "measure", "columns": [...], "days": {date: [[train, tech, lsl, award,
   saving, turn_off, off, min_down], ...]}}
award 0 none, 1 some hours, 2 every hour; saving and turn_off in $ per MW of LSL (turn_off null
for never); off 1 when the unit was offline in any hour of the day (outage hours aside).
Only days without a row are computed, all of them when VERSION or CUT_VERSION changes.
"""
import numpy as np

from ..store import read_json_gz, write_json_gz
from .operator_informed import NAME, OUT_DIR, VERSION, _days, _on, _p_day, _states, fit

PATH = OUT_DIR / "cutoffs.json.gz"
MIN_DOWN = 3       # hours: the shortest off spell that counts, and the minimum down time until a unit has enough
MIN_SPELLS = 3     # off spells a unit needs before its own minimum down time is used
SHIFT = (-200.0, 400.0)   # $/MWh, the range searched
TOL = 2.0          # $/MWh, bisection stops when the bracket is this narrow
COLUMNS = ("unit", "tech", "lsl", "award", "saving", "turn_off", "off", "min_down")
CUT_VERSION = "c2"   # c2: the search goes one way from the day's prices
MEASURE = "saving from being off over the best stretch at least its minimum down time long, $/MW of LSL"


def saving(spp, mingen, lsl, md):
    """$ saved by being off over the best stretch of at least min(md, hours left) hours."""
    cs = np.r_[0.0, np.cumsum((mingen - spp) * lsl)]
    best = -np.inf
    for s in range(24):
        e0 = s + min(md, 24 - s)
        best = max(best, float((cs[e0:] - cs[s]).max()))
    return best


def _min_down(st, k_month):
    """Shortest off spell of at least MIN_DOWN hours ending before hour k_month, between two
    online hours (spells next to an outage or a gap left out), or MIN_DOWN."""
    seg = st[:k_month]
    spells, i, n = [], 0, len(seg)
    while i < n:
        if seg[i] == "0":
            j = i
            while j + 1 < n and seg[j + 1] == "0":
                j += 1
            if i > 0 and j + 1 < n and _on(seg[i - 1]) and _on(seg[j + 1]) and j - i + 1 >= MIN_DOWN:
                spells.append(j - i + 1)
            i = j + 1
        else:
            i += 1
    return min(spells) if len(spells) >= MIN_SPELLS else MIN_DOWN


def turn_off(ctx, date, key, r, f):
    """The shift ($/MWh) at which the day call first turns the unit off, searched one way from the
    day's own prices (shift 0): SHIFT[0] when it is off even there, None when it stays on through
    SHIFT[1]."""
    def off(x):
        rr = dict(r, spp=r["spp"] - x)
        p = _p_day(ctx, date, key, rr, f)
        return p is not None and bool((p < 0.5).any())
    lo, hi = SHIFT
    if off(0.0):
        if off(lo):
            return lo
        hi = 0.0
    else:
        if not off(hi):
            return None
        lo = 0.0
    while hi - lo > TOL:
        mid = (lo + hi) / 2
        lo, hi = (lo, mid) if off(mid) else (mid, hi)
    return hi


def day_rows(ctx, date):
    states, day0, out = _states(ctx), ctx.stats["day0"], []
    f = fit(ctx, date[:7])
    if f is None:
        return out
    from ..forecast import context as C
    k0 = (C._d(date) - day0).days * 24
    km = (C._d(date[:7] + "-01") - day0).days * 24
    for key, r in sorted(_days(ctx).get(date, {}).items()):
        if key not in states or key not in f[1]["unit"]:
            continue
        st = states[key][1]
        if k0 < 1 or k0 + 24 > len(st) or not _on(st[k0 - 1]):
            continue
        md = _min_down(st, km)
        x = turn_off(ctx, date, key, r, f)
        seg = st[k0:k0 + 24]
        aw = r["aw"].astype(bool)
        lsl = r["lsl"]
        sv = saving(r["spp"], r["mingen"], lsl, md)
        t = None if x is None else saving(r["spp"] - x, r["mingen"], lsl, md)
        out.append([key, r["tech"], round(lsl, 1), 2 if aw.all() else int(aw.any()), round(sv / lsl, 1),
                    None if t is None else round(t / lsl, 1), int((seg == "0").any()), md])
    return out


def build_cutoffs(ctx, days) -> int:
    """Rows for every operator day without them; returns the days computed."""
    old = read_json_gz(PATH, default=None) or {}
    have = old.get("days", {}) if (old.get("version"), old.get("cut_version")) == (VERSION, CUT_VERSION) and tuple(old.get("columns") or ()) == COLUMNS else {}
    out = {d: have[d] for d in days if d in have}
    new = [d for d in days if d not in out]
    for d in new:
        out[d] = day_rows(ctx, d)
    write_json_gz(PATH, {"model": NAME, "version": VERSION, "cut_version": CUT_VERSION, "measure": MEASURE, "columns": list(COLUMNS),
                         "days": dict(sorted(out.items()))})
    return len(new)


if __name__ == "__main__":
    import sys, time
    from ..forecast import context as C
    from ..store import load_index
    ctx = C.Context(load_index())
    days = sys.argv[1:] or (read_json_gz(OUT_DIR / "index.json.gz", default=None) or {}).get("days", [])
    t = time.time()
    n = build_cutoffs(ctx, days)
    print(n, "day(s) computed in", round(time.time() - t), "s")
