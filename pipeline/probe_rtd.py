"""Branch-only backtest (not for merge): do ERCOT's RTD indicative LMPs help the operator-informed
peaker (CT) model?  Reads the day zips pipeline/raw_days.py kept in the raw store (no ERCOT
request), cuts each run to the CTs' resource nodes, and for each hour ending h takes the runs
posted in the hour before h starts: the latest run's mean and highest indicative LMP over the
intervals inside h, and the highest any of those runs forecast for h.  Then fits the switch
models of analysis/peaker-oi/peaker_oi.py with and without them, Apr-Aug 2026, each month fitted
on every earlier day from Mar 1, and writes the table to stdout and the run summary.

  python -m pipeline.probe_rtd
"""
import datetime as dt
import gzip
import io
import json
import os
import sys

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .models import peaker_rt as PR
from .raw_store import RawStore
from .store import iter_csvs

EMIL = "np6-970-cd"
FIRST, LAST = dt.date(2026, 2, 28), dt.date(2026, 8, 31)
MONTHS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
lines = []


def say(s=""):
    print(s, flush=True)
    lines.append(s)


def _col(cols, *keys):
    low = {c.lower().replace("_", "").replace(" ", ""): c for c in cols}
    for k in keys:
        for lc, c in low.items():
            if k in lc:
                return c
    return None


def rtd_features(sps):
    """{sp: {(date, he): (latest mean, latest max, any max)}}"""
    raw = RawStore()
    acc = {}          # (sp, date, he) -> [latest t, latest mean, latest max, any max]
    shown = False
    d = FIRST
    while d <= LAST:
        blob = raw.get(EMIL, f"day-{d.isoformat()}")
        if blob is None:
            say(f"- {d}: no day zip in the store")
            d += dt.timedelta(days=1)
            continue
        frames = []
        for name, b in iter_csvs(blob, "x.zip"):
            f = pd.read_csv(io.BytesIO(b))
            if not shown:
                say(f"columns: {list(f.columns)}")
                say(f"first row: {f.iloc[0].to_dict()}")
                shown = True
            ts, ie = _col(f.columns, "rtdtimestamp", "timestamp"), _col(f.columns, "intervalending")
            spc, lmp = _col(f.columns, "settlementpoint"), _col(f.columns, "lmp")
            if None in (ts, ie, spc, lmp):
                say(f"columns not recognised: {list(f.columns)}")
                sys.exit(1)
            f = f[f[spc].isin(sps)]
            if len(f):
                frames.append(pd.DataFrame({"t": f[ts].values, "e": f[ie].values, "sp": f[spc].values, "p": f[lmp].values}))
        if frames:
            g = pd.concat(frames, ignore_index=True)
            g["t"], g["e"] = pd.to_datetime(g["t"]), pd.to_datetime(g["e"])
            start = (g["e"] - pd.Timedelta(seconds=1)).dt.floor("h")         # start of the hour the interval falls in
            g = g[(g["t"] < start) & (g["t"] >= start - pd.Timedelta(hours=1))]
            g["date"] = start.loc[g.index].dt.strftime("%Y-%m-%d")
            g["he"] = start.loc[g.index].dt.hour + 1
            anymax = g.groupby(["sp", "date", "he"])["p"].max()
            last_t = g.groupby(["sp", "date", "he"])["t"].transform("max")
            L = g[g["t"] == last_t].groupby(["sp", "date", "he"]).agg(t=("t", "max"), mean=("p", "mean"), mx=("p", "max"))
            for (s, dd, he), r in L.iterrows():
                k = (s, dd, int(he))
                cur = acc.get(k)
                am = float(anymax.loc[(s, dd, he)])
                if cur is None or r["t"] >= cur[0]:
                    acc[k] = [r["t"], float(r["mean"]), float(r["mx"]), max(am, cur[3]) if cur else am]
                else:
                    cur[3] = max(cur[3], am)
        if d.day == 1:
            say(f"- {d}: {len(acc)} sp-hours so far")
        d += dt.timedelta(days=1)
    out = {}
    for (s, dd, he), v in acc.items():
        out.setdefault(s, {})[(dd, he)] = (v[1], v[2], v[3])
    return out


