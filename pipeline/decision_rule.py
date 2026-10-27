"""Decision model on actuals: a logistic stay-on rule for combined-cycle and gas steam trains,
fitted on the decision table (pipeline/decision_table.py) over rolling 12-month windows, and the
split of the change in shutdowns into behaviour (the rule moved) and triggers (the inputs moved).

    python -m pipeline.decision_rule [--table decision-table/decision-table.parquet] [--out decision-model]

Outcome: the train was off for most of its loss window (on_share < 0.5).  Inputs, standardised
once over the whole table so coefficients compare across windows:

  log_loss     log1p(loss_per_mw), the window's loss at minimum per MW of LSL
  log_before, log_after   log1p of the margin earned before and after the window, per MW
  award        award_share, share of the window covered by a DAM energy award
  win_vs_off   log(window hours / the train's short off spell), the 10th percentile of its off
               spells over the 365 days before the block (the table's own off_p10 uses the same
               calendar year, so it knows whether the train shut that year); 0 with a flag when the
               train had no off spell in that year
  log_start    log1p(start_per_mw), the hot start offer, tech median with a flag when unknown
  overnight    the window starts after midnight (win_from >= 25)
  season       spring, summer, fall against winter
plus one intercept per train (L2-penalised like the rest).  Henry Hub is left out: it barely moves
inside a 12-month window, so its slope trades off against the intercepts and the rules stop being
comparable across windows; gas reaches the rule through the minimum-energy cost in the loss.
--no-award drops the DAM award too: the award is the outcome of the unit's own offer, so for the
behaviour vs triggers split it belongs on the behaviour side.  Coal is left out: it rode through
99 to 100% of its windows every year and stays on the seasonal rule.

Each window is scored on the month after it (out of sample): Brier score against the train's own
off rate in the window, and a calibration table.  The behaviour vs triggers split uses calendar
years (2026 is Jan to Aug) on the trains present in both years: the change in the off rate from
year A to year B is split into triggers, P_A(X_B) - P_A(X_A), and behaviour, P_B(X_B) - P_A(X_B),
averaged with the reverse order so the two parts add up to the change.

Writes <out>/windows.csv (coefficients, reference P(off) and scores per window), <out>/oos.parquet
(out-of-sample predictions), <out>/decomposition.csv and <out>/summary.md.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

TECHS = ("combined_cycle", "gas_steam")
FEATURES = ["log_loss", "log_before", "log_after", "award", "win_vs_off", "win_vs_off_na",
            "log_start", "log_start_na", "overnight", "spring", "summer", "fall"]
C = 1.0
WINDOW = 12
MIN_ROWS = 300      # a train-window fit needs this many rows of the tech


def features(x):
    f = pd.DataFrame(index=x.index)
    f["log_loss"] = np.log1p(x.loss_per_mw)
    f["log_before"] = np.log1p(x.before_per_mw)
    f["log_after"] = np.log1p(x.after_per_mw)
    f["award"] = x.award_share
    wvo = np.log(x.win_h / x.off_p10_lag)
    f["win_vs_off_na"] = wvo.isna().astype(float)
    f["win_vs_off"] = wvo.fillna(0.0)
    sp = np.log1p(x.start_per_mw)
    f["log_start_na"] = sp.isna().astype(float)
    f["log_start"] = sp.fillna(sp.groupby(x.tech).transform("median"))
    f["overnight"] = (x.win_from >= 25).astype(float)
    for s in ("spring", "summer", "fall"):
        f[s] = (x.season == s).astype(float)
    return f


def trailing_off_p10(x):
    """Each block's 10th-percentile off spell (hours) over the train's shutdowns in the 365 days
    before it."""
    out = pd.Series(np.nan, index=x.index)
    for _, g in x.groupby("train"):
        g = g.sort_values("date")
        h = pd.Series(np.where(g.shut, g.off_h, np.nan), index=pd.to_datetime(g.date))
        q = h.rolling("365D", closed="left", min_periods=1).quantile(0.1)
        out[g.index] = q.to_numpy()
    return out


def load(path):
    """The table (a parquet path or a DataFrame) with the outcome, month index and inputs."""
    x = path if isinstance(path, pd.DataFrame) else pd.read_parquet(path)
    x = x[x.tech.isin(TECHS)].reset_index(drop=True)
    x["off"] = (x.on_share < 0.5).astype(int)
    x["ym"] = x.year.astype(int) * 12 + x.month.astype(int) - 1
    x["off_p10_lag"] = trailing_off_p10(x)
    f = features(x)
    mu, sd = f.mean(), f.std().replace(0, 1)
    z = (f - mu) / sd
    return x, z, mu, sd


class Rule:
    """One window's fitted rule: shared slopes plus a per-train intercept."""
    features = FEATURES

    def __init__(self, x, z):
        self.trains = sorted(x.train.unique())
        self.m = LogisticRegression(C=C, max_iter=2000)
        self.m.fit(self._design(x, z), x.off)

    def _design(self, x, z):
        d = pd.get_dummies(pd.Categorical(x.train, categories=self.trains), dtype=float)
        return np.hstack([z[self.features].to_numpy(), d.to_numpy()])

    def known(self, x):
        return x.train.isin(self.trains).to_numpy()

    def p(self, x, z):
        return self.m.predict_proba(self._design(x, z))[:, 1]

    @property
    def slopes(self):
        return dict(zip(self.features, self.m.coef_[0][:len(self.features)]))

    def intercepts(self):
        return pd.Series(self.m.coef_[0][len(self.features):] + self.m.intercept_[0], self.trains)


