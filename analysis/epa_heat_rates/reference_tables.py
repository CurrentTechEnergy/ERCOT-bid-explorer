# Writes pipeline/reference/station_use.csv and adds the combustion turbines to
# pipeline/reference/unit_heat_rates.csv, from this folder's outputs (station use: net.py's
# station_use.csv and cc_net.py's train table; CTs: ct_hr.py's ct_hr.csv).
#   python analysis/epa_heat_rates/reference_tables.py STATION_USE.csv CC_STATION_USE.csv CT_HR.csv
import csv, sys
from pathlib import Path

REF = Path(__file__).parents[2] / "pipeline" / "reference"
su, cc, ct = sys.argv[1:4]
rows = []
for r in csv.DictReader(open(su)):
    if not r.get("aux_share_min"):
        continue
    for u in r["trains"].split("+"):     # joint-ownership units share the plant unit's numbers
        rows.append([u, r["tech"], round(float(r["gross_at_min"]), 1), round(float(r["net_at_min"]), 1),
                     round(float(r["aux_mw_min"]), 1), round(float(r["aux_share_min"]), 3),
                     round(float(r["aux_mw_full"]), 1), round(float(r["aux_share_full"]), 3),
                     int(float(r["m_h"])), f'{r["fac"]}/{r["eunit"]}', "+".join(r["trains"].split("+")) if "+" in r["trains"] else ""])
for r in csv.DictReader(open(cc)):
    g_min, g_full = float(r["gross_over_net_min"]), float(r["gross_over_net_full"])
    if not (1.0 <= g_min <= 1.15 and 1.0 <= g_full <= 1.15):
        continue        # cogeneration or incomplete EPA coverage: no station use read from it
    n = float(r["net_at_min"])
    rows.append([r["train"], "combined_cycle", round(n * g_min, 1), round(n, 1), round(n * (g_min - 1), 1), round(1 - 1 / g_min, 3),
                 None, round(1 - 1 / g_full, 3), int(float(r["m_h"])), r["fac"], ""])
with open(REF / "station_use.csv", "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["unit", "tech", "gross_min", "net_min", "su_mw_min", "su_share_min", "su_mw_full", "su_share_full", "min_hours", "epa", "shared_with"])
    w.writerows(sorted(rows))
p = REF / "unit_heat_rates.csv"
old = [r for r in csv.DictReader(open(p)) if not (r["tech"] == "combustion_turbine" and r["unit"] != "*")]
add = []
for r in csv.DictReader(open(ct)):
    if r["hr_min"] and r["hr_full"] and int(r["min_hours"]) >= 30 and int(r["hours"]) >= 50:
        add.append({"unit": r["unit"], "tech": "combustion_turbine", "hr_min": f'{float(r["hr_min"]):.2f}', "hr_full": f'{float(r["hr_full"]):.2f}',
                    "min_hours": r["min_hours"], "basis": "ercot_net", "epa": r["epa"].replace(":", "/"), "note": "matched by hourly output"})
cols = list(old[0].keys())
with open(p, "w", newline="") as f:
    w = csv.DictWriter(f, cols, lineterminator="\n"); w.writeheader(); w.writerows(old + sorted(add, key=lambda r: r["unit"]))
print(len(rows), "station use rows;", len(add), "CTs added")
