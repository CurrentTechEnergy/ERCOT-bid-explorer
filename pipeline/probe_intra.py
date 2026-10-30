"""Branch-only backtest (not for merge): do ERCOT's intra-hour wind, solar and load forecasts
(5-minute runs, stored by pipeline/raw_days.py) help the operator-informed peaker (CT) model?
Reads the day zips from the raw store (no ERCOT request).  For each hour ending h: the latest run
posted in the hour before h starts, its mean system forecast over the intervals inside h (wind and
solar SYSTEM_TOTAL or the sum of in-use regions, load SystemTotal, in-use model only), and its
revision against the day-ahead hourly forecast for h (the hourly files from git history, passed as
RENEW and LOAD).  Then fits the switch models of probe_rtd with and without them, May-Aug 2026,
each month fitted on every earlier day from Mar 26 (the first stored day).  Hours in RUC, and the
hour just after one, are left out of both fit and score.

  RENEW=... LOAD=... python -m pipeline.probe_intra
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

FIRST, LAST = dt.date(2026, 3, 25), dt.date(2026, 8, 31)
MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08"]
lines = []


def say(s=""):
    print(s, flush=True)
    lines.append(s)


def _system(f, emil):
    f = f[f["InUseFlag"].astype(str).str.upper() == "Y"]
    if emil == "np3-562-cd":
        return f.groupby("IntervalEnding")["SystemTotal"].mean()
    tot = f[f["Region"].astype(str).str.upper().str.startswith("SYSTEM")]
    if len(tot):
        return tot.groupby("IntervalEnding")["Value"].mean()
    return f.groupby("IntervalEnding")["Value"].sum()


def intra_features():
    """{(date, he): {'load': MW, 'wind': MW, 'solar': MW}} from the latest run posted in the hour
    before the hour starts."""
    raw = RawStore()
    out = {}
    for emil, key in (("np3-562-cd", "load"), ("np4-751-cd", "wind"), ("np4-752-cd", "solar")):
        best = {}     # (date, he) -> (posted, value)
        d = FIRST
        while d <= LAST:
            blob = raw.get(emil, f"day-{d.isoformat()}")
            if blob is None:
                say(f"- {emil} {d}: no day zip in the store")
                d += dt.timedelta(days=1)
                continue
            for name, b in iter_csvs(blob, "x.zip"):
                parts = os.path.basename(name).split(".")
                try:
                    posted = dt.datetime.strptime(parts[3] + parts[4], "%Y%m%d%H%M%S")
                except (IndexError, ValueError):
                    continue
                s = _system(pd.read_csv(io.BytesIO(b)), emil)
                if not len(s):
                    continue
                e = pd.to_datetime(pd.Series(s.index), format="%m/%d/%Y %H:%M")
                start = (e - pd.Timedelta(seconds=1)).dt.floor("h")
                hs = posted.replace(minute=0, second=0) + dt.timedelta(hours=1)   # the next hour to start
                m = (start == hs).values
                if m.sum() < 6:
                    continue
                k = (hs.strftime("%Y-%m-%d"), hs.hour + 1)
                v = float(np.asarray(s.values)[m].mean())
                if k not in best or posted > best[k][0]:
                    best[k] = (posted, v)
            if d.day == 1:
                say(f"- {emil} {d}: {len(best)} hours so far")
            d += dt.timedelta(days=1)
        for k, (_, v) in best.items():
            out.setdefault(k, {})[key] = v
    return {k: v for k, v in out.items() if len(v) == 3}


def _arr(v):
    return np.array([np.nan if x is None else x for x in v[:24]], float) if v and len(v) >= 24 else np.full(24, np.nan)


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
    F = intra_features()
    say(f"intra-hour forecasts for {len(F)} hours")
    RF = json.load(gzip.open(os.environ["RENEW"]))["days"]
    LD = json.load(gzip.open(os.environ["LOAD"]))["days"]
    DAF, ERR = {}, {}       # (date, he) -> day-ahead hourly forecast; realised error (actual - forecast)
    for d in dates:
        r, l = RF.get(d) or {}, LD.get(d) or {}
        lf, la = _arr(l.get("fc")), _arr(l.get("actual"))
        wf, wa, sf, sa = _arr(r.get("wind")), _arr(r.get("wind_actual")), _arr(r.get("solar")), _arr(r.get("solar_actual"))
        for h in range(24):
            DAF[(d, h + 1)] = (lf[h], wf[h], sf[h])
            ERR[(d, h + 1)] = (la[h] - lf[h], wa[h] - wf[h], sa[h] - sf[h])
    prev_hour = lambda d, he: (d, he - 1) if he > 1 else ((dt.date.fromisoformat(d) - dt.timedelta(days=1)).isoformat(), 24)

    ON_ST = {"ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR"}
    A = lambda x: np.arcsinh(np.asarray(x, float) / 10.0)
    ang = 2 * np.pi * np.arange(24) / 24
    HARM = np.c_[np.sin(ang), np.cos(ang), np.sin(2 * ang), np.cos(2 * ang)]
    U = {u: i for i, u in enumerate(cts)}
    feats = {k: [] for k in ("da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rt1", "rt3", "rtd1",
                             "nl_fc", "load_err1", "wind_err1", "solar_err1",
                             "nl_intra", "rev_load", "rev_wind", "rev_solar", "rev_nl")}
    meta = []
    dam = {}
    for i, d in enumerate(dates):
        p = DATA_DIR / "dam" / f"{d}.json.gz"
        if d >= "2026-02-01" and p.exists():
            dam[i] = json.load(gzip.open(p))["units"]
    di_of = {d: i for i, d in enumerate(dates)}
    ruc = {}       # unit -> hour indices in RUC; an hour in or just after one is left out of fit and score
    for name, days in (uh.get("ruc") or {}).items():
        for d, hes in days:
            if d in di_of:
                ruc.setdefault(name, set()).update(di_of[d] * 24 + he - 1 for he in hes)
    say(f"{sum(len(ruc.get(u, ())) for u in cts)} RUC hours on {sum(1 for u in cts if u in ruc)} CTs left out")
    for u in cts:
        rk = ruc.get(u, ())
        s = np.array(list(uh["units"][u][:N * 24].ljust(N * 24, "-")))
        P = rt[u].ravel()
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
                if k < 3 or s[k - 1] not in "ma0" or s[k] not in "ma0" or np.isnan(P[k - 3:k]).any() or k in rk or k - 1 in rk:
                    continue
                r, fc, er = F.get((d, h + 1)), DAF.get((d, h + 1)), ERR.get(prev_hour(d, h + 1))
                if r is None or fc is None or er is None or np.isnan(fc).any() or np.isnan(er).any():
                    continue
                nl_da = fc[0] - fc[1] - fc[2]
                nl_in = r["load"] - r["wind"] - r["solar"]
                prev = s[k - 1] in "ma"
                run = 0
                while k - 1 - run >= 0 and run < 48 and s[k - 1 - run] in "ma0" and (s[k - 1 - run] in "ma") == prev:
                    run += 1
                da1 = DA[h - 1] if h else DA[0]
                for name, v in (("da", A(DA[h])), ("dmax", A(DA[h:h + 4].max())), ("aw", float(aw[h])),
                                ("awa", aw[h:h + 4].mean()), ("st_on", float(st in ON_ST)), ("st_qs", float(st == "OFFQS")),
                                ("lam", A(lam[h]) if lam[h] is not None else 0.0), ("rt1", A(P[k - 1])),
                                ("rt3", A(P[k - 3:k].max())), ("rtd1", A(P[k - 1] - da1)),
                                ("nl_fc", nl_da / 10000.0), ("load_err1", er[0] / 2000.0),
                                ("wind_err1", er[1] / 2000.0), ("solar_err1", er[2] / 2000.0),
                                ("nl_intra", nl_in / 10000.0), ("rev_load", (r["load"] - fc[0]) / 2000.0),
                                ("rev_wind", (r["wind"] - fc[1]) / 2000.0), ("rev_solar", (r["solar"] - fc[2]) / 2000.0),
                                ("rev_nl", (nl_in - nl_da) / 2000.0)):
                    feats[name].append(v)
                meta.append((U[u], i, h, int(prev), int(s[k] in "ma"), np.log1p(run) / 4.0, d[:7],
                             lam[h] is not None and lam[h] <= 10.0))
    R = {k: np.array(v, float) for k, v in feats.items()}
    ui_, di, hi, prev, on, runf = (np.array([m[j] for m in meta]) for j in range(6))
    ui_, di, hi, prev, on = ui_.astype(int), di.astype(int), hi.astype(int), prev.astype(int), on.astype(int)
    mon = np.array([m[6] for m in meta])
    cheap = np.array([m[7] for m in meta], bool)
    say(f"{int(cheap.sum())} of them in cheap hours (day-ahead lambda <= $10)")
    say(f"{len(meta)} unit-hours with intra-hour features")
    nU = len(cts)
    B = ["da", "dmax", "aw", "awa", "st_on", "st_qs", "lam", "rt1", "rt3", "rtd1"]
    PARTS = ["nl_fc", "load_err1", "wind_err1", "solar_err1"]
    INTRA = ["nl_intra", "rev_load", "rev_wind", "rev_solar", "rev_nl"]
    MODELS = {
        "day-ahead + last hour's RT": B,
        "+ last hour's forecast errors": B + PARTS,
        "+ intra-hour forecasts": B + INTRA,
        "+ both": B + PARTS + INTRA,
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
    preds = {}
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
        preds[name] = pred
    for title, only in (("All hours", None), ("Cheap hours (day-ahead lambda <= $10)", cheap)):
        say("")
        say(f"**{title}**")
        say("")
        say("| Model | Starts caught | False starts | Stops caught | False stops | Brier, from offline | Brier, from online |")
        say("| --- | --- | --- | --- | --- | --- | --- |")
        for name, pred in preds.items():
            ok = ~np.isnan(pred) & (only if only is not None else True)
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