REF_LOSS = (50, 150, 400)       # $/MW of LSL


def reference(rule, z_ref, mu, sd):
    """P(off) of the median train on one fixed reference block: no DAM award, the whole table's
    median other inputs, and a loss of each REF_LOSS per MW.  The 50% threshold is too unstable to report: it
    sits beyond the data in windows with a flat loss slope."""
    s = rule.slopes
    z = z_ref.copy()
    if "award" in s:
        z["award"] = (0 - mu["award"]) / sd["award"]
    b = rule.intercepts().median() + sum(s[k] * z[k] for k in s if k != "log_loss")
    return {f"p_at_{v}": float(1 / (1 + np.exp(-(b + s["log_loss"] * (np.log1p(v) - mu["log_loss"])
                                                    / sd["log_loss"])))) for v in REF_LOSS}


def ym_label(ym):
    return f"{ym // 12}-{ym % 12 + 1:02d}"


def rolling(x, z, mu, sd):
    rows, oos = [], []
    z_ref = z[FEATURES].median()
    for tech in TECHS:
        t = (x.tech == tech).to_numpy()
        first, last = x.ym[t].min(), x.ym[t].max()
        for s in range(first, last - WINDOW + 1):
            w = t & (x.ym >= s).to_numpy() & (x.ym < s + WINDOW).to_numpy()
            nxt = t & (x.ym == s + WINDOW).to_numpy()
            if w.sum() < MIN_ROWS or x.off[w].nunique() < 2:
                continue
            xw, zw = x[w], z[w]
            rule = Rule(xw, zw)
            r = {"tech": tech, "start": ym_label(s), "end": ym_label(s + WINDOW - 1),
                 "rows": int(w.sum()), "trains": len(rule.trains), "off_rate": xw.off.mean(),
                 **rule.slopes,
                 **reference(rule, z_ref, mu, sd)}
            xt, zt = x[nxt], z[nxt]
            k = rule.known(xt)
            if k.sum():
                xt, zt = xt[k], zt[k]
                p = rule.p(xt, zt)
                base = xt.train.map(xw.groupby("train").off.mean()).to_numpy()
                r.update(test_month=ym_label(s + WINDOW), test_rows=len(xt),
                         brier=np.mean((p - xt.off) ** 2), brier_base=np.mean((base - xt.off) ** 2),
                         test_off=xt.off.mean(), test_pred=p.mean())
                oos.append(pd.DataFrame({"tech": tech, "train": xt.train, "date": xt.date,
                                         "off": xt.off, "p": p, "base": base,
                                         "loss_per_mw": xt.loss_per_mw, "award": xt.award_share}))
            rows.append(r)
    return pd.DataFrame(rows), pd.concat(oos, ignore_index=True)


def decompose(x, z):
    out = []
    yrs = sorted(x.year.unique())
    for tech in TECHS:
        t = x.tech == tech
        rules = {y: Rule(x[t & (x.year == y)], z[t & (x.year == y)]) for y in yrs}
        for a in yrs:
            for b in yrs:
                if b <= a:
                    continue
                ra, rb = rules[a], rules[b]
                common = set(ra.trains) & set(rb.trains)
                ia = t & (x.year == a) & x.train.isin(common)
                ib = t & (x.year == b) & x.train.isin(common)
                xa, za, xb, zb = x[ia], z[ia], x[ib], z[ib]
                paa, pab = ra.p(xa, za).mean(), ra.p(xb, zb).mean()
                pba, pbb = rb.p(xa, za).mean(), rb.p(xb, zb).mean()
                trig = ((pab - paa) + (pbb - pba)) / 2
                beh = ((pbb - pab) + (pba - paa)) / 2
                out.append({"tech": tech, "a": a, "b": b, "trains": len(common),
                            "off_a": xa.off.mean(), "off_b": xb.off.mean(),
                            "fit_change": pbb - paa, "triggers": trig, "behaviour": beh,
                            "rows_a": len(xa), "rows_b": len(xb)})
    return pd.DataFrame(out)


