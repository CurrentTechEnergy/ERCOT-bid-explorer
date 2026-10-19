"""Shared loader for the analysis scripts: one backtest side's code and inputs, and a table of
every thermal unit-hour on its scored as-of days, forecast against the 60-day answer.

Each script takes a backtest side folder (backtests/<name>/current or .../ref, written by
pipeline/forecast/backtest.py) and imports that side's own pipeline, so it analyses the version
that was scored.  The table is computed once and cached as <side>/unit_hours.pkl.
"""
import os
import sys
from pathlib import Path


def side(path: str) -> Path:
    """Put the side's tree first on the import path (before any pipeline import) and return it."""
    d = Path(path).resolve()
    tree = d / "tree"
    if not (tree / "pipeline").exists():
        sys.exit(f"{d}: not a backtest side folder (no tree/pipeline)")
    os.environ["UNIT_DATA_DIR"] = str(tree / "unitdata")
    sys.path.insert(0, str(tree))
    return d


def unit_hours(d: Path, cheap_only: bool = False):
    """DataFrame, one row per thermal unit and hour on every as-of day with a 60-day answer:
    date, h (0-23), unit, tech, group, verdict, p (weight the dispatch model applied), exp (the
    committed minimum it held, MW), act (online LSL, MW), state (merged hourly state: m/a online,
    0 off, o outage, - no data), win (inside the unit's loss window, when the model gives one),
    hub (day-ahead hub price), cheap (hub at or below score.CHEAP_HUB)."""
    import numpy as np
    import pandas as pd
    cache = d / "unit_hours.pkl"
    if cache.exists():
        x = pd.read_pickle(cache)
        return x[x.cheap] if cheap_only else x
    from pipeline.config import DATA_DIR
    from pipeline.forecast import context as C
    from pipeline.forecast.score import CHEAP_HUB
    from pipeline.intraday import train_of
    from pipeline.models import peaker_share, thermal_cutoff, thermal_dispatch
    from pipeline.store import load_index, read_json_gz
    ctx = C.Context(load_index())
    sc = read_json_gz(DATA_DIR / "forecast" / "scores.json.gz", default={"days": {}})
    days = sorted(k for k, s in sc["days"].items() if s.get("asof") is not False and s.get("sixty_day"))
    raw, day0 = ctx.raw_states(), ctx.stats["day0"]
    rows = []
    for date in days:
        hub = ctx.hub(date)
        rf = read_json_gz(DATA_DIR / "60d-units" / f"{date}.json.gz")
        if hub is None or not rf:
            continue
        hub = np.asarray(hub, float)
        cols = {c: i + 2 for i, c in enumerate(rf["columns"])}
        act = {}
        for r in rf["rows"]:
            name, t = rf["units"][r[0]][0], rf["units"][r[0]][2]
            if t not in C.THERMAL:
                continue
            key = train_of(name) if t == "combined_cycle" else name
            a = act.setdefault(key, np.zeros(24))
            if (r[cols["online_share"]] or 0) >= 0.5:
                a[r[1] - 1] += r[cols["lsl"]] or 0
        commit = thermal_cutoff.forecast(date, ctx)
        peak = peaker_share.forecast(date, ctx)
        disp = thermal_dispatch.forecast(date, ctx, commit, peak)
        dn = (C._d(date) - day0).days
        for key, row in commit["rows"].items():
            dr = disp["rows"][key]
            st = raw.get(key)
            seg = st[1][dn * 24:(dn + 1) * 24] if st is not None and (dn + 1) * 24 <= len(st[1]) else np.array(["-"] * 24)
            win = np.zeros(24, bool)
            a0 = row.get("win_from") or row.get("off_from")
            nh = row.get("win_hours") or row.get("off_hours") or 0
            if a0 and nh:
                win[a0 - 1:a0 - 1 + nh] = True
            p, mn, ac = np.asarray(dr["p"], float), np.asarray(dr["min"], float), act.get(key, np.zeros(24))
            for h in range(24):
                rows.append((date, h, key, row["tech"], str(row["group"]), row["verdict"], float(p[h]), float(mn[h]),
                             float(ac[h]), seg[h], bool(win[h]), float(hub[h])))
    x = pd.DataFrame(rows, columns="date h unit tech group verdict p exp act state win hub".split())
    x["cheap"] = x.hub <= CHEAP_HUB
    x.to_pickle(cache)
    return x[x.cheap] if cheap_only else x


def args(doc: str, extra=None):
    """Parse `SIDE [options]` for a script whose docstring is `doc`."""
    import argparse
    ap = argparse.ArgumentParser(description=doc, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("side", help="backtest side folder, e.g. backtests/v1-vs-main/current")
    for a, kw in (extra or {}).items():
        ap.add_argument(a, **kw)
    return ap.parse_args()


def table(df, fmt="{:,.0f}") -> str:
    """A DataFrame as a markdown table (index included)."""
    cols = [df.index.name or "", *map(str, df.columns)]
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for k, r in df.iterrows():
        out.append("| " + " | ".join([str(k), *(v if isinstance(v, str) else f"{v:,.0f}" if float(v).is_integer() and abs(v) >= 10 else fmt.format(v) for v in r)]) + " |")
    return "\n".join(out)


def write(d: Path, name: str, text: str):
    (d / f"analysis-{name}.md").write_text(text)
    print(text)
