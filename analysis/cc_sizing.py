"""Combined-cycle sizing on actuals: the size a train runs at once it is on, kept apart from the
on/off decision, for the analysis track.

    python analysis/cc_sizing.py [--from 2019-01] [--to 2026-08] [--out cc-sizing]
        [--table decision-table/decision-table.parquet]

The size of an online train is its online LSL (the running configuration's LSL), read from the
same monthly thermal rows as pipeline/decision_table.py (the history release in HISTORY_DIR, else
the 60-day day files).  The size step is a table: each train's mean online LSL in each day-ahead
hub price band (BANDS, HB_HUBAVG), over the DAYS days up to a point, from bands with at least
MIN_HOURS online hours; a band with fewer takes the train's mean over all its online hours.  The
mean is the expected size, what a committed minimum needs, and the table has nothing tuned.

Out-of-sample test, one month at a time from the first month with DAYS days of hours before it: every rule sees only hours up to LAG days before the
month starts and predicts the online LSL of every train online in the month.  The error is summed
over trains per hour (MW, positive = predicted too large); bias is its mean, MAE the mean of its
absolute value, by price band, weighted by hours over the months.  The rules against the table:

  band median    the same table with medians
  one mean       one mean per train, all hours
  q25, q10       one percentile per train (q10 is the form of the predictor's cheap-hour size,
                 Context.cc_min_lsl_at, there over 120 days of 60-day data)

--table adds to the decision table's combined-cycle rows (in place):

  size_band_mean   the table's size for the band of the window's mean hub price (hub_win), from
                   the hours up to LAG days before the block's month
  size_err         run_lsl - size_band_mean (MW; positive = the train ran larger)

Writes <out>/oos.csv (bias and MAE per month, rule and band) and <out>/summary.md.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.decision_table import _months, month_file, train_days  # noqa: E402
from pipeline.config import DATA_DIR, HISTORY_DIR, UNIT_DATA_DIR  # noqa: E402
from pipeline.store import read_json_gz  # noqa: E402

BANDS = [-np.inf, 10, 20, 30, 50, np.inf]     # $/MWh, day-ahead hub; the first is the predictor's cheap hour
LABELS = ["<=$10", "$10-20", "$20-30", "$30-50", ">$50"]
DAYS = 365
MIN_HOURS = 24
LAG = 31            # days before a month's start that its sizes are taken up to (an as-of lag)
MIN_TEST_HOURS = 10     # hours in a band and month for it to be scored


def hub_hours(month: str) -> pd.Series:
    """HB_HUBAVG day-ahead price by (date, he): the history release, else data/dam_hubs.json.gz."""
    p = HISTORY_DIR / f"da-hubs-{month}.parquet"
    if p.exists():
        h = pd.read_parquet(p).query("point == 'HB_HUBAVG'")
        return h.set_index(["date", "he"])["price"].rename("hub")
    days = (read_json_gz(DATA_DIR / "dam_hubs.json.gz", default=None) or {"days": {}})["days"]
    rows = [(d, he + 1, v) for d, pts in days.items() if d[:7] == month
            for he, v in enumerate((pts.get("HB_HUBAVG") or [])[:24]) if v is not None]
    return pd.DataFrame(rows, columns=["date", "he", "hub"]).set_index(["date", "he"])["hub"]


def panel(months, out: Path) -> pd.DataFrame:
    """One row per combined-cycle train and hour online with an LSL: train, date, he, lsl, hub, band."""
    parts = []
    for m in months:
        f = month_file("thermal", m, out)
        if f is None:
            print(f"  {m}: no thermal rows, skipped", flush=True)
            continue
        f = f[f["tech"].astype(str) == "combined_cycle"]
        h = train_days(f)
        h = h[(h["code"] >= 3) & (h["run"] > 0)][["train", "date", "he", "run"]].rename(columns={"run": "lsl"})
        h = h.join(hub_hours(m), on=["date", "he"])
        parts.append(h.dropna(subset=["hub"]))
        print(f"  {m}: {h['train'].nunique()} trains online", flush=True)
    p = pd.concat(parts, ignore_index=True)
    p["day"] = pd.to_datetime(p["date"])
    p["band"] = pd.cut(p["hub"], BANDS, labels=False)
    return p


def sizes(p: pd.DataFrame, end: pd.Timestamp, agg="mean") -> tuple:
    """(by train and band, by train) over the DAYS days up to `end`."""
    w = p[(p["day"] > end - pd.Timedelta(days=DAYS)) & (p["day"] <= end)]
    g = w.groupby(["train", "band"])["lsl"]
    return g.agg(agg).where(g.size() >= MIN_HOURS), w.groupby("train")["lsl"].agg(agg)


def _band_size(tab, one, train, band):
    v = pd.Series(list(zip(train, band)), index=train.index).map(tab)
    return v.fillna(train.map(one))


def oos(p: pd.DataFrame) -> pd.DataFrame:
    rows = []
    p = p.assign(m=p["day"].dt.to_period("M"))
    first = p["day"].min() + pd.Timedelta(days=DAYS + LAG)
    for M in sorted(p["m"].unique()):
        if M.start_time < first:
            continue
        t = p[p["m"] == M]
        end = M.start_time - pd.Timedelta(days=LAG)
        w = p[(p["day"] > end - pd.Timedelta(days=DAYS)) & (p["day"] <= end)].groupby("train")["lsl"]
        tab, one = sizes(p, end)
        med, med1 = sizes(p, end, "median")
        q25, q10 = w.quantile(0.25), w.quantile(0.1)
        rules = {"band mean": _band_size(tab, one, t["train"], t["band"]),
                 "band median": _band_size(med, med1, t["train"], t["band"]),
                 "one mean": t["train"].map(one), "q25": t["train"].map(q25), "q10": t["train"].map(q10)}
        for rule, f in rules.items():
            e = (f.fillna(t["train"].map(q25)) - t["lsl"]).fillna(0)
            for b in range(len(LABELS)):
                k = t["band"] == b
                hr = e[k].groupby([t["date"][k], t["he"][k]]).sum()
                if len(hr) >= MIN_TEST_HOURS:
                    rows.append((str(M), rule, LABELS[b], len(hr), hr.mean(), hr.abs().mean()))
    return pd.DataFrame(rows, columns=["month", "rule", "band", "hours", "bias", "mae"])


def summary(r: pd.DataFrame, p: pd.DataFrame) -> str:
    w = lambda d, c: np.average(d[c], weights=d["hours"])  # noqa: E731
    lines = ["# Combined-cycle sizing on actuals: summary", "",
             f"{p['train'].nunique()} trains, online hours {p['date'].min()} to {p['date'].max()}. Months tested from {r['month'].min()}; "
             f"sizes from the {DAYS} days up to {LAG} days before each month. Error summed over trains per hour, MW "
             "(positive = predicted too large), weighted by hours over the months.", ""]
    for c, name in (("bias", "Bias"), ("mae", "MAE")):
        tab = r.groupby(["rule", "band"]).apply(lambda d: w(d, c)).unstack().reindex(columns=LABELS)
        lines += [f"## {name} by day-ahead hub price band", "", "| Rule | " + " | ".join(LABELS) + " |", "|---|" + "---|" * len(LABELS)]
        for rule in tab.index:
            lines.append(f"| {rule} | " + " | ".join("–" if pd.isna(v) else f"{v:,.0f}" for v in tab.loc[rule]) + " |")
        lines.append("")
    b = r[(r["rule"] == "band mean") & (r["band"] == LABELS[0])]
    lines += ["## Band mean, cheap hours (hub at or below $10), by month", "", "| Month | Hours | Bias | MAE |", "|---|---|---|---|"]
    lines += [f"| {x.month} | {x.hours} | {x.bias:,.0f} | {x.mae:,.0f} |" for x in b.itertuples()]
    on = p.assign(ref=p.groupby("train")["lsl"].transform(lambda s: s.quantile(0.9)))
    small = (on["lsl"] < 0.8 * on["ref"]).groupby(on["band"]).mean()
    lines += ["", "## Share of online hours at a small configuration (below 0.8 of the train's 90th-percentile LSL)", "",
              "| " + " | ".join(LABELS) + " |", "|" + "---|" * len(LABELS),
              "| " + " | ".join(f"{small.get(i, np.nan):.0%}" for i in range(len(LABELS))) + " |", ""]
    return "\n".join(lines)


def add_to_table(path: Path, p: pd.DataFrame):
    x = pd.read_parquet(path)
    cc = x["tech"] == "combined_cycle"
    x["size_band_mean"] = np.nan
    month = pd.to_datetime(x["date"]).dt.to_period("M")
    band = pd.cut(x["hub_win"], BANDS, labels=False)
    for M in sorted(month[cc].unique()):
        k = cc & (month == M)
        tab, one = sizes(p, M.start_time - pd.Timedelta(days=LAG))
        x.loc[k, "size_band_mean"] = _band_size(tab, one, x.loc[k, "train"], band[k]).to_numpy()
    x["size_err"] = x["run_lsl"] - x["size_band_mean"]
    x.to_parquet(path)
    print(f"size_band_mean on {x.loc[cc, 'size_band_mean'].notna().sum():,} of {cc.sum():,} CC rows -> {path}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="start", default="2019-01")
    ap.add_argument("--to", dest="end", default=None, help="last month (default: the latest the 60-day day files cover)")
    ap.add_argument("--out", default="cc-sizing")
    ap.add_argument("--table", default=None, help="decision table parquet to add size_band_mean and size_err to")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    end = a.end or max(f.name[:7] for f in (UNIT_DATA_DIR / "60d").glob("20*.json.gz"))
    p = panel(_months(a.start, end), out)
    r = oos(p)
    r.to_csv(out / "oos.csv", index=False)
    (out / "summary.md").write_text(summary(r, p))
    print((out / "summary.md").read_text())
    if a.table:
        add_to_table(Path(a.table), p)


if __name__ == "__main__":
    main()
