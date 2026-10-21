"""Does ERCOT's real-time HDL/LDL summary track the generator floor?  A one-off check before
NP6-915-CD is added to the daily update as a live floor and headroom series.

NP6-915-CD (Summary Report of HDL and LDL) is posted after every SCED run: GTBD and the summed
High and Low Dispatch Limits of the Generation Resources online and dispatched by SCED.  On
Oct 15, 2026 its SUM_LDL ran 13 to 17 GW above NP6-792-ER's total LSL, about the battery
charging range, so it looks like a generator-only total with no battery netting.  LDL is the
5-minute ramp limit, not LSL, so it sits at or above the generators' minimum.

For sample days (default: the 5th and 20th of each month from Dec 2025 to the last per-unit day)
this downloads every NP6-915-CD posting of the day from the API archive, averages it to hours,
and sets it beside the same hours of the per-unit 60-day files (site/data/60d-units): summed LSL,
HSL and base point by technology.  It reports how SUM_LDL lines up with generator LSL (all, thermal,
thermal without nuclear and peakers) in all hours and in cheap hours (SCED lambda at or below
CHEAP, from summary_prices).  Writes nothing to site/data; the hourly table goes to --out (a
workflow artifact) and the report to stdout and, in Actions, the run summary.

  python -m pipeline.probe_hdl_ldl [--days 2026-03-05 2026-08-20 ...] [--out hdl_ldl_probe.csv]
"""
import argparse
import csv
import datetime as dt
import io
import os
from collections import defaultdict

import numpy as np

from .config import DATA_DIR
from .ercot_api import ErcotAPI
from .store import iter_csvs, read_json_gz

EMIL = "np6-915-cd"
UNIT_DIR = DATA_DIR / "60d-units"
CHEAP = 20.0
THERMAL = ("nuclear", "coal", "combined_cycle", "gas_steam", "combustion_turbine")
MID = ("coal", "combined_cycle", "gas_steam")       # thermal without nuclear and peakers
SERIES = ("lsl_gen", "lsl_thermal", "lsl_mid", "lsl_storage", "hsl_gen", "bp_thermal")


def default_days() -> list:
    have = sorted(p.name[:10] for p in UNIT_DIR.glob("*.json.gz"))
    if not have:
        return []
    out, d = [], dt.date(2025, 12, 1)
    last = dt.date.fromisoformat(have[-1])
    while d <= last:
        for day in (5, 20):
            x = d.replace(day=day).isoformat()
            if x in have:
                out.append(x)
        d = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return out


def ercot_hours(api, day: str) -> dict:
    """{hour ending: (SUM_LDL, SUM_HDL, GTBD, runs)} from the day's NP6-915-CD postings."""
    d = dt.date.fromisoformat(day)
    docs = api.list_archives(EMIL, dt.datetime.combine(d, dt.time()), dt.datetime.combine(d, dt.time()) + dt.timedelta(days=1, minutes=15))
    acc = defaultdict(list)
    for blob in api.download_many(EMIL, [x["docId"] for x in docs]):
        for _, raw in iter_csvs(blob, "x.zip"):
            for r in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
                r = {k.strip(): v for k, v in r.items()}
                t = dt.datetime.strptime(r["SCED_TimeStamp"].strip(), "%m/%d/%Y %H:%M:%S")
                if t.date() == d:
                    acc[t.hour + 1].append((float(r["SUM_LDL"]), float(r["SUM_HDL"]), float(r["GTBD"])))
    return {h: (*np.mean(v, axis=0).tolist(), len(v)) for h, v in acc.items()}


