"""Daily bidding trends read off the technology offer curves already in data/.

Writes data/curve_trends.json.gz for the Trends page:

  "rs":  wind and solar, share of offered MW in each price band, per day.
         Uses the 2-day curves where the day has them (they run closer to today),
         otherwise the 60-day curves as used in SCED. MW-weighted over the day's hours,
         so solar's night hours (nothing offered) drop out on their own.
         {"dates": [...], "src": ["2d"|"60d", ...], "bands": [...],
          "wind": {band: [share per day]}, "solar": {...}}
  "pq":  price at which 25%, 50% and 90% of each thermal technology's offered MW is
         available, from the submitted 60-day curves, averaged over the day's hours.
         {"dates": [...], "q": [0.25, 0.5, 0.9], tech: {"p25": [...], "p50": [...], "p90": [...]}}
  "curt": wind and solar curtailment: MW available (HSL, or HASL in the 2-day summary) minus
         the base point SCED sent, from two independent reports so each checks the other.
         {"dates": [...], tech: {"c60": [MWh per day], "a60": [available MWh], "c2d": [...], "a2d": [...]},
          "hours": {"columns": ["date", "hour", "lambda", "src", "wind", "solar", "wind_avail", "solar_avail"],
                    "rows": [...]}}   hourly MW, 2-day where the day has it, else 60-day

Needs no downloads, so it runs on every update.
"""
import numpy as np

from .config import DATA_DIR, PRICE_GRID
from .parse_2day_gen import find_col
from .store import read_json_gz, write_json_gz

G = np.asarray(PRICE_GRID, dtype=float)
# price bands for wind and solar offers. Production-tax-credit bids cluster between about
# −$60 and −$25, with little between −$25 and −$5, so −$20 separates them from shallow negatives.
BANDS = [
    ("floor", None, -249.0),     # −$250 / −$249.99
    ("ptc", -249.0, -20.0),      # below −$20: mostly tax-credit-driven
    ("neg", -20.0, -1.0),        # −$20 up to −$1
    ("zero", -1.0, 0.0),         # (−$1, $0]
    ("pos", 0.0, None),          # above $0
]
RS_TECHS = ["wind", "solar"]
PQ_TECHS = ["coal", "combined_cycle", "gas_steam", "combustion_turbine"]   # nuclear submits no curves
QS = [0.25, 0.5, 0.9]


def _idx(price):
    """Index of the last grid point at or below price."""
    return int(np.searchsorted(G, price, side="right")) - 1


def band_mw(rows) -> dict | None:
    """MW per band summed over the hours of one day, from [24][G] cumulative curves."""
    rows = [np.asarray(r, dtype=float) for r in (rows or []) if r]
    if not rows:
        return None
    tot = {b[0]: 0.0 for b in BANDS}
    for r in rows:
        r = np.nan_to_num(r)
        at = lambda p: r[_idx(p)] if _idx(p) >= 0 else 0.0
        top = r[-1]
        for name, lo, hi in BANDS:
            a = 0.0 if lo is None else at(lo)
            b = top if hi is None else at(hi)
            tot[name] += max(0.0, b - a)
    return tot


def price_at_share(rows, q) -> float | None:
    """Mean over hours of the lowest grid price where cumulative MW reaches q of the total."""
    out = []
    for r in rows or []:
        if not r:
            continue
        r = np.nan_to_num(np.asarray(r, dtype=float))
        if r[-1] <= 1:
            continue
        i = int(np.argmax(r >= q * r[-1]))
        out.append(G[i])
    return round(float(np.mean(out)), 2) if out else None


