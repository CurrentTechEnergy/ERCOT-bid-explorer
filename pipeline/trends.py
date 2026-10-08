"""Long-term trends from the 60-day data already in data/: daily statistics by technology,
daily system lambda, per-unit daily offer behaviour for thermal units, and detected
changes in each unit's bidding approach.  Needs no downloads.  Read by trends.html.

From the per-unit day files in UNIT_DATA_DIR (days without one are skipped / null):
  daily[tech]["starts"]  number of starts (status not starting "ON" -> starting "ON")
  units[i]["starts"]     the same per thermal unit and day
  flips                  thermal units whose submitted curve offered some MW at or below $0 in
                         some online runs and none in others on the same day:
                         [unit, tech, date, n_switches, first_switch "HH:MM", hours_le0]
"""
import numpy as np

from .config import DATA_DIR, SIXTY_DAY_TECHS, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz
from .units import le0_share

DAILY_STATS = ["n_online", "hsl", "lsl", "output", "floor_sced", "floor_submitted",
               "le0_submitted", "no_offer_hsl",
               "mw_on", "mw_onruc", "mw_off", "mw_out", "n_onruc", "n_off", "n_out"]
# daily key -> stat name in the 60-day summary, where they differ
STAT_OF = {"mw_on": "hsl", "mw_onruc": "hsl_onruc", "mw_off": "hsl_off", "mw_out": "hsl_out"}
# stat order of summaries written before they carried "stat_names"
LEGACY_STATS = ["n_online", "hsl", "lsl", "base_point", "output", "floor_sced", "floor_submitted",
                "le0_sced", "le0_submitted", "no_offer_hsl", "no_offer_output_schedule"]
FLIP_EPS = 0.005   # share of HSL at or below $0 that counts as offering there (rounding)
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


def _online(s):
    return bool(s) and s.startswith("ON")


def unit_day_facts(ud: dict, prev_last: dict):
    """From one per-unit day file: starts per unit, each unit's last known status, and flips.
    prev_last: {unit: status} at the end of the previous day (empty if that day is missing);
    a start in the first run of the day counts only when it is known."""
    n = len(ud["runs"])
    starts, last, flips = {}, {}, []
    for name, u in ud["units"].items():
        seq = [s for _, s in u["status"] if s is not None]
        cnt, prev = 0, prev_last.get(name)
        for s in seq:
            if prev is not None and not _online(prev) and _online(s):
                cnt += 1
            prev = s
        starts[name] = cnt
        if seq:
            last[name] = seq[-1]
        if u["tech"] not in UNIT_TECHS:
            continue
        share = le0_share(u, n)
        ok = ~np.isnan(share)
        if not (np.any(share[ok] > FLIP_EPS) and np.any(share[ok] <= FLIP_EPS)):
            continue
        state, n_sw, first_sw = None, 0, None
        for r in np.flatnonzero(ok):
            cur = "le0" if share[r] > FLIP_EPS else "gt0"
            if state is not None and cur != state:
                n_sw += 1
                if first_sw is None:
                    m = ud["runs"][r] % 1440
                    first_sw = f"{m // 60:02d}:{m % 60:02d}"
            state = cur
        hours = round(float(np.sum(share[ok] > FLIP_EPS)) * 24 / max(n, 1), 1)
        flips.append([name, u["tech"], ud["date"], n_sw, first_sw, hours])
    return starts, last, flips


def build_trends(index: dict) -> None:
    dates = sorted(index["days"].get("60d", []))
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={})
    summ = read_json_gz(DATA_DIR / "summary_60d.json.gz", default={})
    lam = [_mean((prices.get(d) or {}).get("lambda") or []) for d in dates]

    daily = {t: {k: [] for k in DAILY_STATS + ["partial_units", "starts"]} for t in SIXTY_DAY_TECHS}
    units = {}
    unit_starts, flips = {}, []    # unit -> {day index: starts}
    prev_date, prev_last = None, {}
    n_unit_days = 0
    for di, d in enumerate(dates):
        sd = summ.get(d) or {}
        st = sd.get("stats") or {}
        names = sd.get("stat_names") or LEGACY_STATS
        for t in SIXTY_DAY_TECHS:
            rows = [r for r in st.get(t, []) if r]
            for k in DAILY_STATS:
                name = STAT_OF.get(k, k)
                j = names.index(name) if name in names else None
                daily[t][k].append(None if j is None else _mean([r[j] if j < len(r) else None for r in rows]))

        ud = read_json_gz(UNIT_DATA_DIR / "60d" / f"{d}.json.gz")
        if ud:
            n_unit_days += 1
            known = prev_last if prev_date and np.datetime64(prev_date) + 1 == np.datetime64(d) else {}
            starts, prev_last, fl = unit_day_facts(ud, known)
            prev_date = d
            flips += fl
            for t in SIXTY_DAY_TECHS:
                daily[t]["starts"].append(sum(c for nm, c in starts.items() if ud["units"][nm]["tech"] == t))
            for nm, c in starts.items():
                unit_starts.setdefault(nm, {})[di] = c
        else:
            for t in SIXTY_DAY_TECHS:
                daily[t]["starts"].append(None)
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
                         "le0": arr(e["le0"]), "noff": arr(e["noff"]), "n_changes": len(ch),
                         "starts": arr(unit_starts.get(name, {}))})
        changes += [[name, e["tech"], dates[i], sig, b, a] for i, sig, b, a in ch]

    write_json_gz(DATA_DIR / "trends_60d.json.gz", {
        "dates": dates, "lambda": lam, "techs": SIXTY_DAY_TECHS, "daily": daily,
        "signals": {k: v["label"] for k, v in SIGNALS.items()}, "window": K, "units": unit_out,
        "changes": sorted(changes, key=lambda c: c[2]),
        "flips": sorted(flips, key=lambda f: (f[2], f[0])),
    })
    print(f"trends_60d: {D} days, {len(unit_out)} units, {len(changes)} bidding changes; "
          f"{n_unit_days} per-unit day file(s), {len(flips)} flips")
