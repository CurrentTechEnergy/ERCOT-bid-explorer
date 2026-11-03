# Writes pipeline/reference/station_use.csv and adds the combustion turbines to
# pipeline/reference/unit_heat_rates.csv, from this folder's outputs (station use: net.py's
# station_use.csv and cc_net.py's train table; CTs: ct_hr.py's ct_hr.csv).
#   python analysis/epa_heat_rates/reference_tables.py STATION_USE.csv CC_STATION_USE.csv CT_HR.csv OUTPUT_FULL.csv
# OUTPUT_FULL.csv is output_full.py's: CC and CT gross and net at minimum and at full load.
import csv, sys
from pathlib import Path

REF = Path(__file__).parents[2] / "pipeline" / "reference"
su, cc, ct, of = sys.argv[1:5]
full = {r["unit"]: r for r in csv.DictReader(open(of))}
r1 = lambda v: None if v in (None, "") else round(float(v), 1)
rows = []
for r in csv.DictReader(open(su)):
    if not r.get("aux_share_min"):
        continue
    for u in r["trains"].split("+"):     # joint-ownership units share the plant unit's numbers
        gf = float(r["aux_mw_full"]) / float(r["aux_share_full"]) if float(r["aux_share_full"]) > 0 else None
        rows.append([u, r["tech"], round(float(r["gross_at_min"]), 1), round(float(r["net_at_min"]), 1),
                     None if gf is None else round(gf, 1), None if gf is None else round(gf - float(r["aux_mw_full"]), 1),
                     round(float(r["aux_mw_min"]), 1), round(float(r["aux_share_min"]), 3),
                     round(float(r["aux_mw_full"]), 1), round(float(r["aux_share_full"]), 3),
                     int(float(r["m_h"])), f'{r["fac"]}/{r["eunit"]}', "+".join(r["trains"].split("+")) if "+" in r["trains"] else ""])
for r in csv.DictReader(open(cc)):
    g_min, g_full = float(r["gross_over_net_min"]), float(r["gross_over_net_full"])
    if not (1.0 <= g_min <= 1.15 and 1.0 <= g_full <= 1.15):
        continue        # cogeneration or incomplete EPA coverage: no station use read from it
    n = float(r["net_at_min"]); f = full.get(r["train"]) or {}
    gf, nf = r1(f.get("gross_full")), r1(f.get("net_full"))
    rows.append([r["train"], "combined_cycle", round(n * g_min, 1), round(n, 1), gf, nf, round(n * (g_min - 1), 1), round(1 - 1 / g_min, 3),
                 None if gf is None else round(gf - nf, 1), round(1 - 1 / g_full, 3), int(float(r["m_h"])), r["fac"], ""])
for r in csv.DictReader(open(ct)):       # combustion turbines: from output_full.py, the matched EPA unit(s)
    f = full.get(r["unit"])
    if not f or f["gross_min"] in ("", None) or not (-0.01 <= float(f["su_share_min"]) <= 0.15 and -0.01 <= float(f["su_share_full"]) <= 0.15):
        continue
    gm, nm, gf, nf = (float(f[k]) for k in ("gross_min", "net_min", "gross_full", "net_full"))
    rows.append([r["unit"], "combustion_turbine", round(gm, 1), round(nm, 1), round(gf, 1), round(nf, 1), round(gm - nm, 1),
                 round(float(f["su_share_min"]), 3), round(gf - nf, 1), round(float(f["su_share_full"]), 3), int(f["min_h"]),
                 r["epa"].replace(":", "/"), ""])
with open(REF / "station_use.csv", "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["unit", "tech", "gross_min", "net_min", "gross_full", "net_full", "su_mw_min", "su_share_min", "su_mw_full", "su_share_full", "min_hours", "epa", "shared_with"])
    w.writerows(sorted(rows))
p = REF / "unit_heat_rates.csv"
old = [r for r in csv.DictReader(open(p)) if not (r["tech"] == "combustion_turbine" and r["unit"] != "*" and r["basis"] != "cogen")]
cogen = {r["unit"] for r in old if r["basis"] == "cogen"}     # cogen.py's rows stay; run it after this
add = []
for r in csv.DictReader(open(ct)):
    if r["hr_min"] and r["hr_full"] and int(r["min_hours"]) >= 30 and int(r["hours"]) >= 50 and r["unit"] not in cogen:
        add.append({"unit": r["unit"], "tech": "combustion_turbine", "hr_min": f'{float(r["hr_min"]):.2f}', "hr_full": f'{float(r["hr_full"]):.2f}',
                    "min_hours": r["min_hours"], "basis": "ercot_net", "epa": r["epa"].replace(":", "/"), "note": "matched by hourly output"})
cols = list(old[0].keys())
with open(p, "w", newline="") as f:
    w = csv.DictWriter(f, cols, lineterminator="\n"); w.writeheader(); w.writerows(old + sorted(add, key=lambda r: r["unit"]))
print(len(rows), "station use rows;", len(add), "CTs added")
