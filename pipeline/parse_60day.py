"""60-Day SCED Disclosure (NP3-965-ER) -> hourly curves and statistics by technology,
plus a per-unit daily summary.

Two curve versions are kept for every unit:
  sced      - "SCED1" curve: as submitted, then extended/truncated by ERCOT to the
              unit's operating limits (what SCED actually dispatched against)
  submitted - "Submitted TPO" curve: the price/quantity pairs the QSE submitted
Both are capped at the unit's HSL for that SCED run (storage: limited to [LSL, HSL]).

Also builds the full-fidelity per-unit day file (status, limits and submitted curve of every
unit at every SCED run, as change-of-value events); schema in pipeline/units.py.

Status statistics (appended to STATS): n_onruc/hsl_onruc = units with status ONRUC (these are
also counted as online), n_off/hsl_off = status codes starting "OFF", n_out/hsl_out = "OUT".
Their HSL is the telemetered HSL as reported, whatever the status.
"""
import io

import numpy as np
import pandas as pd

from .config import PRICE_GRID, SIXTY_DAY_TECHS, TECH_OF_TYPE
from .curves import accumulate, mw_at_prices, parse_sced_time
from .store import iter_csvs, thresholds_from_curves, _round
from .units import build_unit_day
from .log import warn

N_SCED_PTS = 35
N_TPO_PTS = 10   # ESR files may carry more; detected from the header
STATS = ["n_online", "hsl", "lsl", "base_point", "output",
         "floor_sced", "floor_submitted", "le0_sced", "le0_submitted",
         "no_offer_hsl", "no_offer_output_schedule",
         # appended later: days processed before these existed lack them (read by name)
         "n_onruc", "n_off", "n_out", "hsl_onruc", "hsl_off", "hsl_out"]
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
        self.run_keys = {}      # run key -> (timestamp string, repeated-hour flag)
        self.unit_cols = []     # per-chunk arrays for the per-unit day file

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
        for k in np.unique(run):
            if k not in self.run_keys:
                ts, flag = k.rsplit("|", 1)
                self.run_keys[k] = (ts.strip(), flag.strip().upper() == "Y")

        rtype = df["Resource Type"].astype(str).str.strip()
        tech = rtype.map(TECH_OF_TYPE)
        self.unknown_types.update(rtype[tech.isna()].unique().tolist())
        tech = tech.fillna("other").map(TECH_INDEX).values.astype(int)

        # pandas 3 keeps missing values through astype(str): a blank status becomes "" (unknown)
        status = df["Telemetered Resource Status"].fillna("").astype(str).str.strip()
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
        has_os = "Output Schedule" in header
        os_raw = df["Output Schedule"].astype(float).values if has_os else np.full(len(df), np.nan)
        os_ = np.nan_to_num(os_raw)
        onruc = (status == "ONRUC").values
        off = status.str.startswith("OFF").values
        out_ = (status == "OUT").values
        st = np.column_stack([
            online.astype(float), hsl_eff, lsl_eff, np.where(online, bp, 0), np.where(online, out, 0),
            sced[:, I_FLOOR], sub[:, I_FLOOR], sced[:, I_ZERO], sub[:, I_ZERO],
            np.where(no_offer, hsl_eff, 0), np.where(no_offer, os_, 0),
            onruc.astype(float), off.astype(float), out_.astype(float),
            np.where(onruc, hsl, 0), np.where(off, hsl, 0), np.where(out_, hsl, 0),
        ])
        accumulate(self.stats, key, st)

        # every row, for the per-unit day file
        tp = df[t_pr].astype(float).values
        n = len(df)
        self.unit_cols.append({
            "run": run, "unit": df["Resource Name"].astype(str).str.strip().values,
            "type": rtype.values, "tech": np.array(SIXTY_DAY_TECHS)[tech], "status": status.values,
            "hsl": df["HSL"].astype(float).values, "lsl": df["LSL"].astype(float).values,
            "bp": df["Base Point"].astype(float).values, "out": df["Telemetered Net Output"].astype(float).values,
            "hour": hour, "oschd": os_raw if has_os else None,
            "tpo_p": tp if tp.shape[1] else np.full((n, 1), np.nan),
            "tpo_m": df[t_mw].astype(float).values if t_mw else np.full((n, 1), np.nan),
        })

        # per-unit rows (online intervals only)
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

    def unit_day(self, date: str):
        """Per-unit COV day file (see pipeline/units.py) and its number of events."""
        day0 = pd.Timestamp(date)
        recs = []
        for k, (ts, rep) in self.run_keys.items():
            t = pd.to_datetime(ts, format="mixed")
            minutes = int((t.normalize() - day0).days) * 1440 + t.hour * 60 + t.minute
            # the repeated (second) 01:xx hour sorts after the first one and before 02:00
            order = (t - day0).total_seconds() + (3600 if rep else 0)
            recs.append((k, minutes, rep, order))
        run_sort = pd.DataFrame(recs, columns=["key", "minutes", "repeat", "order"])
        width = max(c["tpo_p"].shape[1] for c in self.unit_cols)

        def pad(a):
            return a if a.shape[1] == width else np.hstack([a, np.full((len(a), width - a.shape[1]), np.nan)])

        rows = {}
        for name in ("run", "unit", "type", "tech", "status", "hsl", "lsl", "bp", "out", "hour"):
            rows[name] = np.concatenate([c[name] for c in self.unit_cols])
        rows["tpo_p"] = np.vstack([pad(c["tpo_p"]) for c in self.unit_cols])
        rows["tpo_m"] = np.vstack([pad(c["tpo_m"]) for c in self.unit_cols])
        if any(c["oschd"] is not None for c in self.unit_cols):
            rows["oschd"] = np.concatenate([c["oschd"] if c["oschd"] is not None else np.full(len(c["run"]), np.nan)
                                            for c in self.unit_cols])
        return build_unit_day(date, run_sort, rows)


def parse_60day_zip(blob: bytes, chunksize: int = 40000):
    """-> (date, day file, summary entry, (unit day file, number of COV events))"""
    acc = _Accumulator()
    found = False
    for name, data in iter_csvs(blob, "x.zip"):
        if name.lower().startswith("60d_sced_gen_resource_data"):
            is_esr = False
        elif name.lower().startswith("60d_esr_data_in_sced"):
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
        "stat_names": STATS,
    }
    return date, day, summary, acc.unit_day(date)
