"""Decision table on actuals: every combined-cycle and gas steam train's stay-on decision through
each of its day-ahead loss windows, from 2019 on, judged from the operator's view at the time of
the decision (only what it knew then: no real-time prices).  Read by the Goal page workflow
(pipeline/goal.py, questions 3 and 4) and the decision model (pipeline/decision_rule.py).

    python -m pipeline.decision_table [--from 2019-01] [--to 2026-08] [--out decision-table]

The definition (agreed with Blair, Nov 2 2026; analysis/calculations-reference/
ride-through-review-2026-11-02.md in the project files):

  loss window   the worst run of consecutive hours where the train's gas cost at minimum is
                above its DA node price (the largest sum of the difference), up to MAX_OFF hours.
                Two per day at most, by where the window starts (SLOTS): "day" HE8 to HE19, and
                "night" HE20 to HE7 the next morning.  A window may only reach into the next day
                when it starts at HE14 or later (DA_KNOWN), once that day's DA prices are
                published.  When two windows overlap the bigger loss is kept.
  in the decision   online in the hour before the window, or an off spell overlapping the window
                that began at most EARLY_H hours before it (the unit shut a little early for it);
                and available through the window (no outage or missing hour, except inside an off
                spell: an economic shutdown with a shorter outage slotted inside it still counts).
                A non-running spell that is mostly outage, or has fewer than OFF_MIN_H OFF hours
                around an outage, is an outage throughout (outage_like; the site-wide rule of
                pipeline/groups.py): maintenance, not a shutdown, and not in the decision
  lsl           LSL of the configuration online going in (the last online hour before the window
                or the shutdown), else the train's smallest DAM LSL that day; below MIN_LSL left out
  cost          gas cost at minimum ($/MWh), the train's heat rate at minimum (pipeline/heat_rates) x its own hub price (run_cost)
  loss          sum over the window of (cost - DA node price) x lsl ($): the expected loss
  min_off       the train's minimum off time: the 10th percentile of its clean off spells (every
                hour offline-available, between online hours, OFF_MIN_H hours or more) ending in the
                OFF_DAYS days before the day; OFF_DEFAULT without OFF_SPELLS of them (min_off_est)
  save_max, net_max   the best shutdown overlapping the window, at least min_off and at most
                MAX_OFF hours long, starting no more than EARLY_H hours before the window: its
                saving, sum of (cost - DA node price) x lsl over the hours off (profitable hours it
                would sit out count against it), and that saving less the restart (net)
  start_cost    the restart of the best shutdown: hot start offer of the configuration going in when
                off HOT_H hours or less, else intermediate (hot x the technology's generic
                intermediate/hot ratio: the history keeps the hot start offer only); generic
                costs without an offer (start_est)
  commit_share  share of the window's hours with a DAM energy award of at least AWARD_LSL x lsl
                while the DAM resource status was not on: committed by the DAM on its three-part
                offer, eligible for make-whole.  NaN where the status is unknown
  award_share   the same for any DAM energy award (a self-committed award is financial: shutting
                means buying it back, at an expected price of the DA price, so it does not change
                the expected loss)
  as_share      share of the window's hours with a DAM ancillary service award
  ruc_share     share of the window's hours in RUC (from the 60-day unit files: NaN before them)
  position      the DAM position over the window, first that applies: "committed" (commit_share
                at least FORCED), "as" (as_share), "self" (award_share), "none".  A split, not a
                reason to leave the window out: every DAM position but RUC can be bought back
  mw_given_up   the DAM make-whole the best shutdown gives up ($): make-whole of each DAM
                commitment block it touches (contiguous committed hours of a day) staying on, less
                the same without the hours off.  Make-whole of a block = max(0, startup + sum of
                (minimum-energy offer - DA node) x DAM LSL - DA AS revenue) over its hours online,
                per Protocols 4.6.2.3: energy cost only in hours online, startup only when the train
                was off going in.  Simplified: minimum-energy offer only (no curve above LSL), no caps
  as_given_up   from RTC+B (RTC_START): DA AS revenue over the best shutdown's hours ($), the AS
                its capacity would have carried.  The DAM AS award itself is bought back at the RT
                MCPC (Protocols 6.7.2.1), expected at the DA MCPC.  0 before RTC_START
  gain          net_max - mw_given_up - as_given_up: what the best shutdown is expected to save
                after its restart and everything it gives up (positive: shutting pays)
  gain_rt       the same in hindsight, at the real-time node price and RT MCPC, less the margin
                above LSL given up (max(0, RT - cost) x the train's output above LSL in hours it ran,
                its headroom HSL - LSL going in when it was off).  NaN without RT prices.  For what
                the call cost, never for bucketing (review item 8)
  bucket        first that applies: "held" (RUC share at least FORCED, or before RTC_START a DAM AS
                share at least FORCED), "held_mw" (net_max > 0 but gain <= 0: the restart is beaten
                but not the make-whole and AS given up), "more" (gain > 0), "short" (window shorter
                than min_off), "less" (the rest: losing, but shutting does not pay)
  shut, shut_he, off_h   the outcome: an off spell (OFF_MIN_H offline hours or more at its start)
                at least min_off hours long overlapping the window; its first hour ending, counted
                from the row's HE1, and its length
  on_share      share of the window's hours online (for splitting MWh only)

Other columns: train, tech, date (the day the slot belongs to), slot, year, month, season,
win_from (first hour ending from the date's HE1, 8 to 31), win_h, cost_est, offer (DAM minimum-
energy offer, reference), hot_start, loss_per_mw, start_per_mw, before_per_mw / after_per_mw
(positive margin per MW in the 12 hours before and after), off_p10 (= min_off, the old name),
win_vs_off, run_lsl, size_ratio, gas_hh, hub_win, wind_win, solar_win, thermal_win.

Inputs: the monthly thermal history (pipeline/history.py, the `history` release, in HISTORY_DIR),
and for months it does not hold yet, the same rows from the per-unit 60-day day files
(UNIT_DATA_DIR/60d) and the DAM day files (data/dam), cached as <out>/months/; DAM resource
status and AS awards from the release's dam-status- and as- files, else the DAM day files, DAM
MCPCs from its as-mcpc- files (else the DAM day files) and RT MCPCs from its rt-mcpc- files; RT
node prices as pipeline/goal._rt_nodes (the release's rt-prices files, else UNIT_DATA_DIR/nodes);
RUC from the 60-day day files.  Gas as in gas_by_hub.  No ERCOT download.

Writes <out>/decision-table.parquet and <out>/summary.md.
"""
import argparse
import io
import math
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR, GENERIC_COSTS, HISTORY_DIR, UNIT_DATA_DIR
from .decisions import COST_DAYS
from .gas import monthly_basis
from .gascost import GAS_TECHS
from . import heat_rates
from .intraday import train_of

