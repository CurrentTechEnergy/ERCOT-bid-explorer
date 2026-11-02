# Combined cycle (plant level) and simple-cycle CT (unit level) heat rates at minimum, ERCOT region
import pandas as pd, numpy as np, duckdb, re
fac = pd.read_csv('epa/facility-2025.csv'); fac = fac[(fac.State=='TX')]
ercot_fac = set(fac[fac['NERC Region']=='ERCOT']['Facility ID'])
# CC plants with no NERC region in the file (e.g. Houston-area) are checked against the ERCOT site mapping
site = pd.read_csv('/mnt/project-files/analysis/fuel-hub-negatives/eia860-pipelines-by-site.csv')
site_codes = set(site.eia_plant_code.dropna().astype(int))
keep = ercot_fac | site_codes
# generator map for net
rows=[]
for _,r in fac.iterrows():
    for g,cap in re.findall(r'([^,()]+?) \(([\d.]+)\)', str(r['Associated Generators & Nameplate Capacity (MWe)'])):
        rows.append((r['Facility ID'], str(r['Unit ID']), g.strip(), float(cap)))
ug = pd.DataFrame(rows, columns=['fac','unit','gen','cap'])
h = duckdb.sql("select fac, unit, utype, fname, d, h, op, mw, hi, co2, hi_ind from 'work/epa_tx.parquet' where utype in ('Combined cycle','Combustion turbine')").df()
h = h[h.fac.isin(keep)]
h['ts'] = pd.to_datetime(h.d)+pd.to_timedelta(h.h, unit='h')
good = h.hi_ind.isin(['Measured','MEASURE','Calculated','LME']) & (h.mw>0) & (h.hi>0)
h = h[good].copy()
# unit p99 load (steady proxy) for load fractions
p99 = h[h.op>=0.999].groupby(['fac','unit']).mw.quantile(0.99).rename('p99')
h = h.join(p99, on=['fac','unit'])
# run hours since start per unit
h = h.sort_values(['fac','unit','ts'])
def runlen(x):
    full = (x.op>=0.999).values; t = x.ts.values
    out = np.zeros(len(x), int); c=0; prev=None
    for i in range(len(x)):
        cont = prev is not None and (t[i]-prev)==np.timedelta64(1,'h')
        c = (c+1 if cont else 1) if full[i] else 0
        if not full[i]: c=0
        out[i]=c; prev=t[i] if full[i] else None
    return pd.Series(out, index=x.index)
h['run_h'] = h.groupby(['fac','unit'], group_keys=False).apply(runlen)
months = ['January','February','March','April','May','June','July','August','September','October','November','December']
def eia_net(years):
    out=[]
    for y in years:
        e = pd.read_csv(f'eia/gen923_{y}_tx.csv').rename(columns={'Plant Id':'fac','Reported\nPrime Mover':'pm'})
        e = e.melt(id_vars=['fac','pm'], value_vars=[f'Net Generation\n{m}' for m in months], var_name='m', value_name='net')
        e['month']=e.m.str.replace('Net Generation\n','').map({m:i+1 for i,m in enumerate(months)}); e['year']=y
        e['net']=pd.to_numeric(e.net, errors='coerce'); out.append(e)
    return pd.concat(out)
net = eia_net([2024,2025])
res=[]
# ---- combined cycle, plant level
cc = h[h.utype=='Combined cycle']
for f, x in cc.groupby('fac'):
    st = x[x.run_h>=4]
    ph = st.groupby('ts').agg(hi=('hi','sum'), mw=('mw','sum'), cap=('p99','sum'), n=('unit','count'))
    allu = x.groupby('ts').unit.count()
    ph = ph[ph.n==allu.reindex(ph.index)]  # every online CT is past warm-up
    if len(ph)<200: continue
    ph['lf'] = ph.mw/ph.cap
    lo = ph.lf.quantile(0.02)
    band = ph[ph.lf<=lo+0.05]; full = ph[ph.lf>=0.9]
    # gross/net: EPA monthly plant gross vs EIA-923 CT+CA net, months with high run share
    gm = x.assign(year=x.ts.dt.year, month=x.ts.dt.month).groupby(['year','month']).agg(gross=('mw', lambda s: (s*x.loc[s.index,'op']).sum())).reset_index()
    nm = net[(net.fac==f)&(net.pm.isin(['CT','CA','CS']))].groupby(['year','month']).net.sum().reset_index()
    j = gm.merge(nm, on=['year','month']); j = j[j.net>0]
    g2n = j.gross.sum()/j.net.sum() if len(j) else np.nan
    def w(d): return d.hi.sum()/d.mw.sum()
    res.append(dict(kind='combined_cycle', fac=f, fname=x.fname.iloc[0], units=x.unit.nunique(), hours=len(ph), band_h=len(band),
        min_lf=lo, hr_min_gross=w(band), hr_full_gross=w(full), hr_all_gross=w(x), g2n=g2n))
# ---- simple cycle CT, unit level
ct = h[h.utype=='Combustion turbine']
for (f,u), x in ct.groupby(['fac','unit']):
    st = x[(x.run_h>=1)]
    if len(st)<100: continue
    lf = st.mw/st.p99; lo = lf.quantile(0.02)
    band = st[lf<=lo+0.05]; full=st[lf>=0.9]
    def w(d): return d.hi.sum()/d.mw.sum() if len(d) else np.nan
    res.append(dict(kind='combustion_turbine', fac=f, fname=x.fname.iloc[0], units=u, hours=len(st), band_h=len(band), min_lf=lo,
        hr_min_gross=w(band), hr_full_gross=w(full), hr_all_gross=w(x), g2n=np.nan))
r = pd.DataFrame(res)
r.to_csv('work/hr_gt.csv', index=False)
pd.set_option('display.width',250); pd.set_option('display.max_rows',500)
print(r[r.kind=='combined_cycle'].round(3).to_string())
print(r[r.kind=='combustion_turbine'][['hr_min_gross','hr_full_gross','hr_all_gross','min_lf']].describe().round(2))
