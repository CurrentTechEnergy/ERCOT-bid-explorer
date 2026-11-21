"""Day reducers for the load-side history kinds (pipeline/history.py --load-res and --dam-bids).
Each takes one 60-day DAM disclosure zip and returns small frames; the month build concatenates
them.  Read only from the raw store in the workflow (--store-only), so nothing is fetched again.

load_res_day(blob) -> (date, {"load-res": frame, "as-share": frame})
  load-res   one row per Load Resource and hour:
             date, he, unit, qse, max_mw, low_mw, regup, regdn, rrs, ecrs, nspin (MW awarded);
             qse comes from the AS offer file, so it is null on days the resource offered no AS
  as-share   one row per hour and service: date, he, service, lr, esr, gen (MW awarded by Load
             Resources, batteries (ESR file, Dec 2025 on; before that inside gen) and generators),
             mcpc ($/MW per hour)

dam_bids_day(blob) -> (date, {"dam-bids": frame, "dam-cheap-demand": frame})
  dam-bids          every non-zero DAM energy-only bid or offer award:
                    date, he, point, qse, side ("buy" / "sell"), mw (positive), da_price
  dam-cheap-demand  energy-only bids summed by date, he, point and qse: total_mw (the bid's
                    largest MW), le0_mw, le10_mw and le15_mw (MW the bid buys only at $0, $10 or $15/MWh or less:
                    total MW less what it still buys above that price)
"""
import io
import re

import numpy as np
import pandas as pd

from .curves import to_iso_date
from .store import iter_csvs

SERVICES = {"regup": "regup", "regdown": "regdn", "rrs": "rrs", "ecrs": "ecrs", "nonspin": "nspin"}
CHEAP = (0, 10, 15)
QSE_COLS = ("qse", "qsename", "qsecode")
NAME_COLS = ("loadresourcename", "resourcename")


def _norm(c: str) -> str:
    return re.sub(r"[^a-z0-9]", "", c.lower())


def _svc(col: str):
    """'RRSPFR Awarded' -> 'rrs', 'NonSpin MCPC' -> 'nspin'; None for other columns."""
    n = _norm(col)
    for k, v in SERVICES.items():
        if n.startswith(k):
            return v
    return None


def _files(blob: bytes):
    out = {}
    for name, data in iter_csvs(blob, "x.zip"):
        out[name.lower().rsplit("/", 1)[-1]] = data
    return out


def _pick(files: dict, prefix: str):
    """The zip's file whose name starts with prefix, ignoring case, spaces and underscores."""
    want = _norm(prefix)
    return next((d for n, d in files.items() if _norm(n).startswith(want)), None)


def _date(f: pd.DataFrame) -> str:
    col = next(c for c in f.columns if _norm(c) == "deliverydate")
    return to_iso_date(f[col]).value_counts().idxmax()


def _col(f: pd.DataFrame, *names):
    want = {_norm(n) for n in names}
    return next((c for c in f.columns if _norm(c) in want), None)


def _awards(f: pd.DataFrame, keys) -> pd.DataFrame:
    """Sum the '<service>... Awarded' columns into one column per service."""
    out = f[keys].copy()
    for s in SERVICES.values():
        cols = [c for c in f.columns if _svc(c) == s and _norm(c).endswith("awarded")]
        out[s] = f[cols].apply(pd.to_numeric, errors="coerce").fillna(0).sum(axis=1) if cols else 0.0
    return out


