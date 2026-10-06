"""60-Day SCED Disclosure (NP3-965-ER) -> hourly curves and statistics by technology,
plus a per-unit daily summary.

Two curve versions are kept for every unit:
  sced      - "SCED1" curve: as submitted, then extended/truncated by ERCOT to the
              unit's operating limits (what SCED actually dispatched against)
  submitted - "Submitted TPO" curve: the price/quantity pairs the QSE submitted
Both are capped at the unit's HSL for that SCED run (storage: limited to [LSL, HSL]).
"""
import io

import numpy as np
import pandas as pd

from .config import PRICE_GRID, SIXTY_DAY_TECHS, TECH_OF_TYPE
from .curves import accumulate, mw_at_prices, parse_sced_time
from .store import iter_csvs, thresholds_from_curves, _round
from .log import warn

N_SCED_PTS = 35
N_TPO_PTS = 10   # ESR files may carry more; detected from the header
STATS = ["n_online", "hsl", "lsl", "base_point", "output",
         "floor_sced", "floor_submitted", "le0_sced", "le0_submitted",
         "no_offer_hsl", "no_offer_output_schedule"]
# "At the floor" = offered at or below -$249/MWh.  ERCOT's proxy curves place
# minimum output at -$250 and output-schedule MW at -$249.99.
I_FLOOR = int(np.searchsorted(PRICE_GRID, -249))
I_ZERO = int(np.searchsorted(PRICE_GRID, 0))
TECH_INDEX = {t: i for i, t in enumerate(SIXTY_DAY_TECHS)}


def _cols(header, prefix, n_max=60):
    mw, pr = [], []
    for i in range(1, n_max + 1):
        m, p = f"{prefix}-MW{i}", f"{prefix}-Price{i}"
        if m in header and p in header:
            mw.append(m)
            pr.append(p)
    return mw, pr


class _Accumulator:
    def __init__(self):
        T, G = len(SIXTY_DAY_TECHS), PRICE_GRID.size
        self.sced = np.zeros((T * 24, G))
        self.sub = np.zeros((T * 24, G))
        self.stats = np.zeros((T * 24, len(STATS)))
        self.runs = {h: set() for h in range(24)}
        self.dates = []
        self.unit_rows = []
        self.unknown_types = set()

    def add_chunk(self, df: pd.DataFrame, is_esr: bool):
        df.columns = [c.strip() for c in df.columns]
        header = set(df.columns)
        s_mw, s_pr = _cols(header, "SCED1 Curve")
        t_mw, t_pr = _cols(header, "Submitted TPO")

        t = parse_sced_time(df["SCED Time Stamp"])
        hour = t["hour"].values
        self.dates.extend(t["date"].unique().tolist())
        run = (df["SCED Time Stamp"].astype(str) + "|" + df["Repeated Hour Flag"].astype(str)).values
        for h in np.unique(hour):
            self.runs[int(h)].update(np.unique(run[hour == h]).tolist())

        rtype = df["Resource Type"].astype(str).str.strip()
        tech = rtype.map(TECH_OF_TYPE)
        self.unknown_types.update(rtype[tech.isna()].unique().tolist())
        tech = tech.fillna("other").map(TECH_INDEX).values.astype(int)

        status = df["Telemetered Resource Status"].astype(str).str.strip()
        online = status.str.startswith("ON").values
        hsl = df["HSL"].astype(float).fillna(0).values
        lsl = df["LSL"].astype(float).fillna(0).values
        bp = df["Base Point"].astype(float).fillna(0).values
        out = df["Telemetered Net Output"].astype(float).fillna(0).values
        hsl_eff = np.where(online, hsl, 0.0)
        lsl_eff = np.where(online, lsl, 0.0)

        left = "first" if is_esr else "zero"
        sced = mw_at_prices(df[s_pr].astype(float).values, df[s_mw].astype(float).values, PRICE_GRID, left)
        sub = mw_at_prices(df[t_pr].astype(float).values, df[t_mw].astype(float).values, PRICE_GRID, left)
        lo = lsl_eff[:, None] if is_esr else 0.0
        sced = np.clip(sced, lo, hsl_eff[:, None]) if is_esr else np.minimum(np.maximum(sced, 0), hsl_eff[:, None])
        sub = np.clip(sub, lo, hsl_eff[:, None]) if is_esr else np.minimum(np.maximum(sub, 0), hsl_eff[:, None])

        key = tech * 24 + hour
        accumulate(self.sced, key, sced)
        accumulate(self.sub, key, sub)
        no_offer = online & np.isnan(df[t_mw[0]].astype(float).values) if t_mw else online
        os_ = df["Output Schedule"].astype(float).fillna(0).values if "Output Schedule" in header else np.zeros(len(df))
        st = np.column_stack([
            online.astype(float), hsl_eff, lsl_eff, np.where(online, bp, 0), np.where(online, out, 0),
            sced[:, I_FLOOR], sub[:, I_FLOOR], sced[:, I_ZERO], sub[:, I_ZERO],
            np.where(no_offer, hsl_eff, 0), np.where(no_offer, os_, 0),
        ])
        accumulate(self.stats, key, st)

        # per-unit rows (online intervals only)
        tp = df[t_pr].astype(float).values
        first_sub_price = tp[:, 0] if tp.shape[1] else np.full(len(df), np.nan)
        pinned = (lsl_eff > 0) & (bp <= lsl_eff + np.maximum(1.0, 0.01 * lsl_eff))
        u = pd.DataFrame({
            "unit": df["Resource Name"].astype(str).str.strip().values,
            "type": rtype.values,
            "tech": np.array(SIXTY_DAY_TECHS)[tech],
            "online": online,
            "hsl": hsl_eff, "lsl": lsl_eff, "bp": bp, "out": out,
            "pinned": pinned, "floor_sced": sced[:, I_FLOOR], "le0_sced": sced[:, I_ZERO],
            "le0_sub": sub[:, I_ZERO], "first_sub_price": first_sub_price,
            "no_offer": no_offer,
        })
        self.unit_rows.append(u[u["online"]])

    def finish(self):
        T = len(SIXTY_DAY_TECHS)
        runs = np.array([len(self.runs[h]) for h in range(24)], dtype=float)
        div = np.tile(np.where(runs > 0, runs, np.nan), T)[:, None]
        sced = (self.sced / div).reshape(T, 24, -1)
        sub = (self.sub / div).reshape(T, 24, -1)
        stats = (self.stats / div).reshape(T, 24, -1)

        units = pd.concat(self.unit_rows, ignore_index=True)
        n_runs = max(runs.sum(), 1)
        g = units.groupby(["unit", "type", "tech"])
        ut = pd.DataFrame({
            "hours_online": g.size() / n_runs * 24,
            "hsl": g["hsl"].mean(), "lsl": g["lsl"].mean(),
            "base_point": g["bp"].mean(), "output": g["out"].mean(),
            "pinned_share": g["pinned"].mean(),
            "floor_mw": g["floor_sced"].mean(), "le0_sced": g["le0_sced"].mean(),
            "le0_submitted": g["le0_sub"].mean(),
            "min_sub_price": g["first_sub_price"].min(),
            "avg_sub_price": g["first_sub_price"].mean(),
            "no_offer_share": g["no_offer"].mean(),
        }).reset_index()
        return runs, sced, sub, stats, ut


