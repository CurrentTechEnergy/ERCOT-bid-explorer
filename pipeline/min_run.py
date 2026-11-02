"""Minimum run times as observed: how long each coal and gas unit stays on once started, from the
hourly per-unit strips in data/unit_hours_60d.json.gz (combined-cycle configurations merged into
their train, as pipeline/groups.py does).  Needs no downloads.  Read by commitment.html (the
"How long units stay on once started" panel) and unit.html (run lengths under Hours online).

ERCOT does not publish registered minimum up times, so this is what the units chose to do: the
floor on how briefly a unit has committed, not its registered limit.

Writes data/min_run_60d.json.gz:
  dates      the period judged (the last WINDOW_DAYS of unit_hours_60d, all of it while shorter)
  min_runs   MIN_RUNS: completed runs a unit needs before its typical shortest run is shown
  pct        PCT: the percentile used as the typical shortest run
  units: {unit or train: [tech, MW, typical shortest run h (null below MIN_RUNS), median run h
                          (null below MIN_RUNS), completed runs, runs ended in an outage,
                          online share of available hours, [every completed run's length in hours, sorted]]}
    MW is the largest of its configurations' median HSL while running.

Rules:
- A unit runs in an hour whose state is "m" or "a" (intraday.unit_hours).  A run is a stretch of
  running hours that starts from offline ("0") or outage ("o") and ends offline but available
  ("0"): a start followed by an economic shutdown.  A run that ends in an outage is counted
  separately as a likely trip and left out, as is a run cut by missing data ("-") or by either end
  of the period.
- In a combined-cycle train a single offline hour between running hours is a configuration
  change, not a shutdown (the groups.py rule).
- Hourly states round each run to whole hours: a run can read up to an hour long or short.  This
  matters most for combustion turbines, whose minimum run is often under an hour.
- The typical shortest run is the PCT percentile of the completed runs rather than the single
  shortest, which is often an abandoned start or a test.
"""
import numpy as np

from .config import DATA_DIR
from .groups import GROUPED_TECHS, key_of, merged_strips
from .store import read_json_gz, write_json_gz
from .trends import listed_units, unit_techs

WINDOW_DAYS = 365
MIN_RUNS = 5
PCT = 10


def unit_runs(st, train: bool) -> tuple:
    """-> (completed run lengths in hours, runs that ended in an outage) for one hourly strip."""
    a = np.array(st)
    run = np.isin(a, ["m", "a"])
    n = len(a)
    if train and n > 2:
        gap = (~run[1:-1]) & run[:-2] & run[2:] & (a[1:-1] == "0")
        run[1:-1] |= gap
    runs, trips, i = [], 0, 0
    while i < n:
        if not run[i]:
            i += 1
            continue
        j = i
        while j < n and run[j]:
            j += 1
        before = a[i - 1] if i > 0 else "-"
        after = a[j] if j < n else "-"
        if before in ("0", "o"):
            if after == "0":
                runs.append(j - i)
            elif after == "o":
                trips += 1
        i = j
    return sorted(runs), trips


def build_min_run(index: dict = None) -> dict:
    uh = read_json_gz(DATA_DIR / "unit_hours_60d.json.gz", default={}) or {}
    tr = read_json_gz(DATA_DIR / "trends_60d.json.gz", default={}) or {}
    dates = uh.get("dates") or []
    if len(dates) > WINDOW_DAYS:
        cut = len(dates) - WINDOW_DAYS
        uh = {**uh, "dates": dates[cut:], "units": {k: s[cut * 24:] for k, s in (uh.get("units") or {}).items()}}
        dates = uh["dates"]
    techs = unit_techs(tr)
    listed = {key_of(n, techs[n]) for n in listed_units(tr) if n in techs}
    _, units = merged_strips(uh, techs)
    out = {}
    for key, e in sorted(units.items()):
        if key not in listed or e["tech"] not in GROUPED_TECHS:
            continue
        runs, trips = unit_runs(e["st"], e["tech"] == "combined_cycle")
        st = np.array(e["st"])
        on = int(np.isin(st, ["m", "a"]).sum())
        avail = int(np.isin(st, ["m", "a", "0"]).sum())
        if not on:
            continue
        enough = len(runs) >= MIN_RUNS
        out[key] = [e["tech"], round(e["mw"]),
                    round(float(np.percentile(runs, PCT)), 1) if enough else None,
                    round(float(np.median(runs)), 1) if enough else None,
                    len(runs), trips, round(on / avail, 3) if avail else None, runs]
    write_json_gz(DATA_DIR / "min_run_60d.json.gz", {
        "dates": dates, "min_runs": MIN_RUNS, "pct": PCT, "units": out})
    shown = sum(1 for v in out.values() if v[2] is not None)
    print(f"min_run_60d: {len(out)} units or trains over {len(dates)} days, {shown} with {MIN_RUNS}+ completed runs")
    return out


if __name__ == "__main__":
    build_min_run()
