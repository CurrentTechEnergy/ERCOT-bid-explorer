"""ERCOT's short-term wind and solar power forecasts (STWPF, STPPF), system-wide, hourly, for
the Overview's forecast of available wind and solar (pipeline/models/renewable_floor.py).

Reports (ERCOT Public API, posted hourly, each file carrying the hours ahead):
  NP4-732-CD  Wind Power Production - Hourly Averaged Actual and Forecasted Values
  NP4-737-CD  Solar Power Production - Hourly Averaged Actual and Forecasted Values
Columns are matched loosely by name (DELIVERY_DATE, HOUR_ENDING, STWPF_SYSTEM_WIDE /
STPPF_SYSTEM_WIDE, ACTUAL_SYSTEM_WIDE, COP_HSL_SYSTEM_WIDE); a file whose columns are not
recognised is skipped with a warning naming them.

For each operating day D the forecast kept is the newest posting at or before CUTOFF_HOUR
Central on D - 1: what was public when the day-ahead market for D cleared, so a day's
forecast does not drift as later postings arrive.  Actuals (the report's own hourly averaged
actual production, ERCOT's number for reconciliation) are taken from the newest posting.

Writes data/renew_forecast.json.gz:
  {"days": {date: {"wind": [24], "solar": [24], "wind_actual": [24] or null, "solar_actual": ...,
                   "wind_cop": [24] or null, "solar_cop": ..., "posted": {"wind": ts, "solar": ts}}}}
"""
import datetime as dt
import io

import pandas as pd

from .config import DATA_DIR
from .curves import to_iso_date
from .log import warn
from .store import iter_csvs, read_json_gz, write_json_gz

PATH = DATA_DIR / "renew_forecast.json.gz"
EMIL = {"wind": "np4-732-cd", "solar": "np4-737-cd"}
FC_COL = {"wind": "stwpf", "solar": "stppf"}
CUTOFF_HOUR = 14          # Central: the day-ahead market for D clears by about 13:30 on D - 1
LOOKBACK_DAYS = 3


def _norm(c) -> str:
    return "".join(ch for ch in str(c).lower() if ch.isalnum())


def _find(cols, *parts, exclude=()):
    for c in cols:
        n = _norm(c)
        if all(p in n for p in parts) and not any(x in n for x in exclude):
            return c
    return None


def read_forecast(csvs, kind: str) -> dict:
    """CSVs of one posting -> {date: {"fc": [24], "actual": [24] | None, "cop": [24] | None}}."""
    out = {}
    for n, b in csvs:
        f = pd.read_csv(io.BytesIO(b))
        date = _find(f.columns, "deliverydate") or _find(f.columns, "date")
        he = _find(f.columns, "hourending") or _find(f.columns, "hour")
        fc = _find(f.columns, FC_COL[kind], "system")
        if not (date and he and fc):
            warn(f"{kind} forecast file {n}: columns not recognised: {list(f.columns)}")
            continue
        act = _find(f.columns, "actual", "system")
        cop = _find(f.columns, "cop", "system")
        flag = _find(f.columns, "dstflag") or _find(f.columns, "repeatedhourflag")
        g = pd.DataFrame({
            "date": to_iso_date(f[date].astype(str).str.strip()),
            "he": pd.to_numeric(f[he].astype(str).str.split(":").str[0], errors="coerce"),
            "flag": f[flag].astype(str).str.strip().str.upper() if flag else "N",
            "fc": pd.to_numeric(f[fc], errors="coerce"),
            "actual": pd.to_numeric(f[act], errors="coerce") if act else float("nan"),
            "cop": pd.to_numeric(f[cop], errors="coerce") if cop else float("nan"),
        })
        g = g[(g["flag"] != "Y") & g["he"].between(1, 24)]
        for d, rows in g.groupby("date"):
            e = out.setdefault(d, {"fc": [None] * 24, "actual": [None] * 24, "cop": [None] * 24})
            for _, r in rows.iterrows():
                h = int(r["he"]) - 1
                for k in ("fc", "actual", "cop"):
                    v = r[k]
                    if pd.notna(v):
                        e[k][h] = round(float(v), 1)
    for e in out.values():
        for k in ("actual", "cop"):
            if all(v is None for v in e[k]):
                e[k] = None
    return out


def _cutoff(date: str) -> str:
    d = dt.date.fromisoformat(date) - dt.timedelta(days=1)
    return f"{d.isoformat()}T{CUTOFF_HOUR:02d}:00:00"


def fetch_renew_forecast(api, index: dict, today: dt.date = None) -> None:
    today = today or dt.date.today()
    store = read_json_gz(PATH, default=None) or {"days": {}}
    days = store["days"]
    since = dt.datetime.combine(today - dt.timedelta(days=LOOKBACK_DAYS), dt.time())
    until = dt.datetime.combine(today + dt.timedelta(days=1), dt.time())
    for kind, emil in EMIL.items():
        try:
            docs = api.list_archives(emil, since, until)
        except Exception as e:
            warn(f"{kind} forecast: listing failed: {type(e).__name__}: {e}")
            continue
        docs.sort(key=lambda d: d.get("postDatetime", ""))
        if not docs:
            warn(f"{kind} forecast: no {emil} files posted since {since:%Y-%m-%d}")
            continue
        # the newest posting at or before each wanted day's cutoff, plus the newest of all (actuals)
        want = [(today + dt.timedelta(days=k)).isoformat() for k in range(-1, 2)]
        picks = {}
        for d in want:
            cut = _cutoff(d)
            ok = [x for x in docs if x.get("postDatetime", "")[:19] <= cut]
            if ok:
                picks.setdefault(ok[-1]["docId"], []).append(d)
        newest = docs[-1]["docId"]
        picks.setdefault(newest, [])
        for doc_id, for_days in picks.items():
            doc = next(x for x in docs if x["docId"] == doc_id)
            try:
                blob = api.download(emil, doc_id)
                got = read_forecast(list(iter_csvs(blob, "x.zip")), kind)
            except Exception as e:
                warn(f"{kind} forecast (doc {doc_id}): failed: {type(e).__name__}: {e}")
                continue
            posted = doc.get("postDatetime", "")[:19]
            for d in for_days:
                if d in got and any(v is not None for v in got[d]["fc"]):
                    e = days.setdefault(d, {"posted": {}})
                    e[kind] = got[d]["fc"]
                    e[f"{kind}_cop"] = got[d]["cop"]
                    e["posted"][kind] = posted
            if doc_id == newest:
                for d, v in got.items():
                    if v["actual"] is not None:
                        days.setdefault(d, {"posted": {}})[f"{kind}_actual"] = v["actual"]
    store["days"] = dict(sorted(days.items()))
    write_json_gz(PATH, store)
    have = [d for d, v in days.items() if v.get("wind") and v.get("solar")]
    print(f"wind/solar forecasts: {len(have)} day(s) with both" + (f", latest {max(have)}" if have else ""))