def parse_60day_zip(blob: bytes, chunksize: int = 40000):
    acc = _Accumulator()
    found = False
    for name, data in iter_csvs(blob, "x.zip"):
        if name.startswith("60d_SCED_Gen_Resource_Data"):
            is_esr = False
        elif name.startswith("60d_ESR_Data_in_SCED"):
            is_esr = True
        else:
            continue
        found = True
        for chunk in pd.read_csv(io.BytesIO(data), chunksize=chunksize, low_memory=False):
            acc.add_chunk(chunk, is_esr)
    if not found:
        raise ValueError("No generation/ESR resource file found in 60-day zip")

    date = max(set(acc.dates), key=acc.dates.count)
    runs, sced, sub, stats, ut = acc.finish()
    if acc.unknown_types:
        warn(f"Unmapped resource types grouped as 'other': {sorted(acc.unknown_types)}")

    def r1(x):
        return None if pd.isna(x) else round(float(x), 1)

    day = {
        "date": date,
        "source": "60d",
        "runs": runs.astype(int).tolist(),
        "stat_names": STATS,
        "curves": {tk: [_round(row) for row in sced[i]] for i, tk in enumerate(SIXTY_DAY_TECHS)},
        "submitted": {tk: [_round(row) for row in sub[i]] for i, tk in enumerate(SIXTY_DAY_TECHS)},
        "stats": {tk: [[r1(x) for x in row] for row in stats[i]] for i, tk in enumerate(SIXTY_DAY_TECHS)},
        "units": {
            "columns": list(ut.columns),
            "rows": [[(r1(v) if isinstance(v, (float, np.floating)) else v) for v in row]
                     for row in ut.itertuples(index=False)],
        },
    }
    summary = {
        "curves": {tk: [_round(r) for r in thresholds_from_curves(sced[i])] for i, tk in enumerate(SIXTY_DAY_TECHS)},
        "submitted": {tk: [_round(r) for r in thresholds_from_curves(sub[i])] for i, tk in enumerate(SIXTY_DAY_TECHS)},
        "stats": {tk: [[r1(x) for x in row] for row in stats[i]] for i, tk in enumerate(SIXTY_DAY_TECHS)},
    }
    return date, day, summary
