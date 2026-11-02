# Monthly delivered coal price by Texas plant from EIA-923 Page 5 (Fuel Receipts and Costs), $/MMBtu
import pandas as pd, glob, re
out=[]
for f in sorted(glob.glob('eia/EIA923_Schedules_2_3_4_5_M_*.xlsx')):
    x = pd.read_excel(f, 'Page 5 Fuel Receipts and Costs', header=None, engine='calamine')
    h = x.index[x.apply(lambda r: r.astype(str).str.contains('FUEL_GROUP', case=False).any(), axis=1)][0]
    x.columns = [str(c).strip() for c in x.iloc[h]]; x = x.iloc[h+1:]
    c = {k.upper().replace('\n',' '): k for k in x.columns}
    def col(*names):
        for n in names:
            for k,v in c.items():
                if k.startswith(n): return v
        raise KeyError(names)
    x = x[(x[col('PLANT STATE')]=='TX') & (x[col('FUEL_GROUP')].astype(str).str.lower()=='coal')]
    d = pd.DataFrame({'year': pd.to_numeric(x[col('YEAR')]), 'month': pd.to_numeric(x[col('MONTH')]),
                      'fac': pd.to_numeric(x[col('PLANT ID')]), 'plant': x[col('PLANT NAME')], 'rank': x[col('ENERGY_SOURCE')],
                      'tons': pd.to_numeric(x[col('QUANTITY')], errors='coerce'), 'mmbtu_per_ton': pd.to_numeric(x[col('AVERAGE HEAT')], errors='coerce'),
                      'cents': pd.to_numeric(x[col('FUEL_COST')], errors='coerce')})
    out.append(d)
d = pd.concat(out); d['mmbtu'] = d.tons*d.mmbtu_per_ton
d = d[d.mmbtu>0]
rep = d[d.cents.notna()]
pl = rep.groupby(['fac','plant','rank','year','month']).apply(lambda g: (g.cents*g.mmbtu).sum()/g.mmbtu.sum()/100).rename('usd_mmbtu').reset_index()
sub = rep[rep['rank']=='SUB'].groupby(['year','month']).apply(lambda g: (g.cents*g.mmbtu).sum()/g.mmbtu.sum()/100).rename('usd_mmbtu').reset_index()
sub['fac']='*'; sub['plant']='Texas subbituminous, reporting plants'; sub['rank']='SUB'
t = pd.concat([pl, sub])
t['month'] = t.year.astype(int).astype(str)+'-'+t.month.astype(int).astype(str).str.zfill(2)
t = t[['month','fac','plant','rank','usd_mmbtu']].sort_values(['fac','month'], key=lambda s: s.astype(str))
t['usd_mmbtu']=t.usd_mmbtu.round(3)
t.to_csv('work/coal_prices.csv', index=False)
print(t.groupby(['fac','plant']).agg(n=('month','count'), first=('month','min'), last=('month','max'), med=('usd_mmbtu','median')).to_string())
withheld = d[d.cents.isna()].groupby('plant').mmbtu.sum()/1e6
print('withheld (all years, million MMBtu):'); print(withheld.round(0).to_string())
