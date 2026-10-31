"""Decision table on actuals: every thermal train's stay-on decision through its day-ahead loss
window, from 2019 on, for the analysis track (fitting the decision model, and asking whether
units changed behaviour or only met their turn-off triggers more often).

    python -m pipeline.decision_table [--from 2019-01] [--to 2026-08] [--out decision-table]

Run monthly by the Goal page workflow (pipeline/goal.py), which reads the table.

Reads the monthly thermal and renewable history (pipeline/history.py, the `history` release, in
HISTORY_DIR) and, for months the release does not hold yet, builds the same rows from the
per-unit 60-day day files (UNIT_DATA_DIR/60d) and the DAM day files (data/dam), cached as
<out>/months/.  Henry Hub daily prices come from the site's EIA series (henry_hub), else EIA's
public history file (no key), cached as <out>/henry-hub.csv; the Houston Ship Channel and Waha
prices from the private hub files (pipeline/private.py), and each unit's hub from
data/fuel_hubs.json.gz.

One row per train and decision block with a loss window: a block runs from HE7 of the day to
HE6 of the next, so the night's cheap hours and an evening shutdown ahead of them fall in the
same block.  A row needs the train online at the block's first hour and available through the
block: no outage or missing hour, except inside an off spell that began with OUT_MIN_H or more
offline hours (a shutdown the unit then used for maintenance still counts as a decision).  Combined-cycle configurations are merged into their train (as
pipeline/decisions.py does): online when any configuration is, the smallest DAM LSL, awards
summed.

  train, tech, date, year, month, season
  lsl          the train's smallest DAM LSL that day (MW; days below MIN_LSL are left out)
  cost         the cost of running at minimum ($/MWh): for gas units the gas cost, GAS_HR x the
               train's own hub price (gas_by_hub), with Henry Hub standing in (cost_est true)
               before the hub's series starts; for coal the generic cost (cost_est true).  Not
               the DAM minimum-energy offer, which units often set to win or avoid commitment
               rather than at cost
  offer        the DAM minimum-energy offer ($/MWh), for reference: the day's own, else its
               latest within COST_DAYS days (blank without one; coal submits none)
  hot_start    hot start-up offer ($), per MW of LSL as start_per_mw
  loss         worst contiguous window of (cost - DAM node price) x LSL over the day ($,
               pipeline.decisions._window); loss_per_mw = loss / LSL
  win_from, win_h   the window's first hour ending, counted from the block day's HE1 (7 to 30;
               25 and later are the next morning), and its length (hours)
  before_per_mw, after_per_mw   the margin earned in the day's hours before and after the
               window ($ per MW of LSL; positive hours only)
  award_share  share of the window's hours with a DAM energy award of at least 0.9 x LSL
  off_p10      the train's 10th-percentile off spell (hours, spells of OUT_MIN_H or more) in
               the same calendar year; win_vs_off = log(win_h / off_p10)
  on_share     share of the window's hours the train was online (the outcome)
  shut, shut_he, off_h   an off spell of OUT_MIN_H hours or more starting inside the block, the
               hour ending it started (counted as win_from) and its length in hours (it may run
               past the block)
  run_lsl      mean LSL of the configuration actually running, over the window's online hours;
               size_ratio = run_lsl / lsl (CC sizing: above 1 when a bigger configuration ran)
  gas_hh       Henry Hub spot price, latest on or before the day ($/MMBtu)
  hub_win      mean DAM hub average price over the window ($/MWh)
  wind_win, solar_win, thermal_win   system wind, solar and thermal output, mean MW over the
               window's hours

Writes <out>/decision-table.parquet and <out>/summary.md (rows by year and technology, and the
share of windows ridden through by loss band and year).
"""
import argparse
import io
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR, GENERIC_COSTS, HISTORY_DIR, UNIT_DATA_DIR
from .decisions import COST_DAYS, OUT_MIN_H, RANK, _window
from .gas import monthly_basis
from .gascost import HEAT_RATE as GAS_HR
from .intraday import train_of

TECHS = ("coal", "combined_cycle", "gas_steam")      # the units judged on a daily stay-on loss
HH_URL = "https://www.eia.gov/dnav/ng/hist_xls/RNGWHHDd.xls"
AWARD_LSL = 0.9
MIN_LSL = 5.0       # MW: a smaller DAM LSL is a placeholder, not the unit's minimum
GAS_TOLERANCE = 7   # days a hub price carries over a gap in its series before Henry Hub stands in
BLOCK_START = 6     # hour index (HE7) a decision block starts: HE7 to HE6 the next day, so a night's
                    # cheap hours and the evening shutdown ahead of them fall in one block
