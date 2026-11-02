# Load EPA TX hourly operating rows for given files into one parquet
import duckdb, sys, glob
files = sys.argv[1:] or sorted(glob.glob('epa/tx-*.csv.gz'))
files = [f for f in files if __import__('os').path.getsize(f) > 1000]
q = f"""
copy (
select cast("Facility ID" as int) fac, "Unit ID" unit, "Facility Name" fname,
  cast("Date" as date) d, cast("Hour" as int) h,
  try_cast("Operating Time" as double) op, try_cast("Gross Load (MW)" as double) mw,
  try_cast("Steam Load (1000 lb/hr)" as double) steam,
  try_cast("Heat Input (mmBtu)" as double) hi, try_cast("CO2 Mass (short tons)" as double) co2,
  "Heat Input Measure Indicator" hi_ind, "Primary Fuel Type" fuel, "Unit Type" utype
from read_csv({files!r}, all_varchar=true, header=true, quote='"', delim=',')
) to 'work/epa_tx.parquet' (format parquet)
"""
duckdb.sql(q)
print(duckdb.sql("select year(d) y, count(*) n, count(distinct fac||unit) u from 'work/epa_tx.parquet' group by 1 order by 1"))