def unit_hours(day: str) -> dict:
    """{hour ending: {series: MW}} from the per-unit 60-day file."""
    f = read_json_gz(UNIT_DIR / f"{day}.json.gz", default=None)
    if not f:
        return {}
    c, units = f["columns"], f["units"]
    il, ih, ib = c.index("lsl"), c.index("hsl"), c.index("base_point")
    out = defaultdict(lambda: dict.fromkeys(SERIES, 0.0))
    for r in f["rows"]:
        tech, v = units[r[0]][2], r[2:]
        s = out[r[1]]
        if tech == "storage":
            s["lsl_storage"] += v[il]
            continue
        s["lsl_gen"] += v[il]
        s["hsl_gen"] += v[ih]
        if tech in THERMAL:
            s["lsl_thermal"] += v[il]
            s["bp_thermal"] += v[ib]
        if tech in MID:
            s["lsl_mid"] += v[il]
    return dict(out)


def fit(x, y) -> str:
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 3:
        return "too few hours"
    b, a = np.polyfit(x, y, 1)
    res = y - (a + b * x)
    return (f"r {np.corrcoef(x, y)[0, 1]:.3f}, mean gap {np.mean(y - x):,.0f} MW, "
            f"fit {a:,.0f} + {b:.2f} x, fit error sd {res.std():,.0f} MW, max {np.abs(res).max():,.0f} MW")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", nargs="*")
    ap.add_argument("--out", default="hdl_ldl_probe.csv")
    args = ap.parse_args(argv)
    days = args.days or default_days()
    api = ErcotAPI()
    prices = read_json_gz(DATA_DIR / "summary_prices.json.gz", default={}) or {}
    rows, lines = [], ["# NP6-915-CD probe: SUM_LDL against the per-unit generator floor", ""]
    for day in days:
        try:
            e = ercot_hours(api, day)
        except Exception as ex:
            lines.append(f"- {day}: download failed: {type(ex).__name__}: {ex}")
            print(lines[-1], flush=True)
            continue
        u = unit_hours(day)
        lam = (prices.get(day) or {}).get("lambda") or []
        for h in sorted(set(e) & set(u)):
            ldl, hdl, gtbd, n = e[h]
            rows.append({"date": day, "he": h, "runs": n, "sum_ldl": round(ldl), "sum_hdl": round(hdl), "gtbd": round(gtbd),
                         **{k: round(v) for k, v in u[h].items()}, "lambda": lam[h - 1] if h <= len(lam) else None})
        lines.append(f"- {day}: {len(e)} hours from ERCOT ({sum(v[3] for v in e.values())} SCED runs), {len(u)} from the unit file")
        print(lines[-1], flush=True)
    if rows:
        with open(args.out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    cheap = [r for r in rows if r["lambda"] is not None and r["lambda"] <= CHEAP]
    lines += ["", f"{len(rows)} hours on {len({r['date'] for r in rows})} days; {len(cheap)} cheap hours (lambda at or below ${CHEAP:.0f})", ""]
    for name, sel in (("All hours", rows), ("Cheap hours", cheap)):
        lines += [f"## {name}", ""]
        for k, label in (("lsl_gen", "generator LSL (all but batteries)"), ("lsl_thermal", "thermal LSL"),
                         ("lsl_mid", "coal, CC and gas steam LSL"), ("bp_thermal", "thermal base point")):
            lines.append(f"- SUM_LDL vs {label}: " + fit([r[k] for r in sel], [r["sum_ldl"] for r in sel]))
        lines.append("- SUM_HDL vs generator HSL: " + fit([r["hsl_gen"] for r in sel], [r["sum_hdl"] for r in sel]))
        lines.append("")
    by_month = defaultdict(list)
    for r in rows:
        by_month[r["date"][:7]].append(r["sum_ldl"] - r["lsl_gen"])
    lines += ["## SUM_LDL minus generator LSL by month (MW)", ""] + [f"- {m}: mean {np.mean(v):,.0f}, sd {np.std(v):,.0f}" for m, v in sorted(by_month.items())]
    print("\n".join(lines), flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write("\n".join(lines) + "\n")
    if os.environ.get("GITHUB_ACTIONS"):     # also as one annotation, readable from the checks API
        text = "\n".join(lines).replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::notice title=NP6-915-CD probe::{text}")


if __name__ == "__main__":
    main()