VERSION = "d5"      # d5: an off spell that is mostly outage (or has under OFF_MIN_H OFF hours around one) is an outage, not a shutdown, as pipeline/groups.py (Nov 2026); d4: DAM commitment and (from RTC+B) AS no longer hold a window on: make-whole and AS given up netted (Nov 2026); d3: each unit's measured heat rate at minimum, coal at fuel (Nov 2026); d2: operator's-view windows; d1: HE7-to-HE6 blocks
TECHS = ("combined_cycle", "gas_steam")      # coal is out (Blair, Nov 2 2026): generic cost, seasonal shutdowns
HH_URL = "https://www.eia.gov/dnav/ng/hist_xls/RNGWHHDd.xls"
AWARD_LSL = 0.9
MIN_LSL = 5.0       # MW: a smaller DAM LSL is a placeholder, not the unit's minimum
GAS_TOLERANCE = 7   # days a hub price carries over a gap in its series before Henry Hub stands in
OFF_MIN_H = 2       # offline-available hours an off spell needs: shorter is a configuration swap or a blip
OFF_DEFAULT = {"combined_cycle": 4.0, "gas_steam": 8.0}   # minimum off time without OFF_SPELLS spells
OFF_SPELLS = 3
OFF_DAYS = 365
MAX_OFF = 24        # longest window and shutdown weighed (hours): beyond it the restart turns cold
HOT_H = 8           # a shutdown up to this long restarts hot, longer intermediate (as pipeline/stayon.py)
EARLY_H = 6         # a shutdown starting up to this many hours before the window is still for it
DA_KNOWN = 13       # hour index (HE14) by which the next day's DA prices are published
SLOTS = (("day", 7, 18), ("night", 19, 30))   # first hour index of a window, from the day's HE1
FORCED = 0.5        # share of the window held by RUC (or AS before RTC_START) that takes it out, and the
                    # share of a DAM position that names the window's position
RTC_START = "2025-12-05"   # RTC+B: DAM AS awards financial from this operating day (Protocols 6.7.2.1)
MARGIN_H = 12       # hours before and after the window for before_per_mw / after_per_mw
MIN_LOAD = {"gas_steam": 1.28}   # gas cost at minimum against a full-load 10.4, for callers that take one
                                 # heat rate per technology (the predictor): gas steam's DAM offer price at
                                 # LSL + 1 MW is a median 1.28 x 10.4 x hub gas (Dec 2025 to Sep 2026); EPA
                                 # heat input over ERCOT net gives 1.29 (pipeline/heat_rates, Nov 2026).
                                 # run_cost uses each unit's own measured value instead.
SEASON = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
          6: "summer", 7: "summer", 8: "summer", 9: "fall", 10: "fall", 11: "fall"}
CODE = {"-": 0, "o": 1, "0": 2, "m": 3, "a": 4}     # same order as decisions.RANK
ON_STATUS = {"ON", "ONOS", "ONRE", "ONDSR", "ONOPTOUT", "ONTEST", "ONEMR", "ONRUC", "ONREG", "ONRR"}

def _months(a, b):
    y, m = map(int, a.split("-"))
    out = []
    while f"{y:04d}-{m:02d}" <= b:
        out.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def month_file(kind: str, month: str, out: Path):
    """The month's thermal or units rows: the release file, else built from the day files."""
    p = HISTORY_DIR / f"{kind}-{month}.parquet"
    if p.exists():
        return pd.read_parquet(p)
    cache = out / "months" / f"{kind}-{month}.parquet"
    if cache.exists():
        return pd.read_parquet(cache)
    from .history import thermal_rows, unit_rows
    from .store import read_json_gz
    frames = []
    for day in sorted((UNIT_DATA_DIR / "60d").glob(f"{month}-*.json.gz")):
        ud = read_json_gz(day)
        dam = read_json_gz(DATA_DIR / "dam" / day.name)
        if ud and dam:
            frames.append((thermal_rows if kind == "thermal" else unit_rows)(ud, dam))
    if not frames:
        return None
    f = pd.concat(frames, ignore_index=True)
    cache.parent.mkdir(parents=True, exist_ok=True)
    f.to_parquet(cache)
    print(f"  built {kind}-{month} from {len(frames)} day files", flush=True)
    return f


