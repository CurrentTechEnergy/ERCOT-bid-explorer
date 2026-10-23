"""Behaviour change on actuals: are thermal units responding differently to the same conditions
than they did in a base year, unit by unit, and how much of the fleet's change is behaviour
rather than triggers being met more often?

    python analysis/behaviour_change.py [--base-end 2024-12-31] [--out behaviour] [--previous DIR]

Reads the forecast's own inputs (site/data, the data branch in unitdata/ and the thermal history
release in history/, as for the update), so it covers 2024 on from the history and the 60-day
window after it.

Combined cycle and gas steam.  The forecast's stay-on logistic (thermal_cutoff._logit_fit) is
fitted once on the 365 days to --base-end and frozen.  It scores every later unit-day the unit was
online going into its loss window, on that day's own conditions, for "off for most of the window".
Each unit is watched by two risk-adjusted Bernoulli CUSUMs (Steiner et al. 2000) for its odds of
shutting doubling or halving against the frozen rule.  A CUSUM above H flags a change, dated to
where it last left zero; the unit's odds are then re-fitted as one shift on the frozen rule over
REBASE_N unit-days from that date (an N(0, 1) prior on the shift), and tracking resumes against
that.  A flag with fewer than REBASE_N days after it is left pending.

Combustion turbines.  CTs start rather than ride through a window, so the frozen rule is whether a
CT ran on a day it was available (not on outage or without data for half the day), by the day's
peak day-ahead hub price (PEAK_BINS) and season: each unit's own base-year rate per bin, pulled
toward the CT fleet's by K days.  Always-on CTs are left out.  A CT's running days come in
streaks, so a daily CUSUM flags nearly every unit; instead each unit's half-years are tested on
weekly blocks of (ran less predicted).  A half flags when its t-statistic is beyond T_FLAG and its
observed/expected is outside 1/OE_FLAG to OE_FLAG; a change is sustained when two halves in a row
flag the same way.  A half with fewer than MIN_WEEKS weeks (the current one, early on) is not
tested.

Fleet split, by technology and quarter: triggers are the frozen rule's mean now less its mean in
the same quarter of the base year (conditions calling for a shutdown, or a run, more often);
behaviour is the actual rate less the frozen rule's mean (units responding differently).

Writes <out>/behaviour-change.md, <out>/cc-gs-change-log.csv, <out>/ct-change-log.csv and
<out>/summary.json.  With --previous (an earlier run's <out>), the summary lists the changes that
are new since that run: CC and gas steam changes flagged after its latest flag or in a unit and
direction it had not flagged, and CTs it had not flagged.
"""
import argparse
import json
import sys
from datetime import date as _date
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from pipeline.forecast import context as C          # noqa: E402
from pipeline.models import thermal_cutoff as T    # noqa: E402
from pipeline.store import load_index              # noqa: E402

K_UP, K_DN, H = 2.0, 0.5, 5.0      # odds ratios the CUSUMs watch for, and their threshold
REBASE_N = 60                      # unit-days from the change date the new shift is fitted on
PEAK_BINS = [20, 30, 45, 75, 150]  # $/MWh, the day's peak day-ahead hub average
K = 20                             # days at which a CT's own base rate and the fleet's weigh the same
T_FLAG, OE_FLAG, MIN_WEEKS = 3.0, 1.5, 6
CT = ("combustion_turbine",)


def shift_fit(lg, y):
    """MLE of one log-odds shift b on fixed logits lg (Newton), with an N(0, 1) prior on b."""
    b = 0.0
    for _ in range(50):
        p = 1 / (1 + np.exp(-(lg + b)))
        b = float(np.clip(b + ((y - p).sum() - b) / ((p * (1 - p)).sum() + 1.0), -6, 6))
    return b


