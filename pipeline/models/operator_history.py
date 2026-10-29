"""The operator-informed model (pipeline/models/operator_informed.py) on the days before the 60-day
window, from the thermal history files (pipeline/history.py, the `history` release: Jan 2019 on).

HistoryContext stands in for the forecast Context the model reads (dates, raw states, DAM day
records, hub prices), covering the history days and then the live 60-day days on one calendar.
A history day's DAM record is rebuilt from the thermal file's columns: node price, award, DAM LSL,
minimum-energy cost and hot start per configuration, as the DAM day file gives them, and its DAM
resource status by hour from the dam-status files (history.py --dam-status, built from our own
copies of the 60-day DAM disclosure in the raw store).  Without those files the reduced fits
leave the status out (zero for every hour).  One input the history lacks:
  gas price             at each unit's own hub (Houston Ship Channel or Waha, as the live model
                        reads it): the live hub series starts Nov 2025; before it, that hub as
                        far back as OilPriceAPI has it, then Henry Hub from EIA
                        (data/gas_history.json.gz, pipeline/gas.py)

The model itself picks the fit (operator_informed.fit): a month the 60-day fits cover keeps the
live fit (the history adds nothing to it), and an earlier month gets a reduced fit on the
HISTORY_WINDOW months before it, with the DAM status when the dam-status files are there.
"""
import datetime as dt
from collections import defaultdict

import numpy as np

from .. import private
from ..config import DATA_DIR, HISTORY_DIR
from ..forecast import context as grp
from ..intraday import train_of
from ..store import read_json_gz

TECHS = ("combined_cycle", "gas_steam")
HUB = "HB_HUBAVG"
COLS = ["date", "unit", "tech", "sp", "he", "state", "award", "da_node", "dam_lsl", "mingen", "hot_start"]


def _files(kind):
    return sorted(HISTORY_DIR.glob(f"{kind}-*.parquet")) if HISTORY_DIR.exists() else []


def _l(a):
    return [None if not np.isfinite(v) else round(float(v), 2) for v in a]


