# gross-to-net ratio per EPA unit from months the unit ran most of the month
# (EIA-923 monthly net gen includes station use while offline, which inflates the ratio for peaking units)
import pandas as pd, duckdb, re, sys
fac = pd.read_csv('epa/facility-2025.csv'); fac = fac[fac.State=='TX']
rows=[]
for _,r in fac.iterrows():
    for g,cap in re.findall(r'([^,()]+?) \(([\d.]+)\)', str(r['Associated Generators & Nameplate Capacity (MWe)'])):
        rows.append((r['Facility ID'], str(r['Unit ID']), g.strip(), float(cap)))
ug = pd.DataFrame(rows, columns=['fac','unit','gen','cap'])
ug['n_units_per_gen'] = ug.groupby(['fac','gen']).unit.transform('count')
ug['n_gen_per_unit'] = ug.groupby(['fac','unit']).gen.transform('count')
one = ug[(ug.n_units_per_gen==1)&(ug.n_gen_per_unit==1)]
months = ['January','February','March','April','May','June','July','August','September','October','November','December']
out=[]
years = [int(y) for y in sys.argv[1:]] or [2024, 2025]
for y in years:
    e = pd.read_csv(f'eia/gen923_{y}_tx.csv')
    e = e.rename(columns={'Plant Id':'fac','Generator Id':'gen','Reported\nPrime Mover':'pm'}); e['gen']=e.gen.astype(str).str.strip()
    e = e.melt(id_vars=['fac','gen','pm'], value_vars=[f'Net Generation\n{m}' for m in months], var_name='m', value_name='net')
    e['month'] = e.m.str.replace('Net Generation\n','').map({m:i+1 for i,m in enumerate(months)})
    e['net'] = pd.to_numeric(e.net, errors='coerce')
    gm = duckdb.sql(f"select fac, unit, month(d) as mon, sum(op*mw) as gross, sum(op) as oph from 'work/epa_tx.parquet' where year(d)={y} group by 1,2,3").df().rename(columns={"mon":"month"})
    m = one.merge(e, on=['fac','gen']).merge(gm, on=['fac','unit','month'])
    m['year']=y; out.append(m)
o = pd.concat(out)
dim = pd.to_datetime(dict(year=o.year, month=o.month, day=1)).dt.days_in_month*24
o['runshare'] = o.oph/dim
o.to_csv('work/g2n_monthly.csv', index=False)
busy = o[(o.runshare>=0.8)&(o.net>0)]
r = busy.groupby(['fac','unit','pm']).agg(gross=('gross','sum'), net=('net','sum'), months=('month','count')).reset_index()
r['g2n'] = r.gross/r.net
r.to_csv('work/g2n.csv', index=False)
print(r[r.pm.isin(['ST'])].round(3).to_string())
