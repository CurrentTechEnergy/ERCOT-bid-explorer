"""Predictor backtests on the 60-day days, with the real hub gas prices (pipeline/private.py reads
them from R2 when R2_* is set; run by .github/workflows/backtest.yml).  Nothing here changes the
site: scores and summaries go to --out.

    python -m analysis.backtest.run oi base unit_hr --from 2026-02 --out backtest
    python -m analysis.backtest.run ct base spark --out backtest

oi  operator-informed on/off model (pipeline/models/operator_informed.py), CC and gas steam, day
    files and scores for every 60-day day from --from on (live fits only, no drivers), as the
    Feb-Aug 2026 test behind its v6 numbers.  Variants:
      base     the model as it is
      unit_hr  each unit's or train's heat rate at minimum (pipeline/heat_rates) in its gas cost
               in place of the per-technology HEAT_RATE: the day-before gas price it reads is
               scaled by unit / technology heat rate, so every gas-cost feature moves with it
ct  CT turn-on model (pipeline/models/peaker_oi.py), monthly expanding fits.  Variants:
      base     the model as it is
      spark    every node price (day-ahead and real-time) less the unit's gas cost the day before
               (gascost.gas_cost: 11.0 x its own hub, Henry Hub where it has none)
      spark_full, spark_min  the same at each unit's measured full-load or minimum heat rate
               (analysis/epa_heat_rates/ct_hr.csv), the measured median for the rest

cuts  combined-cycle turn-off cutoffs (pipeline/decisions.py), each train's no-award days judged
    by a cutoff chosen from its other days (leave one out, as "acc on unseen days").  Variants:
      base     the trains' gas cost as it is (gascost: 7.548 x own hub)
      unit_hr  each train's heat rate at minimum (pipeline/heat_rates) in place of 7.548

Writes <out>/<model>-<variant>/summary.json and prints one line per technology and hour set.
"""
import argparse
import bisect
import collections
import json
import time
from pathlib import Path

import numpy as np

from pipeline import gascost
from pipeline.config import DATA_DIR
from pipeline.store import read_json_gz, write_json_gz, load_index


def _hh():
    g = read_json_gz(DATA_DIR / "gas.json.gz", default={}) or {}
    gd, gv = g.get("dates") or [], g.get("value") or []

    def before(d):
        i = bisect.bisect_left(gd, d) - 1
        while i >= 0 and gv[i] is None:
            i -= 1
        return gv[i] if i >= 0 else None
    return before


def run_oi(variant, frm, out):
    from pipeline.forecast import context as C
    from pipeline.models import operator_informed as oi, operator_scores as sc
    oi.OUT_DIR = out
    sc.OUT_DIR = out
    sc.PATH = out / "scores.json.gz"
    _pd = oi.p_day
    oi.p_day = lambda ctx, d, k, cop=False: None if cop else _pd(ctx, d, k)
    oi.drivers = lambda *a, **k: []
    if variant == "unit_hr":
        from pipeline import heat_rates     # PR #288
        _gb = oi._gas_before

        def gas_before(ctx, d, key):
            g = _gb(ctx, d, key)
            if g is None:
                return None
            tech = "combined_cycle" if "_CC" in key else "gas_steam"
            return g * heat_rates.at_min(tech, key)[0] / oi.HEAT_RATE[tech]
        oi._gas_before = gas_before
    elif variant != "base":
        raise SystemExit(f"unknown oi variant {variant}")
    ctx = C.Context(load_index())
    done = []
    for d in sorted(oi._days(ctx)):
        if d < frm + "-01":
            continue
        u = oi.day_units(ctx, d)
        if u:
            write_json_gz(out / f"{d}.json.gz", {"date": d, "units": u})
            done.append(d)
    sc.build_scores(ctx, done)
    S = read_json_gz(sc.PATH)
    cols = S["columns"]
    agg = collections.defaultdict(lambda: np.zeros(len(cols) - 6))
    for r in S["rows"]:
        if r[5] != "operator":
            continue
        v = np.array([0 if x is None else x for x in r[6:]], float)
        agg[(r[1], "all")] += v
        if r[4]:
            agg[(r[1], "cheap")] += v
    return {f"{t} {h}": dict(zip(cols[6:], v.tolist())) for (t, h), v in sorted(agg.items())}, len(done)


