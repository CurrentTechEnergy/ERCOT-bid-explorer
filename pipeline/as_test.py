"""One-off test (branch only): are units that look marginal but price below their node held
at a limit by ancillary-service awards?  Downloads the 60-day SCED zips for the given days,
scores marginality per run as marginal_nodes does, then again with the up awards taken off
min(HDL, HSL) and the down awards added to max(LDL, LSL)."""
import datetime as dt
import io
import json
import re
import sys
from collections import defaultdict

import numpy as np
import pandas as pd

from .config import DATA_DIR, EMIL_60DAY, TECH_OF_TYPE, UNIT_DATA_DIR
from .ercot_api import ErcotAPI
from .marginal_nodes import STEP_MW, TOL_MW, band, price_at
from .nodes import settlement_points
from .store import iter_csvs, read_json_gz

AS_WORDS = ("regup", "regdn", "regdown", "rrs", "ecrs", "nspin", "nonspin", "ancillary", "asresp", "asaward")


def norm(c):
    return re.sub(r"[^a-z0-9]", "", c.lower())


def as_cols(cols):
    return [c for c in cols if norm(c).startswith("asawards")]


def is_down(c):
    n = norm(c)
    return "regdn" in n or "regdown" in n or "down" in n


def tpo(df, prefix="Submitted TPO"):
    mw = [c for c in df.columns if re.fullmatch(re.escape(prefix) + r"-MW\d+", c)]
    pr = [c.replace("-MW", "-Price") for c in mw]
    return df[pr].astype(float).values, df[mw].astype(float).values


