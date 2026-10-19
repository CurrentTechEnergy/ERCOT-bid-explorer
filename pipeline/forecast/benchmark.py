"""The fixed benchmark set a model version must beat before it is promoted (site layout plan,
section 6.2): about 30 days, ten low, ten medium, ten high-priced, including a cold snap and a
solar-heavy spring day, all with the 60-day answer in.

  python -m pipeline.forecast.benchmark                 # current versions' scores on the set
  python -m pipeline.forecast.benchmark --select        # (re)choose the days into benchmark.json
  python -m pipeline.forecast.benchmark --against FILE  # compare with a saved scores.json.gz

Promotion rule: a new version is promoted only if its benchmark headline hit rate and unit hit
rate are not worse, its worst group's MAE is not worse than the version in use, and its
cheap-hour floor MAE (committed minimum in hours with the day-ahead hub at or below
score.CHEAP_HUB, over every as-of scored day, not just the set) is not worse.  The set alone
holds too few cheap hours to judge the floor, so that line reads all as-of days.

The set is scored as chosen, hindsight days included, so the gate does not move under a
version; the cheap-hour line and the site's track record leave hindsight days out.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

from ..config import DATA_DIR
from ..store import read_json_gz
from . import context as C
from .score import PATH as SCORES, summarise

BENCH = Path(__file__).with_name("benchmark.json")
PER_BAND = 10
MUST = ["2026-01-25", "2026-04-12"]     # Winter Storm Fern's spike day; a cheap, solar-heavy spring Sunday


def select(ctx: C.Context) -> dict:
    """Ten days per band, spread evenly across the band by daily hub average, among days with
    the 60-day answer; MUST days replace the nearest pick in their band."""
    from .build import band_edges, band_of
    have = {d for d in ctx.days60 if (DATA_DIR / "60d-units" / f"{d}.json.gz").exists()} & set(ctx.dam_days)
    daily = ctx.hub_daily()
    last = max(have)
    edges, _ = band_edges(ctx, last)
    by = {"low": [], "medium": [], "high": []}
    for d in sorted(have):
        if d in daily:
            by[band_of(daily[d], edges)].append((daily[d], d))
    chosen = {}
    for b, lst in by.items():
        lst.sort()
        idx = np.unique(np.linspace(0, len(lst) - 1, PER_BAND).round().astype(int)) if lst else []
        chosen[b] = [lst[i][1] for i in idx]
    for m in MUST:
        if m in daily and m in have:
            b = band_of(daily[m], edges)
            if m not in chosen[b]:
                near = min(chosen[b], key=lambda d: abs(daily[d] - daily[m]))
                chosen[b][chosen[b].index(near)] = m
    return {"edges": edges, "days": {b: sorted(v) for b, v in chosen.items()}, "must": MUST}


def report(scores: dict, bench: dict) -> dict:
    days = {d for v in bench["days"].values() for d in v}
    sub = {d: s for d, s in scores.get("days", {}).items() if d in days}
    return summarise(sub, asof_only=False)


def floor_report(scores: dict) -> dict:
    """{versions key: floor summary} over every as-of scored day."""
    return {k: s.get("floor") for k, s in summarise(scores.get("days", {})).items()}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--select", action="store_true")
    ap.add_argument("--against", help="a saved scores.json.gz to compare with")
    args = ap.parse_args(argv)
    if args.select:
        from ..store import load_index
        bench = select(C.Context(load_index()))
        BENCH.write_text(json.dumps(bench, indent=1))
        print(f"benchmark set: {sum(len(v) for v in bench['days'].values())} days -> {BENCH}")
        return 0
    bench = json.loads(BENCH.read_text())
    cur_sc = read_json_gz(SCORES, default={"days": {}})
    rows = [("current", report(cur_sc, bench), floor_report(cur_sc))]
    if args.against:
        old = read_json_gz(Path(args.against), default={"days": {}})
        rows.append(("against", report(old, bench), floor_report(old)))
    for label, summ, floors in rows:
        for k, s in summ.items():
            worst = max((g["mae"] or 0) for g in (s["group"] or {}).values()) if s["group"] else None
            print(f"{label} [{k}]: n={s['n']} headline_hit={s['headline_hit']} unit_hit={s['unit_hit']} "
                  f"thermal_mae={s['thermal_mae']} worst_group_mae={worst}")
            for b, bs in s["by_band"].items():
                print(f"   {b:7s} n={bs['n']} headline_hit={bs['headline_hit']} unit_hit={bs['unit_hit']} thermal_mae={bs['thermal_mae']}")
        for k, f in floors.items():
            if f:
                print(f"{label} [{k}] floor over all as-of days: " + "  ".join(
                    f"{h} {f[h]['hours']}h mae={f[h]['mae']} bias={f[h]['bias']}" for h in ("all", "cheap", "neg")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