def run_ct(variant, out):
    from pipeline.models import peaker_oi as pk
    pk.PATH = out / "oi.json.gz"
    if variant in ("spark", "spark_full", "spark_min"):
        hh = _hh()
        _rows = pk._rows
        hr = collections.defaultdict(lambda: 11.0)
        if variant != "spark":     # measured per unit (analysis/epa_heat_rates/ct_hr.py), else the measured median
            import csv
            col, n_min = ("hr_full", "hours") if variant == "spark_full" else ("hr_min", "min_hours")
            rs = [r for r in csv.DictReader(open(Path(__file__).parents[1] / "epa_heat_rates" / "ct_hr.csv"))
                  if r[col] and int(r[n_min]) >= (50 if variant == "spark_full" else 30)]
            med = float(np.median([float(r[col]) for r in rs]))
            hr = collections.defaultdict(lambda: med, {r["unit"]: float(r[col]) for r in rs})
            print(f"  {variant}: {len(rs)} units measured, others {med:.2f}", flush=True)

        def rows(uh, cts, dates, node, lamd, ruc):
            R, n = _rows(uh, cts, dates, node, lamd, ruc)
            gc = np.array([hr[cts[u]] / 11.0 * (gascost.gas_cost("combustion_turbine", cts[u], dates[i]) or
                           (11.0 * (hh(dates[i]) or np.nan))) for u, i in zip(R["u"], R["i"])], float)
            gc = np.where(np.isnan(gc), np.nanmedian(gc), gc)
            for c in ("da", "da_ahead", "rt1", "rt3", "da1", "peak"):
                R[c] = R[c] - gc
            return R, n
        pk._rows = rows
    elif variant != "base":
        raise SystemExit(f"unknown ct variant {variant}")
    n = pk.build_peaker_oi()
    res = {}
    for ch, name in ((None, "all"), (1, "cheap")):
        o = pk.summary(cheap=ch).get("operator", {})
        res[f"combustion_turbine {name}"] = {k: float(v) for k, v in o.items()}
    return res, n


def run_cuts(variant):
    from pipeline import decisions as dc
    if variant == "unit_hr":
        from pipeline import heat_rates
        _cost = gascost.cost

        def cost(tech, key, date, mingen, est):
            c, e = _cost(tech, key, date, mingen, est)
            if e == gascost.EST and tech in gascost.HEAT_RATE:
                c = c * heat_rates.at_min(tech, key)[0] / gascost.HEAT_RATE[tech]
            return c, e
        gascost.cost = cost
    elif variant != "base":
        raise SystemExit(f"unknown cuts variant {variant}")
    D = dc.build_decisions(load_index(), write=False)
    by = collections.defaultdict(list)
    for key, d, loss, _, _, cov, shut, _ in D["days"]:
        if (D["units"].get(key) or [None])[0] == "combined_cycle" and loss is not None:
            by[key].append((loss, cov, shut))
    t = collections.Counter()
    for key, days in by.items():
        if dc._cutoff(days) is None:
            continue
        t["trains"] += 1
        free = [(l, s) for l, c, s in days if c < dc.HALF]
        v = np.array([l for l, _ in free]); y = np.array([s for _, s in free])
        for l, c, s in days:
            if c >= dc.HALF:
                t["days"] += 1; t["award_days"] += 1; t["right"] += int(s == 0)
                t["off_n"] += s
        keep = np.ones(len(v), bool)
        for i in range(len(v)):
            keep[i] = False
            cands = np.unique(np.r_[v[keep].min() - 1, v[keep]])
            hits = ((v[keep][None, :] > cands[:, None]) == (y[keep][None, :] == 1)).mean(axis=1)
            call = int(v[i] > cands[int(np.argmax(hits))])
            keep[i] = True
            t["days"] += 1; t["right"] += int(call == y[i]); t["off_n"] += int(y[i])
            t["off_caught"] += int(call and y[i]); t["off_false"] += int(call and not y[i])
    return {"combined_cycle cutoffs": {k: float(x) for k, x in t.items()}}, len(D["dates"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=("oi", "ct", "cuts"))
    ap.add_argument("variants", nargs="+")
    ap.add_argument("--from", dest="frm", default="2026-02")
    ap.add_argument("--out", default="backtest")
    a = ap.parse_args()
    for v in a.variants:
        out = Path(a.out) / f"{a.model}-{v}"
        out.mkdir(parents=True, exist_ok=True)
        t0 = time.time()
        res, n = run_oi(v, a.frm, out) if a.model == "oi" else run_ct(v, out) if a.model == "ct" else run_cuts(v)
        json.dump(res, open(out / "summary.json", "w"), indent=1)
        print(f"== {a.model} {v}: {n} days, {time.time() - t0:.0f}s", flush=True)
        for k, d in res.items():
            if a.model == "cuts":
                print(f"  {k:28s} {int(d['trains'])} trains, right {int(d['right'])}/{int(d['days'])}  "
                      f"off {int(d['off_caught'])}/{int(d['off_n'])} false {int(d['off_false'])}", flush=True)
                continue
            h = max(d.get("hours", 0), 1)
            print(f"  {k:28s} brier {d.get('brier', 0) / h:.4f}  off {int(d.get('off_caught', 0))}/{int(d.get('off_n', 0))} "
                  f"false {int(d.get('off_false', 0))}  on {int(d.get('on_caught', 0))}/{int(d.get('on_n', 0))} false {int(d.get('on_false', 0))}", flush=True)


if __name__ == "__main__":
    main()