def cusum(g, up_label, dn_label, tech):
    """Change events for one unit's days after the base (columns lg, y, date), rebaselining on each."""
    g = g.reset_index(drop=True)
    out = []
    b, i, up, dn, su, sd = 0.0, 0, 0.0, 0.0, 0, 0
    while i < len(g):
        p = 1 / (1 + np.exp(-(g.lg[i] + b)))
        y = g.y[i]
        up = max(0.0, up + y * np.log(K_UP) - np.log(1 - p + K_UP * p))
        dn = max(0.0, dn + y * np.log(K_DN) - np.log(1 - p + K_DN * p))
        if up == 0:
            su = i + 1
        if dn == 0:
            sd = i + 1
        if up > H or dn > H:
            c = min(su if up > H else sd, i)
            w = g.iloc[c:c + REBASE_N]
            nb = shift_fit(w.lg.to_numpy(), w.y.to_numpy()) if len(w) >= REBASE_N else None
            out.append(dict(unit=g.unit[0], tech=tech, since=g.date[c], flagged=g.date[i],
                            direction=up_label if up > H else dn_label, old_shift=round(b, 2),
                            new_shift=None if nb is None else round(nb, 2),
                            odds_x=None if nb is None else round(float(np.exp(nb - b)), 2),
                            status="pending" if nb is None else "rebaselined"))
            if nb is None:
                break
            b, up, dn = nb, 0.0, 0.0
            i = c + REBASE_N
            su = sd = i
            continue
        i += 1
    return out


def window_units(ctx, base_end):
    """CC and gas steam unit-days with the frozen rule's logit, and their change events."""
    got = {}
    fit_ = T._logit_fit
    T._logit_fit = lambda L, point: (got.setdefault("L", L), fit_(L, point))[1]   # the rows _pool fits on
    try:
        T._pool(ctx, _date.today().isoformat())     # as of today: fitted through the record's last day
    finally:
        T._logit_fit = fit_
    L = got["L"]
    fit = T._logit_fit(L, base_end)
    rows = []
    for key, tech, d, x, off in L:
        f = fit.get(tech) or fit.get("*")
        if f is None:
            continue
        mu, sd, trains, m = f
        lg = float(m.decision_function(T._logit_design([x], mu, sd, trains, [key]))[0])
        rows.append((key, tech, d, off, lg))
    D = pd.DataFrame(rows, columns=["unit", "tech", "date", "y", "lg"]).sort_values(["unit", "date"]).reset_index(drop=True)
    D["p"] = 1 / (1 + np.exp(-D.lg))
    D["after"] = D.date > base_end
    ev = []
    for _, g in D[D.after].groupby("unit"):
        ev += cusum(g, "shuts more readily", "stays on more", g.tech.iloc[0])
    return D, pd.DataFrame(ev, columns=["unit", "tech", "since", "flagged", "direction", "old_shift", "new_shift", "odds_x", "status"])


