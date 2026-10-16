"""Expected dispatch stack: for each hour of a forecast day, the MW the committed thermal set
offers at or below each price, with the committed set held fixed for the day.  Read by the
Beyond baseload page; the page draws it and computes nothing.

The same units, weights and curves as the dispatch model (pipeline.models.thermal_dispatch),
met by a price grid instead of the node price.  For a unit with weight p[h] (p_on, zero inside
its off window):

  mw(P, h) = p[h] x clamp(curve(P), LSL, HSL)     a unit with an offer curve (MW offered
                                                  below P; the floor is the LSL of the
                                                  curve snapshot's configuration, which for
                                                  a combined-cycle train is often above the
                                                  day-ahead LSL the forecast's `min` uses)
           = exp[h]                               a unit without one (runs at its median
                                                  output whatever the price)
           = p[h] x HSL                           nuclear

so at the bottom of the grid the stack is the committed minimum as the dispatch model sees it
(at least the forecast file's hourly `min`), and at the top it is the committed maximum.  Every unit faces the same price here, so where the stack meets the hub
price is close to, not equal to, the forecast's expected output (that uses each node's price).

data/forecast/stack/<date>.json.gz
  date, format, models {thermal_cutoff, peaker_share, thermal_dispatch: version}
  prices        the price grid ($/MWh)
  hub           day-ahead hub average by hour [24] (null when there is none)
  groups, techs the keys below, in display order
  group[g] / tech[t]: {mw: [24][len(prices)], min: [24], max: [24], n: units with p > 0}
  fleet         {mw, min, max} for all committed thermal units
"""
import numpy as np

from ..config import DATA_DIR
from ..models import versions
from ..models.thermal_dispatch import _config_curve
from ..store import write_json_gz
from . import context as C

OUT_DIR = DATA_DIR / "forecast" / "stack"
FORMAT = 1
PRICES = np.concatenate([
    [-250, -100, -75, -50, -40, -30, -25, -20, -15, -10, -5],
    np.arange(0, 100, 2.5),
    np.arange(100, 200, 10),
    [200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000],
]).astype(float)


def _unit_curve(ctx, month, u, hsl, lsl):
    """[len(PRICES)] MW of a unit's offer curve at each grid price, clamped to its DAM limits
    and scaled the way the dispatch model scales a combined-cycle train; None without a curve."""
    c = _config_curve(ctx, month, u)
    if not c:
        return None
    chsl = c["hsl"] if c.get("hsl") else hsl
    clsl = c["lsl"] if c.get("lsl") is not None else lsl
    scale = hsl / chsl if (len(u["configs"]) > 1 and chsl and hsl and abs(hsl - chsl) > 1) else 1.0
    cmw = (np.asarray(c["mw"], float) * scale).tolist()
    # a cent below each grid price: the MW offered strictly below it.  curve_mw itself, met exactly
    # at a breakpoint that ends a sloped segment, returns the segment's start, so the stack would
    # dip at round prices such as $50 and $100.
    v = np.array([C.curve_mw(c["p"], cmw, float(P) - 0.01, min(clsl * scale, chsl * scale), chsl * scale)
                  for P in PRICES])
    return np.clip(v, lsl, hsl) if hsl > 0 else v


def build(date, ctx: C.Context, commit: dict, disp: dict, groups: list) -> dict:
    """The stack for one day from the commitment and dispatch model outputs of build_day."""
    units = ctx.units(date)
    month, _ = ctx.curve_month(date)
    nP = len(PRICES)

    def blank():
        return {"mw": np.zeros((24, nP)), "min": np.zeros(24), "max": np.zeros(24), "n": 0}
    by_g = {g: blank() for g in groups}
    by_t = {t: blank() for t in C.THERMAL}
    fleet = blank()
    for key, row in commit["rows"].items():
        d = disp["rows"][key]
        p = np.asarray(d["p"], float)
        if not (p > 0).any():
            continue
        u = units[key]
        hsl, lsl = float(u["hsl"] or 0.0), float(u["lsl"] or 0.0)
        if row["tech"] == "nuclear":
            mw = np.outer(p * hsl, np.ones(nP))
        else:
            cv = _unit_curve(ctx, month, u, hsl, lsl) if d["curve"] else None
            if cv is not None:
                mw = np.outer(p, cv)
            else:
                mw = np.outer(np.asarray(d["exp"], float), np.ones(nP))
        g = "never" if row["tech"] == "nuclear" else (row["group"] or "ungrouped")
        for agg in (by_g.get(g), by_t[row["tech"]], fleet):
            if agg is None:
                continue
            agg["mw"] += mw; agg["min"] += mw[:, 0]; agg["max"] += mw[:, -1]; agg["n"] += 1
    hub = ctx.hub(date)
    v = versions()

    def out(a):
        return {"mw": np.round(a["mw"], 1).tolist(), "min": np.round(a["min"], 1).tolist(),
                "max": np.round(a["max"], 1).tolist(), "n": a["n"]}
    return {
        "date": date, "format": FORMAT,
        "models": {k: v[k] for k in ("thermal_cutoff", "peaker_share", "thermal_dispatch")},
        "prices": PRICES.tolist(),
        "hub": np.round(hub, 2).tolist() if hub is not None else None,
        "groups": groups, "techs": list(C.THERMAL),
        "group": {g: out(a) for g, a in by_g.items()},
        "tech": {t: out(a) for t, a in by_t.items()},
        "fleet": out(fleet),
    }


def write(date, stack: dict):
    write_json_gz(OUT_DIR / f"{date}.json.gz", stack)


def main(argv=None):
    """Write only the stack files (python -m pipeline.forecast.stack [--days START END]), leaving the
    forecast files as they are; the regular build (pipeline.forecast) writes both."""
    import argparse
    from ..store import load_index
    from .build import GROUPS, forecast_days
    from ..models import MODELS
    ap = argparse.ArgumentParser(description=main.__doc__)
    ap.add_argument("--days", nargs=2, metavar=("START", "END"))
    args = ap.parse_args(argv)
    ctx = C.Context(load_index())
    days = [d for d in forecast_days(ctx) if args.days is None or args.days[0] <= d <= args.days[1]]
    for d in days:
        commit = MODELS["thermal_cutoff"].forecast(d, ctx)
        peak = MODELS["peaker_share"].forecast(d, ctx)
        disp = MODELS["thermal_dispatch"].forecast(d, ctx, commit, peak)
        write(d, build(d, ctx, commit, disp, GROUPS))
    print(f"stack: {len(days)} day(s) written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
