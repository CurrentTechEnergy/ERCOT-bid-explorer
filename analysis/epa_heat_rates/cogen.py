# Cogeneration units' heat rates: fuel chargeable to power, written into
# pipeline/reference/unit_heat_rates.csv with basis "cogen" (hr_min = hr_full).
#   python analysis/epa_heat_rates/cogen.py EIA923_Schedules_2_3_4_5_M_12_YYYY_Final.xlsx
# A cogeneration plant makes power and steam for an industrial host from one fuel stream. EPA's
# heat input covers both, and ERCOT telemetry sees only the power sent to the grid, so EPA heat
# input over ERCOT net output overstates the fuel the power costs. EIA-923 Page 1 splits the
# plant's fuel: Elec_MMBtu is the fuel for electricity, the rest credited to the useful steam at
# about boiler efficiency, which is the fuel the plant would save making the same power by other
# means with its steam load held. So each unit in pipeline/reference/cogen_units.csv takes its EIA
# plant's fuel for electricity over net generation that year, bounded to heat_rates.COGEN_BOUNDS;
# a unit with no single EIA plant (Dow, ExxonMobil and Union Carbide run several) takes the
# generation-weighted value over the ERCOT combined heat and power plants inside the bounds.
import csv, sys
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[2]))
from pipeline.heat_rates import COGEN_BOUNDS, PATH  # noqa: E402

COGEN = PATH.parent / "cogen_units.csv"
x = pd.read_excel(sys.argv[1], "Page 1 Generation and Fuel Data", header=5, engine="calamine")
x.columns = [str(c).replace("\n", " ") for c in x.columns]
x = x[(x["Plant State"] == "TX") & (x["Balancing Authority Code"] == "ERCO")]
yr = int(pd.to_numeric(x["YEAR"]).max())
chp = [c for c in x.columns if c.startswith("Combined Heat")][0]
num = lambda c: pd.to_numeric(x[c], errors="coerce")
p = pd.DataFrame({"fac": x["Plant Id"].astype(int), "chp": x[chp], "tot": num("Total Fuel Consumption MMBtu"),
                  "elec": num("Elec Fuel Consumption MMBtu"), "ng": num("Net Generation (Megawatthours)")})
p = p.groupby(["fac", "chp"]).sum().reset_index().set_index("fac")
p["hr"] = p.elec / p.ng
lo, hi = COGEN_BOUNDS
pool = p[(p.chp == "Y") & (p.ng > 2e5) & p.hr.between(lo, hi)]
pooled = (pool.elec.sum() / pool.ng.sum())
print(f"EIA {yr}: pooled {pooled:.2f} over {len(pool)} ERCOT CHP plants")

techs = {}
for r in csv.DictReader(open(PATH)):
    techs.setdefault(r["unit"], r["tech"])
idx = Path(__file__).parents[2] / "site" / "data" / "unit_index.json.gz"
if idx.exists():
    import gzip, json
    ix = json.load(gzip.open(idx))
    for row in ix["rows"]:
        techs.setdefault(row[0], row[1])
rows = [r for r in csv.DictReader(open(PATH))]
cg = {r["unit"]: r for r in csv.DictReader(open(COGEN))}
rows = [r for r in rows if r["unit"] not in cg]
for u, c in sorted(cg.items()):
    t = techs.get(u)
    if t not in ("combined_cycle", "combustion_turbine", "gas_steam"):
        print("skipped (no technology):", u)
        continue
    f = int(c["eia_plant"]) if c["eia_plant"] else None
    if f in p.index and lo <= p.hr[f] <= hi:
        v, src = p.hr[f], f"EIA-923 {yr} fuel for electricity over net generation, plant {f} ({c['plant']}; steam {1 - p.elec[f] / p.tot[f]:.0%} of its fuel)"
    else:
        v, src = pooled, f"EIA-923 {yr} ERCOT combined heat and power plants, generation-weighted ({c['plant']})"
    rows.append({"unit": u, "tech": t, "hr_min": f"{v:.2f}", "hr_full": f"{v:.2f}", "min_hours": "", "basis": "cogen",
                 "epa": f"EIA {f}" if f else "", "note": f"cogeneration, fuel chargeable to power: {src}"})
    print(u, t, f"{v:.2f}", src)
with open(PATH, "w", newline="") as fh:
    w = csv.DictWriter(fh, list(rows[0].keys()), lineterminator="\n"); w.writeheader()
    order = {"coal": 0, "combined_cycle": 1, "gas_steam": 2, "combustion_turbine": 3}
    w.writerows(sorted(rows, key=lambda r: (order[r["tech"]], r["unit"] != "*", r["unit"])))