def load_res_day(blob: bytes):
    files = _files(blob)
    lr = _pick(files, "60d_dam_load_resource_data")
    if lr is None:
        raise ValueError("No Load Resource data file in the 60-day DAM zip")
    L = pd.read_csv(io.BytesIO(lr), dtype={0: str})
    date = _date(L)
    he, name = _col(L, "Hour Ending"), _col(L, "Load Resource Name")
    mx, lo = _col(L, "Max Power Consumption for Load Resource"), _col(L, "Low Power Consumption for Load Resource")
    out = _awards(L, [he, name]).rename(columns={he: "he", name: "unit"})
    out["max_mw"] = pd.to_numeric(L[mx], errors="coerce") if mx else np.nan
    out["low_mw"] = pd.to_numeric(L[lo], errors="coerce") if lo else np.nan
    qse = {}
    off = _pick(files, "60d_dam_load_resource_asoffers")
    if off is not None:
        O = pd.read_csv(io.BytesIO(off), dtype=str, usecols=lambda c: _norm(c) in QSE_COLS + NAME_COLS)
        qc, nc = _col(O, *QSE_COLS), _col(O, *NAME_COLS)
        if qc and nc:
            qse = O[[nc, qc]].dropna().drop_duplicates(nc, keep="last").set_index(nc)[qc].str.strip().to_dict()
    if not qse:     # shown in the month build: which files and columns the zip had
        out_cols = list(pd.read_csv(io.BytesIO(off), nrows=0).columns) if off is not None else None
        qse_note = f"no Load Resource QSE: files {sorted(files)}; AS offer columns {out_cols}"
    else:
        qse_note = None
    out["unit"] = out["unit"].str.strip()
    out["qse"] = out["unit"].map(qse)
    out["he"] = pd.to_numeric(out["he"], errors="coerce").astype("Int64")
    out.insert(0, "date", date)
    out = out[["date", "he", "unit", "qse", "max_mw", "low_mw", *SERVICES.values()]]

    # shares: Load Resources against batteries and generators, plus the clearing price
    mcpc = {s: c for c in L.columns if _norm(c).endswith("mcpc") and (s := _svc(c))}
    share = out.groupby("he")[list(SERVICES.values())].sum().stack().rename("lr").to_frame()
    share.index.names = ["he", "service"]
    for key, prefix in (("esr", "60d_dam_esr_data"), ("gen", "60d_dam_gen_resource_data")):
        data = _pick(files, prefix)
        if data is None:
            share[key] = 0.0
            continue
        hdr = pd.read_csv(io.BytesIO(data), nrows=0).columns
        keep = [c for c in hdr if _norm(c) == "hourending" or (_svc(c) and _norm(c).endswith("awarded"))]
        G = pd.read_csv(io.BytesIO(data), usecols=keep)
        h = _col(G, "Hour Ending")
        g = _awards(G, [h]).rename(columns={h: "he"})
        g["he"] = pd.to_numeric(g["he"], errors="coerce").astype("Int64")
        share[key] = g.groupby("he")[list(SERVICES.values())].sum().stack().reindex(share.index).fillna(0).values
    price = L.groupby(he)[list(mcpc.values())].first().apply(pd.to_numeric, errors="coerce") if mcpc else pd.DataFrame()
    share["mcpc"] = [price[mcpc[s]].get(h, np.nan) if s in mcpc else np.nan for h, s in share.index]
    share = share.reset_index()
    share.insert(0, "date", date)
    out = out.reset_index(drop=True)
    out.attrs["note"] = qse_note
    return date, {"load-res": out, "as-share": share}


def _curve(f: pd.DataFrame, kind: str):
    M = np.column_stack([pd.to_numeric(f[c], errors="coerce") for c in f.columns if re.fullmatch(rf"energyonly{kind}mw\d+", _norm(c))])
    P = np.column_stack([pd.to_numeric(f[c], errors="coerce") for c in f.columns if re.fullmatch(rf"energyonly{kind}price\d+", _norm(c))])
    return M, P


def cheap_only(M: np.ndarray, P: np.ndarray, x: float) -> np.ndarray:
    """MW a bid buys only at prices <= x: its largest MW less the most it still buys above x."""
    tot = np.nan_to_num(np.nanmax(np.where(np.isnan(M), -np.inf, M), axis=1), neginf=0)
    above = np.where(P > x, M, np.nan)
    above = np.nan_to_num(np.nanmax(np.where(np.isnan(above), -np.inf, above), axis=1), neginf=0)
    return tot - np.maximum(above, 0)


def dam_bids_day(blob: bytes):
    files = _files(blob)
    frames, date = [], None
    for prefix, side, col in (("60d_dam_energybidawards", "buy", "Energy Only Bid Award in MW"),
                              ("60d_dam_energyonlyofferawards", "sell", "Energy Only Offer Award in MW")):
        data = _pick(files, prefix)
        if data is None:
            continue
        A = pd.read_csv(io.BytesIO(data), dtype=str)
        date = date or _date(A)
        mw = pd.to_numeric(A[_col(A, col)], errors="coerce").abs()
        f = pd.DataFrame({"he": pd.to_numeric(A[_col(A, "Hour Ending")], errors="coerce").astype("Int64"),
                          "point": A[_col(A, "Settlement Point")].str.strip(),
                          "qse": A[_col(A, "QSE Name", "QSE")].str.strip(),
                          "side": side, "mw": mw,
                          "da_price": pd.to_numeric(A[_col(A, "Settlement Point Price")], errors="coerce")})
        frames.append(f[f["mw"] > 0])
    if not frames:
        raise ValueError("No DAM energy-only award files in the 60-day DAM zip")
    awards = pd.concat(frames, ignore_index=True)
    awards.insert(0, "date", date)

    bids = _pick(files, "60d_dam_energybids-")
    cheap = pd.DataFrame(columns=["date", "he", "point", "qse", "total_mw", "le0_mw", "le10_mw", "le15_mw"])
    if bids is not None:
        B = pd.read_csv(io.BytesIO(bids), dtype=str)
        M, P = _curve(B, "bid")
        f = pd.DataFrame({"he": pd.to_numeric(B[_col(B, "Hour Ending")], errors="coerce").astype("Int64"),
                          "point": B[_col(B, "Settlement Point")].str.strip(),
                          "qse": B[_col(B, "QSE Name", "QSE")].str.strip(),
                          "total_mw": cheap_only(M, P, np.inf)})
        for x in CHEAP:
            f[f"le{x}_mw"] = cheap_only(M, P, x)
        cheap = f.groupby(["he", "point", "qse"], as_index=False).sum()
        cheap.insert(0, "date", date)
    return date, {"dam-bids": awards, "dam-cheap-demand": cheap}