def henry_hub(out: Path) -> pd.Series:
    """Daily Henry Hub ($/MMBtu): the site's EIA series (data/gas_history.json.gz before
    data/gas.json.gz, pipeline/gas.py) when it reaches back to the table's start, else EIA's
    public history file, cached as <out>/henry-hub.csv."""
    from .store import read_json_gz
    hist = (read_json_gz(DATA_DIR / "gas_history.json.gz", default=None) or {}).get("henry_hub") or {}
    live = read_json_gz(DATA_DIR / "gas.json.gz", default=None) or {}
    v = dict(zip(hist.get("dates", []), hist.get("value", [])))
    v.update(zip(live.get("dates", []), live.get("value", [])))
    if v and min(v) <= "2019-01-02":
        x = pd.Series(v, dtype=float)
        x.index = pd.to_datetime(x.index)
        return x.sort_index()
    p = out / "henry-hub.csv"
    if not p.exists():
        import requests
        r = requests.get(HH_URL, timeout=60)
        r.raise_for_status()
        x = pd.read_excel(io.BytesIO(r.content), sheet_name=1, skiprows=2)
        x.columns = ["date", "hh"]
        x.dropna().to_csv(p, index=False)
    x = pd.read_csv(p, parse_dates=["date"])
    return x.set_index("date")["hh"].sort_index()


def gas_by_hub(out: Path) -> dict:
    """{hub: {date: $/MMBtu}} for every day from 2019: the price on the last trading day before
    the day (gas trades the day before it flows), for Henry Hub ("hh", henry_hub) and, where their
    series reach, Houston Ship Channel ("hsc") and Waha ("waha"): the private gas_hub_history and
    gas_hubs files (pipeline/gas.py, OilPriceAPI).  A price carries at most GAS_TOLERANCE days.
    "hsc_fill" has Henry Hub plus Ship Channel's monthly median basis on the days "hsc" lacks."""
    from . import private
    series = {"hh": henry_hub(out)}
    hist = private.read("gas_hub_history.json.gz", default=None) or {}
    live = (private.read("gas_hubs.json.gz", default=None) or {}).get("hubs", {})
    for k in ("hsc", "waha"):
        v = {}
        for src in (hist.get(k) or {}, live.get(k) or {}):
            v.update((d, x) for d, x in zip(src.get("dates") or [], src.get("value") or []) if x is not None)
        if v:
            x = pd.Series(v, dtype=float)
            x.index = pd.to_datetime(x.index)
            series[k] = x.sort_index()
    days = pd.date_range("2019-01-01", pd.Timestamp.today().normalize())
    keys = days.strftime("%Y-%m-%d")
    out_ = {}
    for k, x in series.items():
        x = x.dropna()
        x = x[~x.index.duplicated(keep="last")]
        lag = x.reindex(days - pd.Timedelta(days=1), method="ffill", tolerance=pd.Timedelta(days=GAS_TOLERANCE))
        out_[k] = {d: float(p) for d, p in zip(keys, lag.to_numpy()) if np.isfinite(p)}
    if out_.get("hsc"):     # Ship Channel's gaps: Henry Hub plus its median basis that calendar month
        basis = monthly_basis(out_["hsc"], out_["hh"])
        out_["hsc_fill"] = {d: v + basis.get(int(d[5:7]), 0.0) for d, v in out_["hh"].items() if d not in out_["hsc"]}
    return out_


def hub_of() -> dict:
    """{unit or CC train: "hsc" | "waha"}: each unit's gas hub (data/fuel_hubs.json.gz); a train
    takes its first configuration's."""
    from .store import read_json_gz
    hub = {}
    for name, u in ((read_json_gz(DATA_DIR / "fuel_hubs.json.gz", default={}) or {}).get("units") or {}).items():
        hub[name] = u.get("hub") or "hsc"
        if u.get("tech") == "combined_cycle":
            hub.setdefault(train_of(name), hub[name])
    return hub


def run_cost(tech, train, date, gas, hubs):
    """($/MWh, estimated) of running at minimum on `date`: gas units at their heat rate at minimum
    (combined cycles and gas steam: the unit's or train's measured value, else its technology's,
    pipeline/heat_rates; combustion turbines too since Nov 5 2026, 11.0 before) x the train's own hub price (Houston Ship Channel without
    one), Henry Hub standing in (estimated) where the hub has no price, plus the monthly basis for
    Ship Channel (gas_by_hub); coal at its heat rate at minimum x its delivered coal price that
    month (heat_rates.coal_price: the plant's own EIA-923 price, else the Texas subbituminous
    average, estimated); any unit without a gas price at the generic cost (estimated)."""
    if tech == "coal":
        p, own = heat_rates.coal_price(train, date)
        return heat_rates.at_min(tech, train)[0] * p, not own
    if tech in GAS_TECHS:
        hr = heat_rates.at_min(tech, train)[0]
        hub = hubs.get(train, "hsc")
        p = gas.get(hub, {}).get(date)
        if p is not None:
            return hr * p, False
        p = gas.get(f"{hub}_fill", {}).get(date)
        if p is None:
            p = gas.get("hh", {}).get(date)
        if p is not None:
            return hr * p, True
    return float(GENERIC_COSTS[tech][3]), True


def _trains(units, techs):
    return [train_of(u) if t == "combined_cycle" else u for u, t in zip(units, techs)]


def _cached(name, out, make):
    """A month's side file: <out>/months/<name>.parquet, made once by make() (None when no input)."""
    p = out / "months" / f"{name}.parquet"
    if p.exists():
        return pd.read_parquet(p)
    f = make()
    if f is not None:
        p.parent.mkdir(parents=True, exist_ok=True)
        f.to_parquet(p)
    return f


def _dam_days(month):
    from .store import read_json_gz
    for p in sorted((DATA_DIR / "dam").glob(f"{month}-*.json.gz")):
        d = read_json_gz(p, default=None)
        if d:
            yield d


