"""Batteries against a perfect battery: for every battery and day, what it earned and what a
battery of the same size would have earned knowing the day's real-time prices in advance.
Read by the Batteries page's across-days charts.  Needs no downloads: built from the battery
day files (pipeline/storage.py), the hourly real-time node prices in the series day caches
(pipeline/series.py, data branch series/) and the DAM day files' AS clearing prices.

The perfect battery, one linear program per battery and day (hourly):
  - the battery's own size: the day's HSL (discharge MW), |LSL| (charge MW), SOC min and max
  - the MW it actually held for ancillary services each hour (SCED as_up, as_dn) taken out of
    its discharge and charge limits, so both sides earn the same AS
  - its own round-trip efficiency, fitted from how its state of charge moves against its output
    over every day loaded (RTE_DEFAULT until it has MIN_RTE_HOURS of history), split evenly
    between charging and discharging
  - the day starts at the battery's actual state of charge in HE 1 and ends at least at its
    actual state of charge in HE 24, so it can't win by draining the battery
  - at most one full cycle of discharge a day ((SOC max - SOC min) x discharge efficiency):
    without a cap it chases every hourly swing and cycles several times what batteries do
  - prices: the hourly real-time price at the battery's settlement point
Actual energy revenue is two-settlement: DAM award x DA node price + (telemetered output -
award) x RT node price.  DAM AS revenue is each DAM AS award x the DAM MCPC.  Real-time AS
revenue is left out (small next to DAM AS: analysis/battery-perfect in the project notes).

data/storage/bench.json.gz
{
  "format", "dates",
  "fleet": {field: [day]}, null on days without batteries priced:
    n               batteries priced (state of charge, a node price and HSL >= MIN_HSL)
    mw, mwh         their summed HSL (MW) and SOC max - SOC min (MWh)
    actual          energy revenue, $ (two-settlement, above)
    dam_as          DAM AS revenue, $
    perfect         the perfect battery's energy revenue, $
    dis_mwh, dis_usd, chg_mwh, chg_usd     MWh discharged / charged and $ earned / paid at the
                    RT node price, from telemetered output
    p_dis_mwh, p_dis_usd, p_chg_mwh, p_chg_usd   the same for the perfect battery
}
data/storage/bench_units.json.gz   the same per battery, for the Unit page:
  {"format", "dates", "fields" (UNIT_FIELDS: FIELDS but n and mw), "units": {name: {field: [day]}}},
  whole numbers, null on days the battery was not priced
Per-day results are cached on the data branch under bench/, keyed on the sizes of the files
they came from and the efficiencies used.

  python -m pipeline.battery_bench          # build or refresh
"""
import collections
import os
import sys

import numpy as np

from .config import DATA_DIR, UNIT_DATA_DIR
from .store import read_json_gz, write_json_gz

FORMAT = 1
PATH = DATA_DIR / "storage" / "bench.json.gz"
CACHE = UNIT_DATA_DIR / "bench"
FIELDS = ["n", "mw", "mwh", "actual", "dam_as", "perfect", "dis_mwh", "dis_usd", "chg_mwh", "chg_usd",
          "p_dis_mwh", "p_dis_usd", "p_chg_mwh", "p_chg_usd"]
MIN_HSL = 5.0
RTE_DEFAULT, RTE_RANGE, MIN_RTE_HOURS = 0.86, (0.75, 0.95), 500
UNIT_FIELDS = [k for k in FIELDS if k not in ("n", "mw")]
UNITS_PATH = DATA_DIR / "storage" / "bench_units.json.gz"
N = 24


def _a(v):
    return np.array([np.nan if x is None else x for x in (v or [None] * N)][:N] + [np.nan] * (N - len(v or [])), float)