SEASON = {12: "winter", 1: "winter", 2: "winter", 3: "spring", 4: "spring", 5: "spring",
          6: "summer", 7: "summer", 8: "summer", 9: "fall", 10: "fall", 11: "fall"}
CODE = {"-": 0, "o": 1, "0": 2, "m": 3, "a": 4}     # same order as RANK


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
    """($/MWh, estimated) of running at minimum on `date`: gas units at GAS_HR x the train's own
    hub price (Houston Ship Channel without one), Henry Hub standing in (estimated) where the hub
    has no price, plus the monthly basis for Ship Channel (gas_by_hub); coal, and any unit without
    a gas price, at the generic cost (estimated)."""
    if tech in GAS_HR:
        hub = hubs.get(train, "hsc")
        p = gas.get(hub, {}).get(date)
        if p is not None:
            return GAS_HR[tech] * p, False
        p = gas.get(f"{hub}_fill", {}).get(date)
        if p is None:
            p = gas.get("hh", {}).get(date)
        if p is not None:
            return GAS_HR[tech] * p, True
    return float(GENERIC_COSTS[tech][3]), True


def train_days(f: pd.DataFrame) -> pd.DataFrame:
    """The month's thermal rows merged to one row per train, day and hour."""
    f = f[f["tech"].astype(str).isin(TECHS)].copy()
    f["tech"] = f["tech"].astype(str)
    f["train"] = [train_of(u) if t == "combined_cycle" else u for u, t in zip(f["unit"].astype(str), f["tech"])]
    f["code"] = f["state"].astype(str).map(CODE).fillna(0).astype("int8")
    f["run"] = np.where(f["code"] >= 3, f["lsl"], np.nan)
    f["dl"] = f["dam_lsl"].where(f["dam_lsl"] > 0)
    g = f.groupby(["train", "date", "he"], sort=True)
    h = g.agg(tech=("tech", "first"), code=("code", "max"), da_node=("da_node", "first"), award=("award", "sum"),
              run=("run", "max"), out=("out", "sum"), dl=("dl", "min"), mingen=("mingen", "min"), hot=("hot_start", "min"))
    return h.reset_index()


def _spells(codes):
    """[(start index, length)] of off spells (offline, outage or no data after an online hour)
    of OUT_MIN_H hours or more that start with an offline hour."""
    out, n, k = [], len(codes), 1
    while k < n:
        if codes[k] == 2 and codes[k - 1] >= 3:
            j = k
            while j < n and codes[j] <= 2:
                j += 1
            if j - k >= OUT_MIN_H:
                out.append((k, j - k))
            k = j
        else:
            k += 1
    return out


def _excused(codes):
    """Outage and no-data hours that sit inside an off spell begun with OUT_MIN_H or more offline
    hours: a shutdown the unit then used for an outage, which still counts as a decision
    (pipeline/decisions.py treats other outages as outages throughout)."""
    ok, n, k = np.zeros(len(codes), bool), len(codes), 1
    while k < n:
        if codes[k] == 2 and codes[k - 1] >= 3:
            j = k
            while j < n and codes[j] == 2:
                j += 1
            e = j
            while e < n and codes[e] <= 2:
                e += 1
            if j - k >= OUT_MIN_H:
                ok[k:e] = True
            k = e
        else:
            k += 1
    return ok


