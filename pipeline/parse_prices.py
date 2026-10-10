"""Cleared prices: SCED system lambda (NP6-322-CD) and settlement point prices (NP6-905-CD):
hubs and load zones for the site's price day files, resource nodes for the per-day node files
on the data branch.  Both reports are posted as many small files per day."""
import io
from typing import Dict, Iterable, Tuple

import warnings

import numpy as np
import pandas as pd

from .config import PRICE_NODE_TYPES, PRICE_POINT_TYPES
from .curves import parse_sced_time, to_iso_date
from .log import warn


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
            warn(f"Unrecognised system lambda columns in {n}: {list(f.columns)}")
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


SEEN_TYPES = set()          # settlement point types met this run beyond the known ones
NODE_FORMAT = 3             # bump when the node files change (update.py refetches older ones)


def read_spp(csvs: Iterable[Tuple[str, bytes]]) -> pd.DataFrame:
    frames = []
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        c = {k: _pick(f.columns, k) for k in ("deliverydate", "deliveryhour", "deliveryinterval",
                                                "settlementpointname", "settlementpointtype", "settlementpointprice")}
        if any(v is None for v in c.values()):
            warn(f"Unrecognised settlement point price columns in {n}: {list(f.columns)}")
            continue
        g = pd.DataFrame({
            "date": f[c["deliverydate"]].astype(str).str.strip(),
            "he": pd.to_numeric(f[c["deliveryhour"]], errors="coerce"),
            "interval": pd.to_numeric(f[c["deliveryinterval"]], errors="coerce"),
            "point": f[c["settlementpointname"]].astype(str).str.strip(),
            "type": f[c["settlementpointtype"]].astype(str).str.strip(),
            "price": pd.to_numeric(f[c["settlementpointprice"]], errors="coerce"),
        })
        new_types = set(g["type"].unique()) - PRICE_POINT_TYPES - PRICE_NODE_TYPES - SEEN_TYPES
        if new_types:
            SEEN_TYPES.update(new_types)
            print(f"spp: settlement point types besides {sorted(PRICE_POINT_TYPES | PRICE_NODE_TYPES)}: "
                  f"{sorted(new_types)} (kept as nodes)")
        frames.append(g)
    if not frames:
        return pd.DataFrame(columns=["date", "he", "interval", "point", "type", "price"])
    d = pd.concat(frames, ignore_index=True)
    d["date"] = to_iso_date(d["date"])
    d = d.dropna(subset=["he", "interval"])
    return d[["date", "he", "interval", "point", "type", "price"]]


def node_prices(date: str, spp: pd.DataFrame):
    """15-minute price at every settlement point that is not a hub or load zone on one day
    (resource nodes of every type: ERCOT files combined-cycle trains and some others under
    types other than "RN"), or None when the day has none:
    {"date", "format", "points": {node: [96 x $/MWh or null]}, "types": {type: n points}}.
    node_hourly() below gives the hourly means the curtailment and revenue figures use."""
    g = spp[(spp["date"] == date) & ~spp["type"].isin(PRICE_POINT_TYPES)]
    if g.empty:
        return None
    iv = (g["he"].astype(int).clip(1, 24) - 1) * 4 + (g["interval"].astype(int).clip(1, 4) - 1)
    q = g.assign(iv=iv.values).groupby(["point", "iv"])["price"].mean().unstack("iv").reindex(columns=range(96))
    types = g.drop_duplicates("point")["type"].value_counts().to_dict()
    return {"date": date, "format": NODE_FORMAT, "points": {name: _r2(row.values) for name, row in q.iterrows()},
            "types": {str(k): int(v) for k, v in types.items()}}


def node_hourly(nodes) -> dict:
    """{node: [24 hourly mean prices or null]} from a node file of any format (24 or 96 values
    per point); {} when there is none."""
    out = {}
    for name, vals in ((nodes or {}).get("points") or {}).items():
        if len(vals) == 96:
            a = np.array([np.nan if v is None else v for v in vals], float).reshape(24, 4)
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", RuntimeWarning)
                m = np.nanmean(a, axis=1)
            out[name] = [None if np.isnan(v) else round(float(v), 2) for v in m]
        else:
            out[name] = vals
    return out


def build_price_day(date: str, lam: pd.DataFrame, spp: pd.DataFrame):
    """Returns (day_payload, summary_payload) or None if no prices for the date.  Only hubs
    and load zones go in the day file; node_prices() builds the resource-node file."""
    lam = lam[lam["date"] == date].sort_values(["stamp", "flag"])
    spp = spp[(spp["date"] == date) & spp["type"].isin(PRICE_POINT_TYPES)]
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
