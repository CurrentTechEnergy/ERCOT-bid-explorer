# Screens pipeline/reference/unit_heat_rates.csv and moves a measured unit to its technology's
# median (basis "fallback", with a note) when it fails either test:
#   1. range: its heat rate at minimum lies outside heat_rates.BOUNDS for its technology (the
#      pipeline also applies this test when it reads the file);
#   2. cogeneration: at its EPA plant, EPA heat input is more than 20% above EIA-923's fuel for
#      electricity (Page 1 Elec_MMBtu), where EIA's total fuel is within 20% of EPA's so the two
#      cover the same plant.  At a combined heat and power plant EPA's heat input includes the fuel
#      for the host's steam, which ERCOT net output does not pay for.
#   python analysis/epa_heat_rates/screen.py EPA.parquet EIA923_Schedules_2_3_4_5_M_12_YYYY_Final.xlsx [--write]
# EPA.parquet is load.py's output; the EIA year should be a complete one also in the EPA file.
import csv, sys
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).parents[2]))
from pipeline.heat_rates import BOUNDS, PATH  # noqa: E402

COGEN = 1.2
epa_f, eia_f = sys.argv[1:3]
x = pd.read_excel(eia_f, "Page 1 Generation and Fuel Data", header=5, engine="calamine")
x.columns = [str(c).replace("\n", " ") for c in x.columns]
x = x[x["Plant State"] == "TX"]
yr = int(pd.to_numeric(x["YEAR"]).max())
num = lambda c: pd.to_numeric(x[c], errors="coerce")
eia = pd.DataFrame({"fac": x["Plant Id"].astype(int), "tot": num("Total Fuel Consumption MMBtu"),
                    "elec": num("Elec Fuel Consumption MMBtu")}).groupby("fac").sum()
p = pd.read_parquet(epa_f, columns=["fac", "d", "hi"])
p = p[p.d.astype(str).str[:4] == str(yr)]
epa = p.groupby("fac").hi.sum().rename("epa")
t = eia.join(epa, how="inner")
t = t[(t.elec > 0) & (t.epa / t.tot).between(1 / 1.2, 1.2)]
cogen = t[t.epa / t.elec > COGEN]

rows = list(csv.DictReader(open(PATH)))
fails = []
for r in rows:
    if r["unit"] == "*" or r["basis"] == "fallback":
        continue
    lo, hi = BOUNDS[r["tech"]]
    fac = int(r["epa"].split("/")[0]) if r["epa"] else None
    why = None
    if not lo <= float(r["hr_min"]) <= hi:
        why = f"outside {lo}-{hi} (measured {r['hr_min']})"
    elif fac in cogen.index:
        c = cogen.loc[fac]
        why = (f"cogeneration: EPA heat input {c.epa / c.elec:.2f}x EIA-923 fuel for electricity, {yr} "
               f"(measured {r['hr_min']})")
    if why:
        fails.append((r["unit"], r["tech"], why))
        r.update(hr_min=None, hr_full=None, basis="fallback", note=why)
fb = {r["tech"]: r for r in rows if r["unit"] == "*"}
for r in rows:
    if r["hr_min"] is None:
        r["hr_min"], r["hr_full"] = fb[r["tech"]]["hr_min"], fb[r["tech"]]["hr_full"]
print(f"EIA {yr}: {len(t)} comparable plants, {len(cogen)} over {COGEN}x")
for f in fails:
    print(*f, sep="  ")
if "--write" in sys.argv:
    with open(PATH, "w", newline="") as f:
        w = csv.DictWriter(f, list(rows[0].keys()), lineterminator="\n"); w.writeheader(); w.writerows(rows)
