import csv, sys, io, subprocess, gzip
# stream one year's TX hourly file, keep operating hours only, write gzip csv
year = sys.argv[1]; out = sys.argv[2]
url = f"https://api.epa.gov/easey/bulk-files/emissions/hourly/state/emissions-hourly-{year}-tx.csv"
keep = ["Facility Name","Facility ID","Unit ID","Associated Stacks","Date","Hour","Operating Time","Gross Load (MW)","Steam Load (1000 lb/hr)","CO2 Mass (short tons)","Heat Input (mmBtu)","Heat Input Measure Indicator","Primary Fuel Type","Unit Type"]
p = subprocess.Popen(["curl","-sS","--retry","4",url], stdout=subprocess.PIPE)
r = csv.DictReader(io.TextIOWrapper(p.stdout, encoding="utf-8"))
n = k = 0
with gzip.open(out, "wt", newline="") as f:
    w = csv.writer(f); w.writerow(keep)
    for row in r:
        n += 1
        if row["Operating Time"] in ("", "0", "0.00", "0.0"): continue
        k += 1; w.writerow([row[c] for c in keep])
print(year, n, k, file=sys.stderr)
