"""Cleared prices: SCED system lambda (NP6-322-CD) and settlement point prices at
hubs and load zones (NP6-905-CD).  Both are posted as many small files per day."""
import io
from typing import Dict, Iterable, Tuple

import numpy as np
import pandas as pd

from .config import PRICE_POINT_TYPES
from .curves import parse_sced_time


def _r2(a):
    return [None if pd.isna(x) else round(float(x), 2) for x in a]


def read_lambda(csvs: Iterable[Tuple[str, bytes]]) -> pd.DataFrame:
    frames = [pd.read_csv(io.BytesIO(b)) for n, b in csvs]
    if not frames:
        return pd.DataFrame(columns=["stamp", "flag", "lambda", "date", "hour"])
    d = pd.concat(frames, ignore_index=True)
    d.columns = [c.strip() for c in d.columns]
    d = d.rename(columns={"SCEDTimeStamp": "stamp", "RepeatedHourFlag": "flag",
                          "CappedSystemLambda": "lambda"})
    d = d.drop_duplicates(["stamp", "flag"])
    t = parse_sced_time(d["stamp"])
    d["date"], d["hour"] = t["date"].values, t["hour"].values
    return d[["stamp", "flag", "lambda", "date", "hour"]]


def read_spp(csvs: Iterable[Tuple[str, bytes]]) -> pd.DataFrame:
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        f.columns = [c.strip() for c in f.columns]
        frames.append(f[f["SettlementPointType"].astype(str).str.strip().isin(PRICE_POINT_TYPES)])
    if not frames:
        return pd.DataFrame(columns=["date", "he", "interval", "point", "price"])
    d = pd.concat(frames, ignore_index=True)
    dd = d["DeliveryDate"].astype(str)
    d["date"] = dd.str.slice(6, 10) + "-" + dd.str.slice(0, 2) + "-" + dd.str.slice(3, 5)
    d = d.rename(columns={"DeliveryHour": "he", "DeliveryInterval": "interval",
                          "SettlementPointName": "point", "SettlementPointPrice": "price"})
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