def ct_units(ctx, base_end):
    """CT available days with the frozen rule's P(ran), and the units with a sustained change."""
    hub = pd.concat([pd.read_parquet(f).query("point == 'HB_HUBAVG'")
                     for f in sorted(C.HISTORY_DIR.glob("da-hubs-20[2-9][0-9]-*.parquet")) if f.stem[8:] >= "2024"])
    peak = hub.groupby(hub.date.astype(str)).price.max()
    for d in ctx.uh["dates"]:
        h = ctx.hub(d)
        if d not in peak.index and h is not None:
            peak[d] = float(np.nanmax(np.asarray(h, float)))
    hist = C.history_states(CT, ctx.uh["dates"][0])
    keys = set(hist) | {k for k, v in ctx.raw_states().items() if v[0] == CT[0]}
    groups = ctx.groups_at(ctx.uh["dates"][-1])
    rows = []
    for key in keys:
        if groups.get(key) == "never":
            continue                      # always-on CTs are held on, not judged
        for d, seg in ctx.day_states(key, CT).items():
            if d < "2024-01-01" or d not in peak.index:
                continue
            seg = np.asarray(seg)
            if (seg == "-").mean() >= 0.5 or (seg == "o").mean() >= 0.5:
                continue
            rows.append((key, d, float(np.isin(seg, ["m", "a"]).any()), float(peak[d])))
    D = pd.DataFrame(rows, columns=["unit", "date", "y", "peak"]).sort_values(["unit", "date"]).reset_index(drop=True)
    D["bin"] = np.digitize(D.peak, PEAK_BINS) + 10 * D.date.str[5:7].astype(int).map(T.SEASONS)
    B = D[D.date <= base_end]
    fleet = B.groupby("bin").y.mean()
    own = B.groupby(["unit", "bin"]).y.agg(["sum", "size"])
    f = D.bin.map(fleet).fillna(B.y.mean())
    o = own.reindex(pd.MultiIndex.from_arrays([D.unit, D.bin]))
    D["p"] = np.clip(np.where(o["size"].notna(), (o["sum"].fillna(0).to_numpy() + K * f) / (o["size"].fillna(0).to_numpy() + K), f), 0.005, 0.995)
    D["after"] = D.date > base_end
    D["known"] = D.unit.isin(B.unit.unique())
    A = D[D.after & D.known].copy()
    A["wk"] = pd.to_datetime(A.date).dt.to_period("W").astype(str)
    A["half"] = A.date.str[:4] + np.where(A.date.str[5:7].astype(int) <= 6, "H1", "H2")
    W = A.groupby(["unit", "half", "wk"]).agg(o=("y", "sum"), e=("p", "sum")).reset_index()
    W["r"] = W.o - W.e
    S = W.groupby(["unit", "half"]).agg(o=("o", "sum"), e=("e", "sum"), n=("r", "size"), m=("r", "mean"), sd=("r", "std")).reset_index()
    S["oe"] = S.o / S.e.clip(lower=1)
    S["t"] = S.m / (S.sd.replace(0, np.nan) / np.sqrt(S.n))
    S["flag"] = np.where(S.n < MIN_WEEKS, "", np.where((S.t > T_FLAG) & (S.oe > OE_FLAG), "more",
                         np.where((S.t < -T_FLAG) & (S.oe < 1 / OE_FLAG), "less", "")))
    S = S.sort_values(["unit", "half"])
    ev = []
    for u, g in S.groupby("unit"):
        g = g.reset_index(drop=True)
        for i in range(1, len(g)):
            if g.flag[i] and g.flag[i] == g.flag[i - 1]:
                ev.append(dict(unit=u, direction="runs more" if g.flag[i] == "more" else "runs less", since=g.half[i - 1],
                               oe_since=round(float(g.oe[i - 1]), 2), oe_latest=round(float(g.oe.iloc[-1]), 2),
                               latest_half=g.half.iloc[-1]))
                break
    return D[D.known], pd.DataFrame(ev, columns=["unit", "direction", "since", "oe_since", "oe_latest", "latest_half"])


def quarters(D, base_end, label):
    """Per quarter after the base: unit-days, actual rate, frozen rule, base same quarter, triggers, behaviour."""
    D = D.assign(q=pd.PeriodIndex(D.date, freq="Q").astype(str))
    base = D[D.date <= base_end].groupby(D.q.str[-2:]).p.mean()
    Q = D[D.after].groupby("q").agg(days=("y", "size"), actual=("y", "mean"), frozen=("p", "mean")).reset_index()
    Q["base"] = Q.q.str[-2:].map(base)
    Q["triggers"] = Q.frozen - Q.base
    Q["behaviour"] = Q.actual - Q.frozen
    Q.insert(0, "tech", label)
    return Q