def month_status(month: str, out: Path):
    """[train, date, he, st_on]: DAM resource status on (any configuration) by hour, from the
    release's dam-status file, else the DAM day files; None without either."""
    p = HISTORY_DIR / f"dam-status-{month}.parquet"
    if p.exists():
        st = pd.read_parquet(p, columns=["date", "unit", "tech", "he", "status"])
    else:
        def make():
            from .history import status_rows
            fr = [status_rows(d) for d in _dam_days(month)]
            return pd.concat(fr, ignore_index=True) if fr else None
        st = _cached(f"dam-status-{month}", out, make)
    if st is None or st.empty:
        return None
    st = st[st["tech"].astype(str).isin(TECHS)]
    st = st.assign(train=_trains(st["unit"].astype(str), st["tech"].astype(str)),
                   st_on=st["status"].astype(str).str.upper().isin(ON_STATUS))
    return st.groupby(["train", "date", "he"])["st_on"].any().reset_index()


def _mcpc(month: str, out: Path, kind: str):
    """[date, he, service...]: the month's hourly MCPCs, DAM ("da": the release's as-mcpc file, else
    the DAM day files) or real-time ("rt": the release's rt-mcpc file, its intervals averaged); None
    without them."""
    from .history import AS_SERVICES
    if kind == "rt":
        p = HISTORY_DIR / f"rt-mcpc-{month}.parquet"
        if not p.exists():
            return None
        m = pd.read_parquet(p)
        return m.groupby(["date", "he"])[[s for s in AS_SERVICES if s in m]].mean().reset_index()
    p = HISTORY_DIR / f"as-mcpc-{month}.parquet"
    if p.exists():
        return pd.read_parquet(p)

    def make():
        from .history import as_rows
        fr = [as_rows(d)[1] for d in _dam_days(month)]
        return pd.concat(fr, ignore_index=True) if fr else None
    return _cached(f"as-mcpc-{month}", out, make)


def month_as(month: str, out: Path):
    """[train, date, he, as_mw, as_val, as_rt]: DAM AS awards summed over services and
    configurations, their DA revenue (MW x DAM MCPC, $) and their value at the RT MCPC ($; NaN
    without RT MCPCs)."""
    from .history import AS_SERVICES
    p = HISTORY_DIR / f"as-{month}.parquet"
    if p.exists():
        a = pd.read_parquet(p)
    else:
        def make():
            from .history import as_rows
            fr = [as_rows(d)[0] for d in _dam_days(month)]
            return pd.concat(fr, ignore_index=True) if fr else None
        a = _cached(f"as-{month}", out, make)
    if a is None or a.empty:
        return None
    a = a[a["tech"].astype(str).isin(TECHS)]
    mw = a[AS_SERVICES].fillna(0)
    a = a.assign(train=_trains(a["unit"].astype(str), a["tech"].astype(str)), as_mw=mw.sum(axis=1))
    a["he"] = a["he"].astype(int)
    for kind, col in (("da", "as_val"), ("rt", "as_rt")):
        m = _mcpc(month, out, kind)
        if m is None:
            a[col] = np.nan
            continue
        m = m.assign(he=m["he"].astype(int)).set_index(["date", "he"]).reindex(pd.MultiIndex.from_frame(a[["date", "he"]]))
        a[col] = sum(mw[s].to_numpy() * m[s].fillna(0).to_numpy() if s in m else 0.0 for s in AS_SERVICES)
    return a.groupby(["train", "date", "he"])[["as_mw", "as_val", "as_rt"]].sum(min_count=1).reset_index()


def month_rt(month: str):
    """[sp, date, he, rt_node]: real-time settlement point prices by hour (pipeline/goal._rt_nodes:
    the release's rt-prices file, else the live node files); None without them."""
    from .goal import _rt_nodes
    r = _rt_nodes(month)
    return None if r is None or r.empty else r


def month_ruc(month: str, out: Path):
    """[train, date, he, ruc] for the days with a 60-day unit file (ONRUC or ONOPTOUT in at
    least half the hour's SCED runs, intraday.ruc_hours), ruc False in their other hours; None
    for months the release holds (no unit status there)."""
    if (HISTORY_DIR / f"thermal-{month}.parquet").exists():
        return None

    def make():
        from .intraday import ruc_hours, unit_hours
        from .store import read_json_gz
        rows = []
        for p in sorted((UNIT_DATA_DIR / "60d").glob(f"{month}-*.json.gz")):
            ud = read_json_gz(p, default=None)
            if not ud:
                continue
            for name, u in ud["units"].items():
                if u.get("tech") not in TECHS:
                    continue
                e = unit_hours(u, ud["runs"])[4]
                rh = set(ruc_hours(e["status"], ud["runs"]))
                tr = train_of(name) if u["tech"] == "combined_cycle" else name
                rows += [(tr, ud["date"], h, h in rh) for h in range(1, 25)]
        return pd.DataFrame(rows, columns=["train", "date", "he", "ruc"]) if rows else None
    r = _cached(f"ruc-{month}", out, make)
    return None if r is None else r.groupby(["train", "date", "he"])["ruc"].any().reset_index()


