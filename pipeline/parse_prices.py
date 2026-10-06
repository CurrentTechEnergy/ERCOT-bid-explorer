"""Cleared prices: SCED system lambda (NP6-322-CD) and settlement point prices at
hubs and load zones (NP6-905-CD).  Both are posted as many small files per day."""
import io
from typing import Dict, Iterable, Tuple

import numpy as np
import pandas as pd

from .config import PRICE_POINT_TYPES
from .curves import parse_sced_time, to_iso_date


def _r2(a):
    return [None if pd.isna(x) else round(float(x), 2) for x in a]


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _pick(cols, *candidates, contains=None, exclude=()):
    """Find a column by normalized name; fall back to the first containing `contains`."""
    norm = {_norm(c): c for c in cols}
    for cand in candidates:
        if cand in norm:
            return norm[cand]
    if contains:
        for n, c in norm.items():
            if contains in n and not any(x in n for x in exclude):
                return c
    return None


def read_lambda(csvs: Iterable[Tuple[str, bytes]]) -> pd.DataFrame:
    """System lambda files.  Column names have varied over time (e.g. SystemLambda vs
    CappedSystemLambda), so columns are matched loosely."""
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        stamp = _pick(f.columns, "scedtimestamp", contains="timestamp")
        flag = _pick(f.columns, "repeatedhourflag", "repeathourflag", contains="repeat")
        lam = _pick(f.columns, "cappedsystemlambda", "systemlambda", contains="lambda", exclude=("uncapped",))
        if stamp is None or lam is None:
            print(f"  ! unrecognised system lambda columns in {n}: {list(f.columns)}")
            continue
        frames.append(pd.DataFrame({
            "stamp": f[stamp].astype(str).str.strip(),
            "flag": f[flag].astype(str).str.strip() if flag else "N",
            "lambda": pd.to_numeric(f[lam], errors="coerce"),
        }))
    if not frames:
        return pd.DataFrame(columns=["stamp", "flag", "lambda", "date", "hour"])
    d = pd.concat(frames, ignore_index=True).drop_duplicates(["stamp", "flag"])
    t = parse_sced_time(d["stamp"])
    d["date"], d["hour"] = t["date"].values, t["hour"].values
    return d[["stamp", "flag", "lambda", "date", "hour"]]


def read_spp(csvs: Iterable[Tuple[str, bytes]]) -> pd.DataFrame:
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        c = {k: _pick(f.columns, k) for k in ("deliverydate", "deliveryhour", "deliveryinterval",
                                                "settlementpointname", "settlementpointtype", "settlementpointprice")}
        if any(v is None for v in c.values()):
            print(f"  ! unrecognised settlement point price columns in {n}: {list(f.columns)}")
            continue
        g = pd.DataFrame({
            "date": f[c["deliverydate"]].astype(str).str.strip(),
            "he": pd.to_numeric(f[c["deliveryhour"]], errors="coerce"),
            "interval": pd.to_numeric(f[c["deliveryinterval"]], errors="coerce"),
            "point": f[c["settlementpointname"]].astype(str).str.strip(),
            "type": f[c["settlementpointtype"]].astype(str).str.strip(),
            "price": pd.to_numeric(f[c["settlementpointprice"]], errors="coerce"),
        })
        frames.append(g[g["type"].isin(PRICE_POINT_TYPES)])
    if not frames:
        return pd.DataFrame(columns=["date", "he", "interval", "point", "price"])
    d = pd.concat(frames, ignore_index=True)
    d["date"] = to_iso_date(d["date"])
    d = d.dropna(subset=["he", "interval"])
    return d[["date", "he", "interval", "point", "price"]]


def build_price_day(date: str, lam: pd.DataFrame, spp: pd.DataFrame):
    """Returns (day_payload, summary_payload) or None if no prices for the date."""
    lam = lam[lam["date"] == date].sort_values(["stamp", "flag"])
    spp = spp[spp["date"] == date]
    if lam.empty and spp.empty:
        return None

    lam_hourly = lam.groupby("hour")["lambda"].agg(["mean", "min", "max"]).reindex(range(24))
    points = {}
    point_hourly = {}
    for name, g in spp.groupby("point"):
        idx = (g["he"].astype(int) - 1) * 4 + (g["interval"].astype(int) - 1)
        q = g.assign(i=idx.values).groupby("i")["price"].mean().reindex(range(96))
        points[name] = _r2(q.values)
        point_hourly[name] = _r2(q.values.reshape(24, 4).mean(axis=1) if q.notna().all()
                                 else np.nanmean(q.values.reshape(24, 4), axis=1))

    day = {
        "date": date,
        "lambda": {
            "time": [s[11:16] for s in lam["stamp"].astype(str)],
            "value": _r2(lam["lambda"].values),
            "hourly_mean": _r2(lam_hourly["mean"].values),
            "hourly_min": _r2(lam_hourly["min"].values),
            "hourly_max": _r2(lam_hourly["max"].values),
        },
        "spp15": points,          # 96 fifteen-minute prices per hub / load zone
    }
    summary = {"lambda": _r2(lam_hourly["mean"].values), "spp": point_hourly}
    return day, summary