def build_curve_trends(index: dict) -> None:
    d2 = set(index["days"].get("2d", []))
    d60 = set(index["days"].get("60d", []))

    rs_dates = sorted(d2 | d60)
    rs = {"dates": [], "src": [], "bands": [b[0] for b in BANDS], **{t: {b[0]: [] for b in BANDS} for t in RS_TECHS}}
    for d in rs_dates:
        src = "2d" if d in d2 else "60d"
        day = read_json_gz(DATA_DIR / src / f"{d}.json.gz") or {}
        curves = day.get("curves") or {}
        rs["dates"].append(d)
        rs["src"].append(src)
        for t in RS_TECHS:
            mw = band_mw(curves.get(t))
            tot = sum(mw.values()) if mw else 0
            for name, *_ in BANDS:
                rs[t][name].append(round(mw[name] / tot, 4) if tot > 0 else None)

    pq_dates = sorted(d60)
    pq = {"dates": pq_dates, "q": QS, **{t: {f"p{int(q * 100)}": [] for q in QS} for t in PQ_TECHS}}
    for d in pq_dates:
        day = read_json_gz(DATA_DIR / "60d" / f"{d}.json.gz") or {}
        sub = day.get("submitted") or {}
        for t in PQ_TECHS:
            for q in QS:
                pq[t][f"p{int(q * 100)}"].append(price_at_share(sub.get(t), q))

    curt = build_curtailment(index)
    write_json_gz(DATA_DIR / "curve_trends.json.gz", {"rs": rs, "pq": pq, "curt": curt})
    print(f"curve_trends: {len(rs_dates)} days of wind/solar bands, {len(pq_dates)} days of price quantiles, "
          f"{len(curt['dates'])} days of curtailment")


CURT_TECHS = {"wind": "wgr", "solar": "pvgr"}


def hourly_60d(day: dict, tech: str):
    """(available MW, base point MW) per hour from a 60-day day file's technology stats."""
    names = day.get("stat_names") or []
    st = (day.get("stats") or {}).get(tech)
    if not st or "hsl" not in names or "base_point" not in names:
        return None
    hi, bi = names.index("hsl"), names.index("base_point")
    return [(r[hi], r[bi]) if r else (None, None) for r in st]


def hourly_2dgen(hourly: dict, tech: str):
    cols = list(hourly)
    a = find_col(cols, "hasl", CURT_TECHS[tech]) or find_col(cols, "hsl", CURT_TECHS[tech])
    b = find_col(cols, "base", "point", CURT_TECHS[tech])
    if not a or not b:
        return None
    return list(zip(hourly[a], hourly[b]))


def build_curtailment(index: dict) -> dict:
    d60 = sorted(index["days"].get("60d", []))
    g2 = read_json_gz(DATA_DIR / "summary_2dgen.json.gz", default={}) or {}
    dates = sorted(set(d60) | set(g2))
    out = {"dates": dates, **{t: {"c60": [], "a60": [], "c2d": [], "a2d": []} for t in CURT_TECHS}}
    rows = []

    def daily(h):
        pairs = [(a, b) for a, b in (h or []) if a is not None and b is not None]
        if not h or len(pairs) < 20:
            return None, None
        return round(sum(max(0.0, a - b) for a, b in pairs)), round(sum(a for a, _ in pairs))

    for d in dates:
        day60 = read_json_gz(DATA_DIR / "60d" / f"{d}.json.gz") if d in d60 else None
        gen = (g2.get(d) or {}).get("hourly")
        hours = {}
        for t in CURT_TECHS:
            h60 = hourly_60d(day60, t) if day60 else None
            h2 = hourly_2dgen(gen, t) if gen else None
            c, a = daily(h60)
            out[t]["c60"].append(c); out[t]["a60"].append(a)
            c, a = daily(h2)
            out[t]["c2d"].append(c); out[t]["a2d"].append(a)
            hours[t] = ("2d", h2) if h2 else ("60d", h60) if h60 else (None, None)
        prices = read_json_gz(DATA_DIR / "prices" / f"{d}.json.gz")
        lam = (prices or {}).get("lambda", {}).get("hourly_mean") or [None] * 24
        src = hours["wind"][0] or hours["solar"][0]
        if not src:
            continue
        for hr in range(24):
            vals = []
            for t in CURT_TECHS:
                s_, h = hours[t]
                a, b = h[hr] if h and hr < len(h) else (None, None)
                vals.append((None if a is None or b is None else round(max(0.0, a - b)), a))
            if lam[hr] is None or all(v[0] is None for v in vals):
                continue
            rows.append([d, hr, round(lam[hr], 2), src, vals[0][0], vals[1][0],
                         None if vals[0][1] is None else round(vals[0][1]),
                         None if vals[1][1] is None else round(vals[1][1])])
    out["hours"] = {"columns": ["date", "hour", "lambda", "src", "wind", "solar", "wind_avail", "solar_avail"], "rows": rows}
    return out