class HistoryContext:
    """The parts of forecast.context.Context the operator model reads, over the history days
    before the live context's first 60-day day and then the live days."""

    def __init__(self, live):
        import pandas as pd
        self.live = live
        self.live_day0 = live.stats["day0"]
        before = self.live_day0.isoformat()
        rank = {c: i for i, c in enumerate(sorted(grp.RANK, key=grp.RANK.get))}
        code = np.array(sorted(grp.RANK, key=grp.RANK.get))
        states, dam = defaultdict(dict), defaultdict(dict)
        for f in _files("thermal"):
            df = pd.read_parquet(f, columns=COLS)
            df = df[df["tech"].astype(str).isin(TECHS) & (df["date"] < before) & df["he"].between(1, 24)]
            if df.empty:
                continue
            df = df.sort_values(["date", "unit", "he"])
            t = df["tech"].astype(str)
            key = np.where(t == "combined_cycle", df["unit"].astype(str).map(train_of), df["unit"].astype(str))
            r = pd.DataFrame({"key": key, "date": df["date"].to_numpy(), "he": df["he"].to_numpy(),
                              "r": df["state"].astype(str).map(rank).fillna(0).astype(int).to_numpy()})
            w = r.groupby(["key", "date", "he"])["r"].max().unstack("he").reindex(columns=range(1, 25)).fillna(0).astype(int)
            for (k, d), seg in zip(w.index, code[w.to_numpy()]):
                states[k][d] = seg
            # one DAM record per configuration and day, in the DAM day file's shape
            g = df.groupby(["date", "unit"], observed=True, sort=False)
            for (d, name), u in g:
                h = u["he"].to_numpy() - 1
                spp, aw = np.full(24, np.nan), np.full(24, np.nan)
                spp[h], aw[h] = u["da_node"].to_numpy(float), u["award"].to_numpy(float)
                lsl = u["dam_lsl"].to_numpy(float)
                lsl = lsl[np.isfinite(lsl) & (lsl > 0)]
                mg, hot = u["mingen"].to_numpy(float), u["hot_start"].to_numpy(float)
                dam[d][str(name)] = {"tech": str(u["tech"].iat[0]), "sp": str(u["sp"].iat[0]),
                                     "lsl": float(lsl.min()) if lsl.size else None,
                                     "mingen": float(np.nanmin(mg)) if np.isfinite(mg).any() else None,
                                     "start": [float(np.nanmin(hot))] if np.isfinite(hot).any() else [],
                                     "spp": _l(spp), "award": [0.0 if not np.isfinite(v) else float(v) for v in aw]}
        # DAM resource status by hour (history.py --dam-status), onto the same records
        self.has_status = False
        for f in _files("dam-status"):
            st = pd.read_parquet(f)
            st = st[st["tech"].astype(str).isin(TECHS) & (st["date"] < before) & st["he"].between(1, 24)]
            for (d, name), u in st.groupby(["date", "unit"], observed=True, sort=False):
                rec = dam.get(d, {}).get(str(name))
                if rec is not None:
                    sh = [""] * 24
                    for h, v in zip(u["he"].to_numpy(), u["status"].astype(str)):
                        sh[h - 1] = v
                    rec["status_h"] = sh
                    self.has_status = True
        hist = sorted(dam)
        self.hist_dates = hist
        self.uh = {"dates": hist + list(live.uh.get("dates", []))}
        day0 = dt.date.fromisoformat(hist[0]) if hist else self.live_day0
        self.stats = {"day0": day0}
        self._dam = {d: {"hours": 24, "units": u} for d, u in dam.items()}
        self._hub = {}
        for f in _files("da-hubs"):
            h = pd.read_parquet(f)
            h = h[(h["point"] == HUB) & (h["date"] < before)]
            for d, g in h.groupby("date"):
                v = np.full(24, np.nan)
                v[g["he"].to_numpy() - 1] = g["price"].to_numpy(float)
                self._hub[d] = v
        # states on one calendar: the history, then the live raw states from the live day0 on
        off = (self.live_day0 - day0).days * 24
        live_raw = live.raw_states()
        n = off + max((len(st) for _, st in live_raw.values()), default=0)
        techs = {}
        for k, (t, st) in live_raw.items():
            techs[k] = t
        for d in hist:
            for name, u in self._dam[d]["units"].items():
                k = train_of(name) if u["tech"] == "combined_cycle" else name
                techs.setdefault(k, u["tech"])
        self._raw = {}
        for k in set(states) | set(live_raw):
            a = np.full(n, "-", dtype="<U1")
            for d, seg in states.get(k, {}).items():
                i = (dt.date.fromisoformat(d) - day0).days * 24
                a[i:i + 24] = seg
            if k in live_raw:
                st = live_raw[k][1]
                a[off:off + len(st)] = st
            self._raw[k] = (techs.get(k, live_raw.get(k, ("", None))[0]), a)
        # gas at each hub: the live series, then its history from OilPriceAPI, then Henry Hub
        live_hubs = (private.read("gas_hubs.json.gz", default={}) or {}).get("hubs", {})
        gh = read_json_gz(DATA_DIR / "gas_history.json.gz", default={}) or {}
        ph = private.read("gas_hub_history.json.gz", default={}) or {}
        self._oi_gas = {}
        for hub in sorted(set(live_hubs) | {"hsc", "waha"}):
            gas, first = {}, "9999"
            for s in (live_hubs.get(hub) or {}, ph.get(hub) or {}, gh.get("henry_hub") or {}):
                d0 = min(first, (s.get("dates") or ["9999"])[0])
                gas.update({d: v for d, v in zip(s.get("dates", []), s.get("value", [])) if d < first})
                first = d0
            dates = sorted(gas)
            self._oi_gas[hub] = (dates, [gas[d] for d in dates])

    def raw_states(self):
        return self._raw

    def dam(self, date):
        return self._dam.get(date) if date in self._dam else self.live.dam(date)

    def hub(self, date):
        v = self._hub.get(date)
        if v is None:
            return self.live.hub(date)
        return v if np.isfinite(v).sum() >= 23 else None


def context(live):
    """A HistoryContext over the history files, or None without them."""
    if not _files("thermal"):
        return None
    hc = HistoryContext(live)
    return hc if hc.hist_dates else None
