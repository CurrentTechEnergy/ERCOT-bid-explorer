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

Needs no downloads, so it runs on every update.
"""
import numpy as np

from .config import DATA_DIR, PRICE_GRID
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

    write_json_gz(DATA_DIR / "curve_trends.json.gz", {"rs": rs, "pq": pq})
    print(f"curve_trends: {len(rs_dates)} days of wind/solar bands, {len(pq_dates)} days of price quantiles")