def fit_rte(dates) -> dict:
    """{battery: round-trip efficiency}: least squares of the hour-to-hour change in its state
    of charge on the MWh it charged and discharged between the two hours."""
    rows = collections.defaultdict(list)
    for d in dates:
        day = read_json_gz(DATA_DIR / "storage" / f"{d}.json.gz") or {}
        for name, u in (day.get("units") or {}).items():
            if not u.get("soc"):
                continue
            s, o = _a(u["soc"]), _a(u.get("out"))
            ds, m = s[1:] - s[:-1], (o[1:] + o[:-1]) / 2
            ok = np.isfinite(ds) & np.isfinite(m)
            if ok.any():
                rows[name].append(np.c_[ds[ok], np.maximum(-m[ok], 0), np.maximum(m[ok], 0)])
    out = {}
    for name, v in rows.items():
        v = np.vstack(v)
        if len(v) < MIN_RTE_HOURS:
            continue
        c = np.linalg.lstsq(v[:, 1:], v[:, 0], rcond=None)[0]
        if c[0] > 0 and c[1] < 0:
            out[name] = round(float(np.clip(c[0] / -c[1], *RTE_RANGE)), 2)
    return out


def perfect_day(p, dis_mw, chg_mw, smin, smax, s0, s_end, eta, dcap):
    """-> (revenue, hourly net MW) of the best schedule against prices p, or (nan, None)."""
    from scipy.optimize import linprog
    from scipy.sparse import lil_matrix
    p = np.nan_to_num(p)
    A = lil_matrix((N, 3 * N))     # c[0:24] charge, d[24:48] discharge, s[48:72] state of charge
    for h in range(N):
        A[h, 2 * N + h] = 1
        if h:
            A[h, 2 * N + h - 1] = -1
        A[h, h], A[h, N + h] = -eta, 1 / eta
    b = np.zeros(N)
    b[0] = s0
    bounds = ([(0, max(x, 0)) for x in chg_mw] + [(0, max(x, 0)) for x in dis_mw]
              + [(smin, smax)] * (N - 1) + [(min(s_end, smax), smax)])
    r = linprog(np.r_[p, -p, np.zeros(N)], A_eq=A.tocsr(), b_eq=b, bounds=bounds, method="highs",
                A_ub=np.r_[np.zeros(N), np.ones(N), np.zeros(N)][None, :], b_ub=[max(dcap, 0)])
    if r.status != 0:
        return float("nan"), None
    return -r.fun, r.x[N:2 * N] - r.x[:N]


def day_bench(date: str, rte: dict) -> tuple:
    """-> (fleet totals for one day (FIELDS), {battery: UNIT_FIELDS}); ({}, {}) when no battery
    could be priced."""
    st = read_json_gz(DATA_DIR / "storage" / f"{date}.json.gz") or {}
    rt = (read_json_gz(UNIT_DATA_DIR / "series" / f"{date}.json.gz") or {}).get("rt") or {}
    dam = read_json_gz(DATA_DIR / "dam" / f"{date}.json.gz") or {}
    mcpc = {k: _a(v) for k, v in (dam.get("mcpc") or {}).items()}
    tot = dict.fromkeys(FIELDS, 0.0)
    units = {}
    for name, u in (st.get("units") or {}).items():
        price = rt.get(u.get("sp"))
        if not u.get("soc") or not u.get("soc_max") or not price or (u.get("hsl") or 0) < MIN_HSL:
            continue
        p = _a(price)
        if np.isnan(p).all():
            continue
        e = rte.get(name, RTE_DEFAULT)
        eta = np.sqrt(e)
        smin, smax = u.get("soc_min") or 0.0, u["soc_max"]
        soc = _a(u["soc"])
        s0 = soc[0] if np.isfinite(soc[0]) else (smin + smax) / 2
        se = soc[-1] if np.isfinite(soc[-1]) else s0
        s0, se = float(np.clip(s0, smin, smax)), float(np.clip(se, smin, smax))
        up = np.clip(np.nan_to_num(_a(u.get("as_up"))), 0, None)     # a few early days carry negative sentinels
        dn = np.clip(np.nan_to_num(_a(u.get("as_dn"))), 0, None)
        dis_mw = np.maximum(u["hsl"] - up, 0)
        chg_mw = np.maximum(-min(u.get("lsl") or 0, 0) - dn, 0)
        rev, x = perfect_day(p, dis_mw, chg_mw, smin, smax, s0, se, eta, (smax - smin) * eta)
        if x is None:
            continue
        pz = np.nan_to_num(p)
        out, award, da = np.nan_to_num(_a(u.get("out"))), np.nan_to_num(_a(u.get("dam"))), np.nan_to_num(_a(u.get("spp")))
        r = {"n": 1, "mw": u["hsl"], "mwh": smax - smin,
             "actual": float((award * da + (out - award) * pz).sum()),
             "dam_as": float(sum((np.nan_to_num(_a(v)) * np.nan_to_num(mcpc[k])).sum()
                                 for k, v in (u.get("dam_as") or {}).items() if k in mcpc)),
             "perfect": rev}
        for pre, y in (("", out), ("p_", x)):
            dis, chg = np.clip(y, 0, None), -np.clip(y, None, 0)
            r[pre + "dis_mwh"], r[pre + "dis_usd"] = float(dis.sum()), float((dis * pz).sum())
            r[pre + "chg_mwh"], r[pre + "chg_usd"] = float(chg.sum()), float((chg * pz).sum())
        for k in FIELDS:
            tot[k] += r[k]
        units[name] = [round(r[k]) for k in UNIT_FIELDS]
    if not tot["n"]:
        return {}, {}
    return {k: round(v, 1) for k, v in tot.items()}, units


