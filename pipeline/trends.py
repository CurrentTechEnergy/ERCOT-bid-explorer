"""Long-term trends from the 60-day data already in data/: daily statistics by technology,
daily system lambda, per-unit daily offer behaviour for thermal units, and detected
changes in each unit's bidding approach.  Needs no downloads.  Read by trends.html.
"""
import numpy as np

from .config import DATA_DIR, SIXTY_DAY_TECHS
from .store import read_json_gz, write_json_gz

DAILY_STATS = ["n_online", "hsl", "lsl", "output", "floor_sced", "floor_submitted",
               "le0_submitted", "no_offer_hsl"]
UNIT_TECHS = ["nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine"]

# Bidding-approach changes. Each signal is compared between the K online days before and
# after a day; a change is a sustained shift larger than its threshold.
K = 7
SIGNALS = {
    # share of available MW the unit itself offered at or below $0 (price-taking)
    "le0": {"thr": 0.25, "label": "MW offered at or below $0"},
    # share of the day with no submitted offer (running on an output schedule)
    "noff": {"thr": 0.5, "label": "Running without an offer curve"},
    # first offer price minus that day's median for the technology: removes fuel-price moves
    "rel": {"thr": 10.0, "label": "Offer price vs technology median"},
}


def detect_changes(series):
    """series: {signal: [value or None per day]} for one unit. Returns
    [(day index, signal, before median, after median)], strongest first within K days."""
    days = sorted({i for v in series.values() for i, x in enumerate(v) if x is not None})
    found = []
    for sig, spec in SIGNALS.items():
        v = series[sig]
        idx = [i for i in days if v[i] is not None]
        best = []
        for n in range(K, len(idx) - K + 1):
            before = np.median([v[i] for i in idx[n - K:n]])
            after = np.median([v[i] for i in idx[n:n + K]])
            if abs(after - before) >= spec["thr"]:
                best.append((abs(after - before), idx[n], before, after))
        # keep the strongest point of each run of candidate days, at least K online days apart
        taken = []
        for score, i, b, a in sorted(best, reverse=True):
            if all(abs(days.index(i) - days.index(j)) >= K for j, *_ in taken):
                taken.append((i, b, a))
        found += [(i, sig, round(float(b), 3), round(float(a), 3)) for i, b, a in taken]
    return sorted(found)


def _mean(vals):
    v = [x for x in vals if x is not None]
    return round(float(np.mean(v)), 1) if v else None


def build_trends(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    summ = read_json_gz(DATA_DIR / "summary_60d.json.gz", default={})
    lam = [_mean((prices.get(d) or {}).get("lambda") or []) for d in dates]

    daily = {t: {k: [] for k in DAILY_STATS + ["partial_units"]} for t in SIXTY_DAY_TECHS}
    units = {}
    for di, d in enumerate(dates):
        st = (summ.get(d) or {}).get("stats") or {}
        for t in SIXTY_DAY_TECHS:
            rows = [r for r in st.get(t, []) if r]
            for k in DAILY_STATS:
                j = ["n_online", "hsl", "lsl", "base_point", "output", "floor_sced", "floor_submitted",
                     "le0_sced", "le0_submitted", "no_offer_hsl", "no_offer_output_schedule"].index(k)
                daily[t][k].append(_mean([r[j] for r in rows]))
        day = read_json_gz(DATA_DIR / "60d" / f"{d}.json.gz") or {}
        u = day.get("units") or {"columns": [], "rows": []}
        C = {c: i for i, c in enumerate(u["columns"])}
        partial = {t: 0 for t in SIXTY_DAY_TECHS}
        for r in u["rows"]:
            tech, hrs = r[C["tech"]], r[C["hours_online"]] or 0
            if 1 <= hrs <= 22:
                partial[tech] = partial.get(tech, 0) + 1
            if tech not in UNIT_TECHS:
                continue
            e = units.setdefault(r[C["unit"]], {"tech": tech, "type": r[C["type"]], "hours": {}, "first": {},
                                                 "floor": {}, "le0": {}, "noff": {}})
            hsl = r[C["hsl"]] or 0
            e["hours"][di] = hrs
            e["first"][di] = r[C["avg_sub_price"]]
            e["noff"][di] = r[C["no_offer_share"]]
            e["floor"][di] = round(r[C["floor_mw"]] / hsl, 3) if hsl > 1 else None
            e["le0"][di] = round(r[C["le0_submitted"]] / hsl, 3) if hsl > 1 else None
        for t in SIXTY_DAY_TECHS:
            daily[t]["partial_units"].append(partial[t] if u["rows"] else None)

    D = len(dates)
    # a day with no thermal unit online is a gap in the disclosure, not a real day
    for i in range(D):
        if not sum(daily[t]["n_online"][i] or 0 for t in UNIT_TECHS):
            for t in SIXTY_DAY_TECHS:
                for k in daily[t]:
                    daily[t][k][i] = None
    # that day's median first-offer price per technology, over units with an offer
    med = {}
    for t in UNIT_TECHS:
        for i in range(D):
            p = [e["first"][i] for e in units.values() if e["tech"] == t and e["first"].get(i) is not None]
            med[(t, i)] = float(np.median(p)) if p else None
    unit_out, changes = [], []
    for name, e in sorted(units.items()):
        arr = lambda m: [m.get(i) for i in range(D)]
        rel = [None if e["first"].get(i) is None or med[(e["tech"], i)] is None
               else round(e["first"][i] - med[(e["tech"], i)], 1) for i in range(D)]
        ch = detect_changes({"le0": arr(e["le0"]), "noff": arr(e["noff"]), "rel": rel})
        unit_out.append({"unit": name, "tech": e["tech"], "type": e["type"],
                         "hours": [e["hours"].get(i, 0) for i in range(D)],
                         "first": arr(e["first"]), "rel": rel, "floor": arr(e["floor"]),
                         "le0": arr(e["le0"]), "noff": arr(e["noff"]), "n_changes": len(ch)})
        changes += [[name, e["tech"], dates[i], sig, b, a] for i, sig, b, a in ch]

    write_json_gz(DATA_DIR / "trends_60d.json.gz", {
        "dates": dates, "lambda": lam, "techs": SIXTY_DAY_TECHS, "daily": daily,
        "signals": {k: v["label"] for k, v in SIGNALS.items()}, "window": K, "units": unit_out,
        "changes": sorted(changes, key=lambda c: c[2]),
    })
    print(f"trends_60d: {D} days, {len(unit_out)} units, {len(changes)} bidding changes")