def main():
    uh = json.load(gzip.open(DATA_DIR / "unit_hours_60d.json.gz"))
    tr = json.load(gzip.open(DATA_DIR / "trends_60d.json.gz"))
    ui = json.load(gzip.open(DATA_DIR / "unit_index.json.gz"))
    ic = ui["columns"]
    sp_of = {r[ic.index("unit")]: r[ic.index("sp")] for r in ui["rows"]}
    lamd = json.load(gzip.open(DATA_DIR / "dam_lambda.json.gz"))["days"]
    dates = uh["dates"]
    N = len(dates)
    cts = [u["unit"] for u in tr["units"] if u["tech"] == "combustion_turbine" and u["unit"] in uh["units"]]
    rt = PR.node_prices(dates, cts)
    cts = [u for u in cts if u in rt and sp_of.get(u)]
    say(f"{len(cts)} CTs with a node and RT prices")
    F = rtd_features({sp_of[u] for u in cts})
    say(f"RTD features for {len(F)} nodes")

    ON_ST = {"ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR"}
    A = lambda x: np.arcsinh(np.asarray(x, float) / 10.0)
    ang = 2 * np.pi * np.arange(24) / 24
    HARM = np.c_[np.sin(ang), np.cos(ang), np.sin(2 * ang), np.cos(2 * ang)]
    U = {u: i for i, u in enumerate(cts)}
    feats = {k: [] for k in ("da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rt1", "rt3", "rtd1",
                             "rtd_mean", "rtd_max", "rtd_any")}
    meta = []
    dam = {}
    for i, d in enumerate(dates):
        p = DATA_DIR / "dam" / f"{d}.json.gz"
        if d >= "2026-02-01" and p.exists():
            dam[i] = json.load(gzip.open(p))["units"]
    for u in cts:
        s = np.array(list(uh["units"][u][:N * 24].ljust(N * 24, "-")))
        P = rt[u].ravel()
        Fu = F.get(sp_of[u], {})
        for i, du in dam.items():
            d = dates[i]
            e = du.get(u)
            if not e or len(e.get("spp") or []) < 24 or None in e["spp"][:24]:
                continue
            DA = np.array(e["spp"][:24], float)
            aw = np.array([(x or 0) > 0 for x in (e.get("award") or [0] * 24)[:24]] + [False] * 24)[:24]
            st = str(e.get("status") or "").upper()
            lam = lamd.get(d) or [None] * 24
            for h in range(24):
                k = i * 24 + h
                if k < 3 or s[k - 1] not in "ma0" or s[k] not in "ma0" or np.isnan(P[k - 3:k]).any():
                    continue
                r = Fu.get((d, h + 1))
                if r is None:
                    continue
                prev = s[k - 1] in "ma"
                run = 0
                while k - 1 - run >= 0 and run < 48 and s[k - 1 - run] in "ma0" and (s[k - 1 - run] in "ma") == prev:
                    run += 1
                da1 = DA[h - 1] if h else DA[0]
                for name, v in (("da", A(DA[h])), ("dmax", A(DA[h:h + 4].max())), ("aw", float(aw[h])),
                                ("awa", aw[h:h + 4].mean()), ("st_on", float(st in ON_ST)), ("st_qs", float(st == "OFFQS")),
                                ("lam", A(lam[h]) if lam[h] is not None else 0.0), ("rt1", A(P[k - 1])),
                                ("rt3", A(P[k - 3:k].max())), ("rtd1", A(P[k - 1] - da1)),
                                ("rtd_mean", A(r[0])), ("rtd_max", A(r[1])), ("rtd_any", A(r[2]))):
                    feats[name].append(v)
                meta.append((U[u], i, h, int(prev), int(s[k] in "ma"), np.log1p(run) / 4.0, d[:7]))
    R = {k: np.array(v, float) for k, v in feats.items()}
    ui_, di, hi, prev, on, runf = (np.array([m[j] for m in meta]) for j in range(6))
    ui_, di, hi, prev, on = ui_.astype(int), di.astype(int), hi.astype(int), prev.astype(int), on.astype(int)
    mon = np.array([m[6] for m in meta])
    say(f"{len(meta)} unit-hours with RTD features")
    nU = len(cts)
    MODELS = {
        "day-ahead + last hour's RT": ["da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rt1", "rt3", "rtd1"],
        "day-ahead + RTD indicative": ["da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rtd_mean", "rtd_max", "rtd_any"],
        "day-ahead + last hour's RT + RTD": ["da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rt1", "rt3", "rtd1",
                                             "rtd_mean", "rtd_max", "rtd_any"],
    }

    def design(fs, sel):
        X = np.c_[tuple([np.ones(sel.sum())] + [R[f][sel] for f in fs] + [HARM[hi[sel]][:, j] for j in range(4)] + [runf[sel]])]
        oh = np.zeros((sel.sum(), nU))
        oh[np.arange(sel.sum()), ui_[sel]] = 1.0
        return np.c_[X, oh], X.shape[1]

    def fit(X, y, w, nfix):
        b = np.zeros(X.shape[1])
        Rg = np.diag([1e-6] + [1.0] * (X.shape[1] - 1))
        for _ in range(25):
            p = 1 / (1 + np.exp(-np.clip(X @ b, -30, 30)))
            step = np.linalg.solve((X.T * (w * p * (1 - p) + 1e-9)) @ X + Rg, X.T @ (w * (y - p)) - Rg @ b)
            b += step
            if np.abs(step).max() < 1e-6:
                break
        return b

    first = {m: int(np.min(di[mon == m])) for m in MONTHS if (mon == m).any()}
    say("")
    say("| Model | Starts caught | False starts | Stops caught | False stops | Brier, from offline | Brier, from online |")
    say("| --- | --- | --- | --- | --- | --- | --- |")
    for name, fs in MODELS.items():
        pred = np.full(len(meta), np.nan)
        for m, f0 in first.items():
            test, train = mon == m, di < f0
            w_all = 0.5 ** ((f0 - di) / 30.0)
            for side in (0, 1):
                trs, tes = train & (prev == side), test & (prev == side)
                X, nfix = design(fs, trs)
                w = w_all[trs] / w_all[trs].mean()
                b = fit(X, (on[trs] != side).astype(float), w, nfix)
                pred[tes] = 1 / (1 + np.exp(-design(fs, tes)[0] @ b))
        ok = ~np.isnan(pred)
        p, pv, nx = pred[ok], prev[ok], on[ok]
        sw, call = nx != pv, p >= 0.5
        st, sp = pv == 0, pv == 1
        say(f"| {name} | {int((sw & st & call).sum())} of {int((sw & st).sum())} | {int((~sw & st & call).sum())} | "
            f"{int((sw & sp & call).sum())} of {int((sw & sp).sum())} | {int((~sw & sp & call).sum())} | "
            f"{np.mean((p[st] - sw[st]) ** 2):.4f} | {np.mean((p[sp] - sw[sp]) ** 2):.4f} |")
    out = os.environ.get("GITHUB_STEP_SUMMARY")
    if out:
        with open(out, "a") as f:
            f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