def calibration(oos):
    bins = [0, .05, .1, .2, .3, .5, .7, .9, 1]
    g = oos.assign(bin=pd.cut(oos.p, bins, include_lowest=True)).groupby(["tech", "bin"], observed=True)
    return g.agg(rows=("off", "size"), predicted=("p", "mean"), observed=("off", "mean")).reset_index()


def pct(v):
    return f"{100 * v:.0f}%"


def pp(v):
    return f"{100 * v:+.1f} pt"


def summary(x, win, oos, cal, dec):
    L = ["# Decision model on actuals: summary", ""]
    L.append(f"{len(x):,} combined-cycle and gas steam decision blocks, "
             f"{x.train.nunique()} trains, {x.date.min()} to {x.date.max()}. "
             f"{len(win)} rolling 12-month fits, each scored on the month after it.")
    L += ["", "## Out of sample", "",
          "| Tech | Months | Rows | Off rate | Predicted | Brier | Brier, train's own rate |",
          "|---|---|---|---|---|---|---|"]
    for tech, o in oos.groupby("tech"):
        L.append(f"| {tech} | {o.date.str[:7].nunique()} | {len(o):,} | {pct(o.off.mean())} | "
                 f"{pct(o.p.mean())} | {np.mean((o.p - o.off) ** 2):.3f} | "
                 f"{np.mean((o.base - o.off) ** 2):.3f} |")
    L += ["", "## Calibration (out of sample)", "", "| Tech | P(off) band | Rows | Predicted | Observed |",
          "|---|---|---|---|---|"]
    for r in cal.itertuples():
        L.append(f"| {r.tech} | {r.bin} | {r.rows:,} | {pct(r.predicted)} | {pct(r.observed)} |")
    L += ["", "## Rule by window (every sixth window)", "",
          "Slopes are per standard deviation of the input. The last three columns are the median "
          "train's P(off) on a block with no DAM award and a loss of $50, $150 and $400 per MW.", "",
          "| Tech | Window | Rows | Off rate | Loss slope | Award slope | $50 | $150 | $400 |",
          "|---|---|---|---|---|---|---|---|---|"]
    for tech, w in win.groupby("tech"):
        for r in w.iloc[::6].itertuples():
            L.append(f"| {tech} | {r.start} to {r.end} | {r.rows:,} | {pct(r.off_rate)} | {r.log_loss:.2f} | "
                     f"{getattr(r, "award", np.nan):.2f} | {pct(r.p_at_50)} | {pct(r.p_at_150)} | {pct(r.p_at_400)} |")
    L += ["", "## Behaviour vs triggers, each year against 2019 and against the year before", "",
          "| Tech | From | To | Trains | Off rate from | Off rate to | Change | Triggers | Behaviour |",
          "|---|---|---|---|---|---|---|---|---|"]
    y0 = dec.a.min()
    sel = dec[(dec.a == y0) | (dec.b == dec.a + 1)].sort_values(["tech", "a", "b"])
    for r in sel.itertuples():
        L.append(f"| {r.tech} | {r.a} | {r.b} | {r.trains} | {pct(r.off_a)} | {pct(r.off_b)} | "
                 f"{pp(r.off_b - r.off_a)} | {pp(r.triggers)} | {pp(r.behaviour)} |")
    return "\n".join(L) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", default="decision-table/decision-table.parquet")
    ap.add_argument("--out", default="decision-model")
    ap.add_argument("--no-award", action="store_true")
    a = ap.parse_args()
    if a.no_award:
        Rule.features = [f for f in FEATURES if f != "award"]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    x, z, mu, sd = load(a.table)
    win, oos = rolling(x, z, mu, sd)
    cal = calibration(oos)
    dec = decompose(x, z)
    win.to_csv(out / "windows.csv", index=False)
    oos.to_parquet(out / "oos.parquet", index=False)
    dec.to_csv(out / "decomposition.csv", index=False)
    (out / "summary.md").write_text(summary(x, win, oos, cal, dec))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