def train_days(f: pd.DataFrame) -> pd.DataFrame:
    """The month's thermal rows merged to one row per train, day and hour: online when any
    configuration is, the running configuration's LSL and hot start, the smallest DAM LSL,
    awards summed."""
    f = f[f["tech"].astype(str).isin(TECHS)].copy()
    f["tech"] = f["tech"].astype(str)
    f["train"] = _trains(f["unit"].astype(str), f["tech"])
    f["code"] = f["state"].astype(str).map(CODE).fillna(0).astype("int8")
    on = f["code"] >= 3
    f["run"] = np.where(on, f["lsl"], np.nan)
    f["hot_run"] = np.where(on, f["hot_start"], np.nan)
    f["dl"] = f["dam_lsl"].where(f["dam_lsl"] > 0)
    awd = f["award"].fillna(0) > 0.5
    f["aw_lsl"] = f["dl"].where(awd)                        # the awarded configuration's DAM LSL,
    f["aw_mg"] = f["mingen"].where(awd)                     # minimum-energy offer and hot start (make-whole)
    f["aw_hot"] = f["hot_start"].where(awd)
    f["up"] = np.where(on, (f["out"] - f["lsl"]).clip(lower=0), 0.0)     # output above LSL
    f["head"] = np.where(on, (f["hsl"] - f["lsl"]).clip(lower=0), np.nan)
    if "sp" not in f:
        f["sp"] = None
    g = f.groupby(["train", "date", "he"], sort=True)
    h = g.agg(tech=("tech", "first"), code=("code", "max"), da_node=("da_node", "first"), award=("award", "sum"),
              run=("run", "max"), dl=("dl", "min"), mingen=("mingen", "min"), hot=("hot_start", "min"),
              hot_run=("hot_run", "min"), aw_lsl=("aw_lsl", "max"), aw_mg=("aw_mg", "min"), aw_hot=("aw_hot", "min"),
              up=("up", "sum"), head=("head", "max"), sp=("sp", "first"))
    return h.reset_index()


def outage_like(code):
    """code with each outage-like non-running spell's offline-available hours set to outage (a copy):
    a spell that is mostly outage, or has fewer than OFF_MIN_H offline-available hours, around an
    outage hour.  The site-wide rule (pipeline/groups.py rewrite_outages, decisions.py): a unit that
    goes OFF for a few hours and then on outage for weeks went on maintenance, it did not shut on
    price.  An economic shutdown with a shorter outage slotted inside it still counts."""
    c = code.copy()
    n, k = len(c), 0
    while k < n:
        if c[k] >= 3:
            k += 1
            continue
        j = k
        while j < n and c[j] < 3:
            j += 1
        seg = c[k:j]
        off, out = int((seg == 2).sum()), int((seg == 1).sum())
        if out and (off < OFF_MIN_H or out > off):
            seg[seg == 2] = 1
        k = j
    return c


def off_spells(code):
    """[(start, length, clean)] of off spells: from an offline-available hour after an online
    hour, through offline, outage or no-data hours, to the next online hour (or the end); kept
    when its first OFF_MIN_H hours or more are offline-available.  clean: every hour of it
    offline-available and an online hour ends it (a spell the minimum off time is read from)."""
    out, n, k = [], len(code), 1
    while k < n:
        if code[k] == 2 and code[k - 1] >= 3:
            j = k
            while j < n and code[j] == 2:
                j += 1
            e = j
            while e < n and code[e] <= 2:
                e += 1
            if j - k >= OFF_MIN_H:
                out.append((k, e - k, e == j and e < n))
            k = e
        else:
            k += 1
    return out


def min_off(spells, nd, tech):
    """([nd] each day's minimum off time (hours), [nd] True where it is the default): the 10th
    percentile of the clean spells that ended in the OFF_DAYS days before it, OFF_DEFAULT[tech]
    with fewer than OFF_SPELLS."""
    clean = sorted((s + ln, ln) for s, ln, c in spells if c)
    ends = np.array([e for e, _ in clean], dtype=float)
    lens = np.array([ln for _, ln in clean], dtype=float)
    out, dflt = np.full(nd, OFF_DEFAULT[tech]), np.ones(nd, bool)
    for i in range(nd):
        a, b = np.searchsorted(ends, (i - OFF_DAYS) * 24, side="right"), np.searchsorted(ends, i * 24, side="right")
        if b - a >= OFF_SPELLS:
            out[i], dflt[i] = float(np.percentile(lens[a:b], 10)), False
    return out, dflt


def _windows(lpm, nd):
    """[(start, end, loss per MW, day, slot)]: each day's worst loss window per slot (SLOTS),
    overlaps resolved toward the bigger loss.  lpm: hourly (cost - DA node), NaN unknown,
    padded past the last day."""
    fin = np.isfinite(lpm)
    cs = np.concatenate([[0.0], np.cumsum(np.where(fin, lpm, 0.0))])
    cn = np.concatenate([[0], np.cumsum(~fin)])
    days = np.arange(nd)
    found = []
    for slot, lo, hi in SLOTS:
        best, bs, bl = np.zeros(nd), np.full(nd, -1), np.zeros(nd, int)
        for o in range(lo, hi + 1):
            last = 47 if o >= DA_KNOWN else 23            # the last hour index whose DA price is known
            s = days * 24 + o
            for ln in range(1, min(MAX_OFF, last - o + 1) + 1):
                e = s + ln
                ok = e < len(cs)
                ee = np.where(ok, e, 0)
                v = np.where(ok & (cn[ee] - cn[np.where(ok, s, 0)] == 0), cs[ee] - cs[np.where(ok, s, 0)], -np.inf)
                b = v > best
                best[b], bs[b], bl[b] = v[b], s[b], ln
        found += [(int(bs[i]), int(bs[i] + bl[i] - 1), float(best[i]), i, slot) for i in range(nd) if bs[i] >= 0]
    found.sort()
    kept = []
    for w in found:
        if kept and w[0] <= kept[-1][1]:
            if w[2] > kept[-1][2]:
                kept[-1] = w
            continue
        kept.append(w)
    return kept