def _key(date: str, rte: dict) -> list:
    def size(p):
        return p.stat().st_size if p.exists() else 0
    st = read_json_gz(DATA_DIR / "storage" / f"{date}.json.gz") or {}
    names = sorted(st.get("units") or {})
    return [size(DATA_DIR / "storage" / f"{date}.json.gz"), size(UNIT_DATA_DIR / "series" / f"{date}.json.gz"),
            size(DATA_DIR / "dam" / f"{date}.json.gz"), [rte.get(n, RTE_DEFAULT) for n in names]]


def _fill(args):
    date, key, rte = args
    fleet, units = day_bench(date, rte)
    write_json_gz(CACHE / f"{date}.json.gz", {"date": date, "format": FORMAT, "key": key, "fleet": fleet, "units": units})


def build_battery_bench(index: dict) -> None:
    dates = sorted(index["days"].get("storage", []))
    if not dates:
        return
    rte = fit_rte(dates)
    keys = {d: _key(d, rte) for d in dates}

    def stale(d):
        c = read_json_gz(CACHE / f"{d}.json.gz")
        return not c or c.get("format") != FORMAT or c.get("key") != keys[d]

    todo = [d for d in dates if stale(d)]
    if todo:
        from concurrent.futures import ProcessPoolExecutor
        print(f"battery_bench: perfect battery for {len(todo)} day(s), {len(rte)} fitted efficiencies")
        with ProcessPoolExecutor(max_workers=os.cpu_count() or 2) as ex:
            list(ex.map(_fill, [(d, keys[d], rte) for d in todo]))
    fleet, units = {k: [] for k in FIELDS}, {}
    for i, d in enumerate(dates):
        c = read_json_gz(CACHE / f"{d}.json.gz") or {}
        f = c.get("fleet") or {}
        for k in FIELDS:
            fleet[k].append(f.get(k))
        for name, row in (c.get("units") or {}).items():
            u = units.setdefault(name, {k: [None] * len(dates) for k in UNIT_FIELDS})
            for k, v in zip(UNIT_FIELDS, row):
                u[k][i] = v
    write_json_gz(PATH, {"format": FORMAT, "dates": dates, "fleet": fleet})
    write_json_gz(UNITS_PATH, {"format": FORMAT, "dates": dates, "fields": UNIT_FIELDS, "units": dict(sorted(units.items()))})
    a = [x for x in fleet["actual"] if x is not None]
    p = [x for x in fleet["perfect"] if x is not None]
    print(f"battery_bench: {len(a)} of {len(dates)} days priced; energy ${sum(a) / 1e6:,.0f}M of a "
          f"perfect ${sum(p) / 1e6:,.0f}M ({sum(a) / sum(p):.0%})" if p and sum(p) else "battery_bench: no days priced")


if __name__ == "__main__":
    from .store import load_index
    build_battery_bench(load_index())
    sys.exit(0)