def build(months, out: Path) -> pd.DataFrame:
    hh = henry_hub(out)
    by_hub, unit_hub = gas_by_hub(out), hub_of()
    per, system = [], []
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
        print(f"  {m}: {per[-1]['train'].nunique()} trains", flush=True)
    h = pd.concat(per, ignore_index=True).sort_values(["train", "date", "he"])
    sysh = pd.concat(system).sort_index()
    sysh.index = pd.MultiIndex.from_arrays([sysh.index.get_level_values(0).astype(str),
                                            sysh.index.get_level_values(1).astype(int)])
    cols = ["hub", "wind", "solar", "thermal"]
    sysd = {d: g.droplevel(0).reindex(range(1, 25))[cols].to_numpy(float) for d, g in sysh.groupby(level=0)}
    gas = hh.reindex(pd.date_range(hh.index.min(), pd.Timestamp.today()), method="ffill")
    gas = {d.strftime("%Y-%m-%d"): float(v) for d, v in gas.items()}
    rows = []
    for train, t in h.groupby("train", sort=False):
        tech = t["tech"].iloc[0]
        dates = t["date"].unique()
        full = t.groupby("date").size()
        t = t[t["date"].isin(full[full == 24].index)]
        dates = t["date"].unique()
        if not len(dates):
            continue
        n = len(dates)
        code = t["code"].to_numpy().reshape(n, 24)
        flat = code.ravel()
        # consecutive days only for the hour before the window and spells across midnight
        di = (pd.to_datetime(dates) - pd.Timestamp("2019-01-01")).days.to_numpy()
        spp = t["da_node"].to_numpy(float).reshape(n, 24)
        aw = t["award"].to_numpy(float).reshape(n, 24)
        run = t["run"].to_numpy(float).reshape(n, 24)
        dl = t["dl"].to_numpy(float).reshape(n, 24)
        mg = t["mingen"].to_numpy(float).reshape(n, 24)
        hot = t["hot"].to_numpy(float).reshape(n, 24)
        spells = _spells(flat)
        start_at = {s: ln for s, ln in spells}
        years = pd.to_datetime(dates).year.to_numpy()
        p10 = {}
        for s, ln in spells:
            p10.setdefault(years[s // 24], []).append(ln)
        p10 = {y: float(np.percentile(v, 10)) for y, v in p10.items()}
        # each day's cost (run_cost), LSL and, for reference, minimum-energy offer: the day's
        # own, else its latest within COST_DAYS days
        cost, est, lsl, offer = np.full(n, np.nan), np.zeros(n, bool), np.full(n, np.nan), np.full(n, np.nan)
        last_mg, last_mg_day = None, -10 ** 6
        for i in range(n):
            lsl[i] = np.nanmin(dl[i]) if np.isfinite(dl[i]).any() else np.nan
            if np.isfinite(mg[i]).any():
                last_mg, last_mg_day = float(np.nanmin(mg[i])), di[i]
            if last_mg is not None and di[i] - last_mg_day <= COST_DAYS:
                offer[i] = last_mg
            cost[i], est[i] = run_cost(tech, train, dates[i], by_hub, unit_hub)
        excused = _excused(flat)
        for i, d in enumerate(dates[:-1]):
            if di[i + 1] != di[i] + 1:
                continue
            l = lsl[i]
            if not np.isfinite(l) or l < MIN_LSL:
                continue
            kb = i * 24 + BLOCK_START                  # flat index of the block's first hour
            blk = slice(kb, kb + 24)
            c = flat[blk]
            if ((c <= 1) & ~excused[blk]).any():       # an outage or missing hour: not available
                continue
            if c[0] < 3:                               # not online when the block starts
                continue
            two = lambda a: np.concatenate([a[i, BLOCK_START:], a[i + 1, :BLOCK_START]])   # noqa: E731
            price = two(spp)
            if not np.isfinite(price).all():
                continue
            hc = np.concatenate([np.full(24 - BLOCK_START, cost[i]), np.full(BLOCK_START, cost[i + 1])])
            margin = (price - hc) * l
            loss, bs, nh = _window(-margin)
            if nh <= 0:
                continue
            win = slice(bs, bs + nh)
            on = c[win] >= 3
            shut = [(k - kb, start_at[k]) for k in range(kb + 1, kb + 24) if k in start_at]
            rl = two(run)[win][on]
            sy = np.vstack([sysd.get(d, np.full((24, 4), np.nan))[BLOCK_START:],
                            sysd.get(dates[i + 1], np.full((24, 4), np.nan))[:BLOCK_START]])[win]
            sy = np.nanmean(sy, axis=0) if np.isfinite(sy).any() else np.full(4, np.nan)
            mp = margin / l
            rows.append((train, tech, d, cost[i], bool(est[i]), offer[i], l, float(np.nanmin(hot[i])) if np.isfinite(hot[i]).any() else np.nan,
                         loss, BLOCK_START + bs + 1, nh, float(mp[:bs][mp[:bs] > 0].sum()), float(mp[bs + nh:][mp[bs + nh:] > 0].sum()),
                         float((two(aw)[win] >= AWARD_LSL * l).mean()), p10.get(years[i], np.nan),
                         float(on.mean()), bool(shut), BLOCK_START + shut[0][0] + 1 if shut else 0, shut[0][1] if shut else 0,
                         float(np.nanmean(rl)) if rl.size and np.isfinite(rl).any() else np.nan,
                         gas.get(d, np.nan), *map(float, sy)))
    x = pd.DataFrame(rows, columns=["train", "tech", "date", "cost", "cost_est", "offer", "lsl", "hot_start", "loss", "win_from",
                                    "win_h", "before_per_mw", "after_per_mw", "award_share", "off_p10", "on_share", "shut",
                                    "shut_he", "off_h", "run_lsl", "gas_hh", "hub_win", "wind_win", "solar_win", "thermal_win"])
    dt_ = pd.to_datetime(x["date"])
    x.insert(3, "year", dt_.dt.year.astype("int16"))
    x.insert(4, "month", dt_.dt.month.astype("int8"))
    x.insert(5, "season", dt_.dt.month.map(SEASON))
    x["loss_per_mw"] = x["loss"] / x["lsl"]
    x["start_per_mw"] = x["hot_start"] / x["lsl"]
    x["win_vs_off"] = np.log(x["win_h"] / x["off_p10"])
    x["size_ratio"] = x["run_lsl"] / x["lsl"]
    return x


def summary(x: pd.DataFrame) -> str:
    lines = ["# Decision table: summary", "",
             f"{len(x):,} train decision blocks with a loss window, {x['train'].nunique()} trains, {x['date'].min()} to {x['date'].max()}.", "",
             "## Rows and outcomes by year and technology", "",
             "| Year | Tech | Rows | Trains | Rode through (share of window hours online) | Shut down | Median loss $/MW | Median window h | DAM award covers window | Median CC size ratio |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for (y, t), g in x.groupby(["year", "tech"]):
        lines.append(f"| {y} | {t} | {len(g):,} | {g['train'].nunique()} | {g['on_share'].mean():.0%} | {g['shut'].mean():.0%} | "
                     f"{g['loss_per_mw'].median():.0f} | {g['win_h'].median():.0f} | {(g['award_share'] >= 0.5).mean():.0%} | "
                     + (f"{g['size_ratio'].median():.2f} |" if t == "combined_cycle" else "– |"))
    bands = [0, 25, 50, 100, 200, 400, np.inf]
    lab = ["0–25", "25–50", "50–100", "100–200", "200–400", "400+"]
    na = x[x["award_share"] < 0.5]
    for t in TECHS:
        g = na[na["tech"] == t]
        if g.empty:
            continue
        tab = (g.assign(band=pd.cut(g["loss_per_mw"], bands, labels=lab, right=False))
               .pivot_table(index="band", columns="year", values="on_share", aggfunc="mean", observed=False))
        cnt = (g.assign(band=pd.cut(g["loss_per_mw"], bands, labels=lab, right=False))
               .pivot_table(index="band", columns="year", values="on_share", aggfunc="size", observed=False))
        lines += ["", f"## {t}: share of the window ridden through, by loss per MW of LSL and year (no DAM award over the window)", "",
                  "| Loss $/MW | " + " | ".join(str(c) for c in tab.columns) + " |", "|---|" + "---|" * len(tab.columns)]
        for b in tab.index:
            lines.append(f"| {b} | " + " | ".join("–" if not cnt.loc[b, c] or pd.isna(tab.loc[b, c]) else f"{tab.loc[b, c]:.0%} ({int(cnt.loc[b, c])})"
                                                 for c in tab.columns) + " |")
    lines += ["", "## Share of rows on an estimated cost (Henry Hub before the train's own hub series starts; coal generic)", "",
              "| Tech | " + " | ".join(str(y) for y in sorted(x["year"].unique())) + " |", "|---|" + "---|" * x["year"].nunique()]
    est = x.groupby(["tech", "year"])["cost_est"].mean().unstack()
    for t in est.index:
        lines.append(f"| {t} | " + " | ".join(f"{v:.0%}" for v in est.loc[t]) + " |")
    lines += ["", "Coal's loss rests on the generic cost, and its shutdowns are mostly",
              "declared as outages straight away (left out here as unavailable): coal is better judged on the seasonal rule."]
    lines += ["", "Windows are day-ahead: the DAM node price against the unit's gas cost at minimum (run_cost), not its minimum-energy offer.",
              "Blocks run HE7 to HE6 the next day; the predictor instead takes the calendar day and carries a window reaching HE24 into the next morning."]
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