def _best_shutdown(cs, cn, s, e, day, m, lsl, hot, inter):
    """(save_max, net_max, start_cost, hours, first hour off) over shutdowns overlapping [s, e]: start at most
    EARLY_H hours before s, at least m and at most MAX_OFF hours long, inside the hours whose DA
    price was known at its start, every hour priced."""
    a = np.arange(max(1, s - EARLY_H), e + 1)[:, None]
    L = np.arange(max(1, math.ceil(m - 1e-9)), MAX_OFF + 1)[None, :]
    b = a + L - 1
    last = day * 24 + np.where(a - day * 24 >= DA_KNOWN, 47, 23)
    ok = (b >= s) & (b <= last) & (b + 1 < len(cs))
    bb, aa = np.where(ok, b + 1, 0), np.where(ok, a, 0)
    ok &= (cn[bb] - cn[aa]) == 0
    if not ok.any():
        return np.nan, np.nan, np.nan, 0, s
    save = np.where(ok, (cs[bb] - cs[aa]) * lsl, -np.inf)
    start = np.where(L <= HOT_H, hot, inter) + 0 * a
    net = save - start
    k = np.unravel_index(np.argmax(net), net.shape)
    return float(save.max()), float(net[k]), float(start[k]), int(L[0, k[1]]), int(a[k[0], 0])