def md_table(df, cols, fmt):
    head = "| " + " | ".join(cols) + " |\n|" + "---|" * len(cols) + "\n"
    return head + "\n".join("| " + " | ".join(fmt(c, r[c]) for c in cols) + " |" for _, r in df.iterrows())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-end", default="2024-12-31", help="last day of the base year the rules are frozen on")
    ap.add_argument("--out", default="behaviour")
    ap.add_argument("--previous", help="an earlier run's --out, to list what is new since it")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    ctx = C.Context(load_index())
    W, We = window_units(ctx, a.base_end)
    Cd, Ce = ct_units(ctx, a.base_end)
    We.to_csv(out / "cc-gs-change-log.csv", index=False)
    Ce.to_csv(out / "ct-change-log.csv", index=False)
    Q = pd.concat([quarters(W[W.tech == t], a.base_end, t) for t in ("combined_cycle", "gas_steam")]
                  + [quarters(Cd, a.base_end, "combustion_turbine")])

    new_w, new_c = We, Ce
    if a.previous and (Path(a.previous) / "cc-gs-change-log.csv").exists():
        pw = pd.read_csv(Path(a.previous) / "cc-gs-change-log.csv")
        pc = pd.read_csv(Path(a.previous) / "ct-change-log.csv")
        seen, last = set(zip(pw.unit, pw.direction)), pw.flagged.max()      # a change flagged after the last run's, or a unit-direction it had not
        new_w = We[[k not in seen or f > last for k, f in zip(zip(We.unit, We.direction), We.flagged)]]
        new_c = Ce[~Ce.unit.isin(pc.unit)]
    through = {"window": W.date.max(), "ct": Cd.date.max()}

    pct = lambda v: "" if pd.isna(v) else f"{v:+.3f}"
    fmt_q = lambda c, v: (f"{v:,}" if c == "days" else pct(v) if c in ("triggers", "behaviour")
                          else f"{v:.3f}" if isinstance(v, float) else str(v))
    open_w = We.sort_values("since").groupby("unit").tail(1)
    lines = [f"# Behaviour change against {a.base_end[:4]}", "",
             f"Run {_date.today().isoformat()}. Rules frozen on the year to {a.base_end}. CC and gas steam days through "
             f"{through['window']}, CT days through {through['ct']}. Method: analysis/behaviour_change.py.", "",
             "## Fleet: triggers against behaviour", "",
             "Share of window days shut (CC, gas steam) or of available days run (CT). Triggers: the frozen rule now "
             f"less the same quarter of {a.base_end[:4]}. Behaviour: actual less the frozen rule.", "",
             md_table(Q, ["tech", "q", "days", "actual", "frozen", "base", "triggers", "behaviour"], fmt_q), "",
             f"## New since the last run: {len(new_w)} CC and gas steam changes, {len(new_c)} CTs", ""]
    if len(new_w):
        lines += [md_table(new_w, ["unit", "tech", "direction", "since", "flagged", "odds_x", "status"], lambda c, v: "" if pd.isna(v) else str(v)), ""]
    if len(new_c):
        lines += [md_table(new_c, ["unit", "direction", "since", "oe_since", "oe_latest"], lambda c, v: str(v)), ""]
    lines += [f"## CC and gas steam: {We.unit.nunique()} of {W[W.after].unit.nunique()} units flagged, latest change each", "",
              md_table(open_w, ["unit", "tech", "direction", "since", "odds_x", "status"], lambda c, v: "" if pd.isna(v) else str(v)), "",
              f"## CTs: {len(Ce)} of {Cd[Cd.after].unit.nunique()} units with a sustained change "
              f"({int((Ce.direction == 'runs less').sum())} run less)", "",
              md_table(Ce.sort_values("oe_latest"), ["unit", "direction", "since", "oe_since", "oe_latest"], lambda c, v: str(v)), ""]
    (out / "behaviour-change.md").write_text("\n".join(lines))
    (out / "summary.json").write_text(json.dumps({
        "run": _date.today().isoformat(), "base_end": a.base_end, "through": through,
        "window_units": int(W[W.after].unit.nunique()), "window_flagged": int(We.unit.nunique()),
        "ct_units": int(Cd[Cd.after].unit.nunique()), "ct_flagged": int(len(Ce)),
        "new": {"window": new_w.to_dict("records"), "ct": new_c.to_dict("records")},
        "quarters": json.loads(Q.round(4).to_json(orient="records"))}, indent=1, default=str))
    print((out / "behaviour-change.md").read_text())


if __name__ == "__main__":
    main()