def main(days):
    api = ErcotAPI()
    index = json.load(open(DATA_DIR / "index.json"))
    sp_of = settlement_points(index)
    targets = set(days)
    lo, hi = dt.date.fromisoformat(min(days)), dt.date.fromisoformat(max(days))
    docs = api.list_archives(EMIL_60DAY, dt.datetime.combine(lo + dt.timedelta(days=58), dt.time()),
                             dt.datetime.combine(hi + dt.timedelta(days=63), dt.time()))
    # counts[(tech, cls, kind)] = [n, n matched within $5, n node > curve by > $5]
    counts = defaultdict(lambda: [0, 0, 0])
    colsets, award_stats = {}, defaultdict(lambda: [0, 0.0])
    for doc in sorted(docs, key=lambda d: d["postDatetime"]):
        guess = (dt.date.fromisoformat(doc["postDatetime"][:10]) - dt.timedelta(days=60)).isoformat()
        if guess not in targets:
            continue
        blob = api.download(EMIL_60DAY, doc["docId"])
        frames = []
        for name, data in iter_csvs(blob, "x.zip"):
            low = name.lower()
            if low.startswith("60d_sced_gen_resource_data") or low.startswith("60d_esr_data_in_sced"):
                f = pd.read_csv(io.BytesIO(data), low_memory=False)
                f.columns = [c.strip() for c in f.columns]
                colsets[name.split("-")[0]] = list(f.columns)
                f["_esr"] = low.startswith("60d_esr")
                frames.append(f)
        if not frames:
            continue
        df = pd.concat(frames, ignore_index=True)
        date = pd.to_datetime(df["SCED Time Stamp"].astype(str).str.strip()).dt.date.astype(str).mode()[0]
        targets.discard(guess)
        print(f"{date}: {len(df)} rows; AS columns: {as_cols(df.columns)}", flush=True)
        pr = read_json_gz(DATA_DIR / "prices" / f"{date}.json.gz") or {}
        lam = dict(zip(pr["lambda"]["time"], pr["lambda"]["value"]))
        nodes = (read_json_gz(UNIT_DATA_DIR / "nodes" / f"{date}.json.gz") or {}).get("points") or {}
        site = defaultdict(list)
        for k in nodes:
            site[k.split("_")[0]].append(k)

        status = df["Telemetered Resource Status"].fillna("").astype(str).str.strip()
        df = df[status.str.startswith("ON").values].reset_index(drop=True)
        name = df["Resource Name"].astype(str).str.strip()
        tech = df["Resource Type"].astype(str).str.strip().map(TECH_OF_TYPE).fillna("other").values
        tech = np.where(df["_esr"].values, "storage", tech)
        ts = df["SCED Time Stamp"].astype(str).str.strip()
        hhmm = ts.str.slice(11, 16).values
        minute = ts.str.slice(11, 13).astype(int).values * 60 + ts.str.slice(14, 16).astype(int).values
        f = lambda c: df[c].astype(float).values if c in df.columns else np.full(len(df), np.nan)
        bp, hdl, ldl, hsl, lsl = f("Base Point"), f("HDL"), f("LDL"), f("HSL"), f("LSL")
        up_cols = [c for c in as_cols(df.columns) if not is_down(c)]
        dn_cols = [c for c in as_cols(df.columns) if is_down(c)]
        tonum = lambda cols: np.nansum(np.column_stack([pd.to_numeric(df[c], errors="coerce").values for c in cols]), axis=1) if cols else np.zeros(len(df))
        up, dn = tonum(up_cols), tonum(dn_cols)
        top = np.fmin(hdl, hsl)
        bot = np.fmax(ldl, lsl)
        P, M = tpo(df)
        price, interior = price_at(P, M, bp)
        l = np.array([lam.get(t, np.nan) for t in hhmm], float)
        sp = np.array([sp_of.get(n) or (site[n.split("_")[0]][0] if len(site.get(n.split("_")[0], [])) == 1 else None)
                       for n in name], object)
        node = np.array([nodes[s][m // 15] if s in nodes and nodes[s][m // 15] is not None else np.nan
                         for s, m in zip(sp, minute)], float)
        base = interior & (bp > bot + TOL_MW) & (bp < top - TOL_MW) & np.isfinite(l) & np.isfinite(node)
        base &= np.where(tech == "storage", np.abs(bp) >= STEP_MW, True)
        net = base & (bp > bot + dn + TOL_MW) & (bp < top - up - TOL_MW)
        aw = lambda k: pd.to_numeric(df[k], errors="coerce").fillna(0).values if k in df.columns else 0.0
        variants = {
            "none": base,
            "all": net,
            "no_nspin": base & (bp > bot + dn + TOL_MW) & (bp < top - (up - aw("AS Awards NSPIN")) - TOL_MW),
            "reg_rrs_only": base & (bp > bot + dn + TOL_MW) & (bp < top - aw("AS Awards REGUP") - aw("AS Awards RRSPFR") - aw("AS Awards RRSFFR") - TOL_MW),
            "nspin_only": base & (bp < top - aw("AS Awards NSPIN") - TOL_MW),
            "ecrs_only": base & (bp < top - aw("AS Awards ECRS") - TOL_MW),
        }
        b = np.array([band(x) if np.isfinite(x) else np.nan for x in l])
        cls = np.where(np.abs(price - l) <= b, "at", np.where(price < l, "below", "above"))
        gap = node - price
        # the same, priced off the SCED1 curve (submitted, then extended / truncated by ERCOT)
        P1, M1 = tpo(df, "SCED1 Curve")
        price1, interior1 = price_at(P1, M1, bp)
        net1 = net & interior1
        cls1 = np.where(np.abs(price1 - l) <= b, "at", np.where(price1 < l, "below", "above"))
        g1 = node - price1
        for t, c, g in zip(tech[net1], cls1[net1], g1[net1]):
            for key in ((t, c, "net_of_AS_sced1_curve"), ("ALL", c, "net_of_AS_sced1_curve")):
                r = counts[key]
                r[0] += 1
                r[1] += abs(g) <= 5
                r[2] += g > 5
        # ramp: base point at telemetered output +/- 5 minutes of the unit's ramp rate
        tout, rru, rrd = f("Telemetered Net Output"), f("Ramp Rate Up"), f("Ramp Rate Down")
        ramp_up = bp >= tout + 5 * rru - 1.0
        ramp_dn = bp <= tout - 5 * rrd + 1.0
        rb = np.where(ramp_up, "ramp_up_bound", np.where(ramp_dn, "ramp_down_bound", "ramp_free"))
        rb = np.where(np.isfinite(rru) & np.isfinite(tout), rb, "ramp?")
        for t, c, k, g in zip(tech[net], cls[net], rb[net], gap[net]):
            for key in ((t, c, "net_of_AS_" + k), ("ALL", c, "net_of_AS_" + k)):
                r = counts[key]
                r[0] += 1
                r[1] += abs(g) <= 5
                r[2] += g > 5
        # batteries: where the state of charge sits in its range
        soc, smin, smax = f("State of Charge"), f("Minimum SOC"), f("Maximum SOC")
        with np.errstate(invalid="ignore", divide="ignore"):
            pos = (soc - smin) / (smax - smin)
        bucket = np.where(pos < 0.1, "soc<10%", np.where(pos > 0.9, "soc>90%", "soc10-90%"))
        bucket = np.where(np.isfinite(pos), bucket, "soc?")
        direction = np.where(bp > 0, "dis", "chg")
        m = net & (tech == "storage")
        for c, bk, dr, g in zip(cls[m], bucket[m], direction[m], gap[m]):
            r = counts[("storage_" + dr + "_" + bk, c, "net_of_AS")]
            r[0] += 1
            r[1] += abs(g) <= 5
            r[2] += g > 5
        for vname, vm in variants.items():
            for t, c, g in zip(tech[vm], cls[vm], gap[vm]):
                for key in ((t, c, "v_" + vname), ("ALL", c, "v_" + vname)):
                    r = counts[key]
                    r[0] += 1
                    r[1] += abs(g) <= 5
                    r[2] += g > 5
        for kind, mask in (("all_marginal", base), ("still_marginal_net_of_AS", net), ("at_AS_limit", base & ~net)):
            for t, c, g in zip(tech[mask], cls[mask], gap[mask]):
                for key in ((t, c, kind), ("ALL", c, kind)):
                    r = counts[key]
                    r[0] += 1
                    r[1] += abs(g) <= 5
                    r[2] += g > 5
        for c in up_cols + dn_cols:
            v = pd.to_numeric(df[c], errors="coerce").fillna(0).values
            award_stats[c][0] += int((v > 0).sum())
            award_stats[c][1] += float(v.sum())
    out = {"days_missing": sorted(targets), "columns": colsets,
           "award_rows": {k: v for k, v in award_stats.items()},
           "counts": {"|".join(k): v for k, v in sorted(counts.items())}}
    json.dump(out, open("as_test.json", "w"), indent=1, default=float)
    print("\nAS award columns (rows > 0, total MW):")
    for k, v in award_stats.items():
        print(f"  {k}: {v[0]} rows, {v[1]:.0f} MW")
    print("\ntech | class | kind | n | within $5 | node > curve by $5")
    for k, (n, ok, hi_) in sorted(counts.items()):
        print(f"  {' | '.join(k)} | {n} | {ok / n:.0%} | {hi_ / n:.0%}" if n else "")
    if targets:
        print(f"no file for: {sorted(targets)}")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception:
        import traceback
        tb = traceback.format_exc()
        open("as_test_error.txt", "w").write(tb)
        print("::error::" + " | ".join(tb.strip().splitlines()[-6:]))
        raise