def _mw_given_up(committed, mw_net, aw_hot, code, a, b):
    """The DAM make-whole ($) a shutdown over hours a..b gives up: over each DAM commitment block it
    touches (contiguous committed hours within one operating day), make-whole staying on less
    make-whole without the hours off.  Make-whole = max(0, startup + sum of mw_net) over the block's
    hours online; the startup (the awarded configuration's hot start) counts only when the train was
    off the hour before the block (Protocols 4.6.2.3 (1), (2)) and is online in some hour of it."""
    if b < a:
        return 0.0
    given, i = 0.0, max(0, a - 23)
    while i <= b:
        if not committed[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(committed) and committed[j + 1] and (j + 1) % 24:
            j += 1
        if j >= a:
            su = float(aw_hot[i]) if i > 0 and code[i - 1] < 3 and np.isfinite(aw_hot[i]) else 0.0
            blk = np.arange(i, j + 1)
            keep = (blk < a) | (blk > b)
            full = max(0.0, su + float(mw_net[blk].sum()))
            left = max(0.0, (su if keep.any() else 0.0) + float(mw_net[blk[keep]].sum())) if keep.any() else 0.0
            given += full - left
        i = j + 1
    return given


def build(months, out: Path) -> pd.DataFrame:
    hh = henry_hub(out)
    by_hub, unit_hub = gas_by_hub(out), hub_of()
    per, system, side, rts = [], [], {"st_on": [], "as_mw": [], "ruc": []}, []
    for m in months:
        f = month_file("thermal", m, out)
        if f is None:
            print(f"  {m}: no thermal rows, skipped", flush=True)
            continue
        th = f.groupby(["date", "he"])["out"].sum().rename("thermal")
        u = month_file("units", m, out)
        if u is not None:
            ren = u.groupby(["date", "he", u["tech"].astype(str)])["out"].sum().unstack(fill_value=np.nan)
        else:
            ren = pd.DataFrame(index=th.index, columns=["wind", "solar"], dtype=float)
        hubs = HISTORY_DIR / f"da-hubs-{m}.parquet"
        hub = (pd.read_parquet(hubs).query("point == 'HB_HUBAVG'").set_index(["date", "he"])["price"].rename("hub")
               if hubs.exists() else pd.Series(dtype=float, name="hub"))
        system.append(pd.concat([th, ren.reindex(columns=["wind", "solar"]), hub], axis=1))
        per.append(train_days(f))
        for k, fn in (("st_on", month_status), ("as_mw", month_as), ("ruc", month_ruc)):
            x = fn(m, out)
            if x is not None:
                side[k].append(x)
        r = month_rt(m)
        if r is not None:
            rts.append(r)
        print(f"  {m}: {per[-1]['train'].nunique()} trains", flush=True)
    h = pd.concat(per, ignore_index=True)
    for k, fr in side.items():
        if fr:
            h = h.merge(pd.concat(fr, ignore_index=True), on=["train", "date", "he"], how="left")
        else:
            for c in {"as_mw": ("as_mw", "as_val", "as_rt")}.get(k, (k,)):
                h[c] = np.nan
    if rts:
        h = h.merge(pd.concat(rts, ignore_index=True).drop_duplicates(["sp", "date", "he"]), on=["sp", "date", "he"], how="left")
    else:
        h["rt_node"] = np.nan
    h = h.sort_values(["train", "date", "he"])
    cal = pd.date_range(h["date"].min(), h["date"].max()).strftime("%Y-%m-%d")
    nd, T = len(cal), len(cal) * 24
    dix = {d: i for i, d in enumerate(cal)}
    PAD = 48
    sysh = pd.concat(system).sort_index()
    sysa = np.full((T + PAD, 4), np.nan)
    for (d, he), v in zip(sysh.index, sysh[["hub", "wind", "solar", "thermal"]].to_numpy(float)):
        if str(d) in dix and 1 <= int(he) <= 24:
            sysa[dix[str(d)] * 24 + int(he) - 1] = v
    gas = hh.reindex(pd.date_range(hh.index.min(), pd.Timestamp.today()), method="ffill")
    gas = {d.strftime("%Y-%m-%d"): float(v) for d, v in gas.items()}
    rows = []
    for train, t in h.groupby("train", sort=False):
        tech = t["tech"].iloc[0]
        k = np.array([dix[d] * 24 + he - 1 for d, he in zip(t["date"], t["he"])])

        def arr(col, fill=np.nan, dtype=float):
            a = np.full(T + PAD, fill, dtype=dtype)
            a[k] = t[col].to_numpy(dtype)
            return a
        code = outage_like(arr("code", 0, np.int8))     # maintenance outages are not shutdowns
        price, aw, run, hot_run = arr("da_node"), arr("award"), arr("run"), arr("hot_run")
        st_on = arr("st_on") if t["st_on"].notna().any() else np.full(T + PAD, np.nan)
        as_mw = np.nan_to_num(arr("as_mw"))
        as_val, as_rt = np.nan_to_num(arr("as_val")), arr("as_rt")
        ruc = arr("ruc")
        rt, up, head = arr("rt_node"), arr("up"), arr("head")
        # DAM make-whole by hour: a committed hour (award >= AWARD_LSL x the awarded configuration's DAM
        # LSL while DAM status not on) adds its minimum-energy cost less its DA energy and AS revenue
        aw_l, aw_mg, aw_hot = arr("aw_lsl"), arr("aw_mg"), arr("aw_hot")
        committed = np.isfinite(aw_l) & (aw >= AWARD_LSL * np.nan_to_num(aw_l)) & (st_on == 0)
        mw_net = np.where(committed, np.nan_to_num(aw_mg) * np.nan_to_num(aw_l) - np.nan_to_num(price) * np.nan_to_num(aw_l)
                          - as_val, 0.0)
        dl = t.groupby("date")["dl"].min()
        hotd = t.groupby("date")["hot"].min()
        mgd = t.groupby("date")["mingen"].min()
        # each day's gas cost (run_cost), and the minimum-energy offer carried COST_DAYS for reference
        cost, est = np.full(nd, np.nan), np.zeros(nd, bool)
        offer, last_mg, last_i = np.full(nd, np.nan), None, -10 ** 6
        for i, d in enumerate(cal):
            cost[i], est[i] = run_cost(tech, train, d, by_hub, unit_hub)
            v = mgd.get(d)
            if v is not None and np.isfinite(v):
                last_mg, last_i = float(v), i
            if last_mg is not None and i - last_i <= COST_DAYS:
                offer[i] = last_mg
        cost_h = np.concatenate([np.repeat(cost, 24), np.full(PAD, np.nan)])
        lpm = cost_h - price
        fin = np.isfinite(lpm)
        cs = np.concatenate([[0.0], np.cumsum(np.where(fin, lpm, 0.0))])
        cn = np.concatenate([[0], np.cumsum(~fin)])
        spells = off_spells(code)
        inside = np.zeros(T + PAD, bool)
        for s0, ln, _ in spells:
            inside[s0:s0 + ln] = True
        mo, mo_est = min_off(spells, nd, tech)
        gen = GENERIC_COSTS[tech]
        for s, e, lw, day, slot in _windows(lpm, nd):
            if s < 1:
                continue
            win = slice(s, e + 1)
            # in the decision: online the hour before, or an off spell over the window begun up to EARLY_H before it
            if code[s - 1] >= 3:
                k_in = s - 1
            else:
                early = [s0 for s0, ln, _ in spells if s - EARLY_H <= s0 <= s - 1 and s0 + ln >= s]
                if not early:
                    continue                                # already off well before the window
                k_in = early[0] - 1                         # its last online hour
            if ((code[win] <= 1) & ~inside[win]).any():
                continue                                    # outage or missing data, not a shutdown
            d = cal[day]
            l = run[k_in] if np.isfinite(run[k_in]) else dl.get(d, np.nan)
            if not np.isfinite(l) or l < MIN_LSL:
                continue
            hot = hot_run[k_in] if np.isfinite(hot_run[k_in]) else hotd.get(d, np.nan)
            start_est = not np.isfinite(hot)
            hot = gen[0] if start_est else float(hot)
            inter = hot * gen[1] / gen[0]
            m = float(mo[day])
            save, net, start, off_len, a0 = _best_shutdown(cs, cn, s, e, day, m, l, hot, inter)
            if not np.isfinite(save):
                continue
            shut = [(s0, ln) for s0, ln, _ in spells if s0 <= e and s0 + ln > s and s0 >= s - EARLY_H and ln >= m]
            awh = aw[win] >= AWARD_LSL * l
            stw = st_on[win]
            known = np.isfinite(stw)
            commit = float((awh & known & (stw == 0)).mean()) if known.any() else np.nan
            rw = ruc[win]
            ruc_share = float(np.nanmean(rw)) if np.isfinite(rw).any() else np.nan
            as_share = float((as_mw[win] > 0).mean())
            post = d >= RTC_START
            held = (np.isfinite(ruc_share) and ruc_share >= FORCED) or (not post and as_share >= FORCED)
            off = slice(a0, a0 + off_len)
            given = _mw_given_up(committed, mw_net, aw_hot, code, a0, a0 + off_len - 1)
            as_given = float(as_val[off].sum()) if post else 0.0
            gain = net - given - as_given
            ro = rt[off]
            if np.isfinite(ro).all() and off_len:
                hd = head[k_in] if np.isfinite(head[k_in]) else 0.0
                above = np.where(code[off] >= 3, np.nan_to_num(up[off]), hd)
                ar = as_rt[off]
                gain_rt = (float(np.sum(cost_h[off] - ro)) * l - start - given
                           - (float(np.nansum(ar)) if post else 0.0)
                           - float(np.sum(np.clip(ro - cost_h[off], 0, None) * above)))
            else:
                gain_rt = np.nan
            nh = e - s + 1
            bucket = ("held" if held else "held_mw" if net > 0 and gain <= 0 else "more" if gain > 0
                      else "short" if nh < m else "less")
            position = ("committed" if np.isfinite(commit) and commit >= FORCED else "as" if as_share >= FORCED
                        else "self" if awh.mean() >= FORCED else "none")
            on = code[win] >= 3
            mb, ma = -lpm[max(0, s - MARGIN_H):s], -lpm[e + 1:e + 1 + MARGIN_H]
            rl = run[win][on]
            sy = sysa[win]
            sy = np.nanmean(sy, axis=0) if np.isfinite(sy).any() else np.full(4, np.nan)
            rows.append((train, tech, d, slot, float(cost[day]), bool(est[day]), offer[day], float(l),
                         float(hot), bool(start_est), lw * l, s - day * 24 + 1, nh, m, bool(mo_est[day]),
                         save, net, start, off_len, bucket, commit, float(awh.mean()), as_share, ruc_share,
                         position, given, as_given, gain, gain_rt,
                         float(np.nansum(np.where(mb > 0, mb, 0))), float(np.nansum(np.where(ma > 0, ma, 0))),
                         float(on.mean()), bool(shut), shut[0][0] - day * 24 + 1 if shut else 0, shut[0][1] if shut else 0,
                         float(np.nanmean(rl)) if rl.size and np.isfinite(rl).any() else np.nan,
                         gas.get(d, np.nan), *map(float, sy)))
    x = pd.DataFrame(rows, columns=["train", "tech", "date", "slot", "cost", "cost_est", "offer", "lsl", "hot_start",
                                    "start_est", "loss", "win_from", "win_h", "min_off", "min_off_est", "save_max", "net_max",
                                    "start_cost", "best_off_h", "bucket", "commit_share", "award_share", "as_share",
                                    "ruc_share", "position", "mw_given_up", "as_given_up", "gain", "gain_rt", "before_per_mw", "after_per_mw", "on_share", "shut", "shut_he", "off_h",
                                    "run_lsl", "gas_hh", "hub_win", "wind_win", "solar_win", "thermal_win"])
    dt_ = pd.to_datetime(x["date"])
    x.insert(3, "year", dt_.dt.year.astype("int16"))
    x.insert(4, "month", dt_.dt.month.astype("int8"))
    x.insert(5, "season", dt_.dt.month.map(SEASON))
    x["loss_per_mw"] = x["loss"] / x["lsl"]
    x["start_per_mw"] = x["hot_start"] / x["lsl"]
    x["off_p10"] = x["min_off"]
    x["win_vs_off"] = np.log(x["win_h"] / x["min_off"])
    x["size_ratio"] = x["run_lsl"] / x["lsl"]
    return x


BUCKETS = (("held", "Held on: RUC, or a DAM AS award before RTC+B"),
           ("held_mw", "Held on by the make-whole and AS it would give up"), ("short", "Too short to cycle"),
           ("less", "Losing, less than a restart"), ("more", "Losing more than a restart"))


POSITIONS = ("none", "self", "committed", "as")


def summary(x: pd.DataFrame) -> str:
    lines = ["# Decision table: summary", "",
             f"Version {VERSION}. {len(x):,} train loss windows, {x['train'].nunique()} trains, {x['date'].min()} to {x['date'].max()}.", "",
             "## Windows by year, technology and bucket: count, and share turned off", "",
             "| Year | Tech | Windows | Night | " + " | ".join(b for _, b in BUCKETS) + " | Median loss $/MW | Median window h | Median min off h |",
             "|---|---|---|---|" + "---|" * len(BUCKETS) + "---|---|---|"]
    for (y, t), g in x.groupby(["year", "tech"]):
        cells = []
        for k, _ in BUCKETS:
            b = g[g["bucket"] == k]
            cells.append(f"{len(b):,} ({b['shut'].mean():.0%} off)" if len(b) else "–")
        lines.append(f"| {y} | {t} | {len(g):,} | {(g['slot'] == 'night').mean():.0%} | " + " | ".join(cells)
                     + f" | {g['loss_per_mw'].median():.0f} | {g['win_h'].median():.0f} | {g['min_off'].median():.1f} |")
    lines += ["", "## Where shutting pays (gain > 0, not held), by DAM position: windows, share turned off, share where it also paid at RT", "",
              "| Year | Tech | " + " | ".join(POSITIONS) + " |", "|---|---|" + "---|" * len(POSITIONS)]
    for (y, t), g in x[(x["gain"] > 0) & (x["bucket"] != "held")].groupby(["year", "tech"]):
        cells = []
        for p_ in POSITIONS:
            b = g[g["position"] == p_]
            rt = b["gain_rt"].dropna()
            cells.append(f"{len(b):,} ({b['shut'].mean():.0%} off, {(rt > 0).mean():.0%} at RT)" if len(rt) else
                         f"{len(b):,} ({b['shut'].mean():.0%} off)" if len(b) else "–")
        lines.append(f"| {y} | {t} | " + " | ".join(cells) + " |")
    lines += ["", "## Share of rows on an estimated cost (Henry Hub plus basis where the train's own hub has no price)", "",
              "| Tech | " + " | ".join(str(y) for y in sorted(x["year"].unique())) + " |", "|---|" + "---|" * x["year"].nunique()]
    est = x.groupby(["tech", "year"])["cost_est"].mean().unstack()
    for t in est.index:
        lines.append(f"| {t} | " + " | ".join(f"{v:.0%}" for v in est.loc[t]) + " |")
    lines += ["", "Windows are day-ahead: the DAM node price against the train's gas cost at minimum. RUC is known only "
              "from the 60-day unit files (Dec 2025 on); DAM status and AS from the release files and DAM day files."]
    return "\n".join(lines) + "\n"




def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="start", default="2019-01")
    ap.add_argument("--to", dest="end", default=None, help="last month (default: the latest the 60-day day files cover)")
    ap.add_argument("--out", default="decision-table")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    end = a.end or max(p.name[:7] for p in (UNIT_DATA_DIR / "60d").glob("20*.json.gz"))
    x = build(_months(a.start, end), out)
    x.to_parquet(out / "decision-table.parquet")
    (out / "summary.md").write_text(summary(x))
    print(f"{len(x):,} rows -> {out / 'decision-table.parquet'}")


if __name__ == "__main__":
    main()
