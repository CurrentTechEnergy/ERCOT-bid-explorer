# Heat rate at LSL per ERCOT train, from EPA hourly heat input / gross load
import pandas as pd, numpy as np, duckdb
MIN_RUN = {'gas_steam':12,'coal':12,'combined_cycle':4,'combustion_turbine':1}
mp = pd.read_csv('map.csv', dtype={'unit':str})
dt = pd.read_parquet('/mnt/project-files/analysis/decision-table/decision-table.parquet', columns=['train','tech','date','lsl'])
lsl = dt.groupby('train').lsl.median().rename('lsl_train')
mp = mp.join(lsl, on='train')
# EPA unit LSL (net) = sum of joint-ownership trains
eu = mp.groupby(['fac','unit','tech']).agg(trains=('train', lambda s: '+'.join(s)), lsl_net=('lsl_train','sum')).reset_index()
g2n = pd.read_csv('work/g2n.csv', dtype={'unit':str})
g2n = g2n[['fac','unit','g2n','months']]
eu = eu.merge(g2n, on=['fac','unit'], how='left')
med = eu.groupby('tech').g2n.median()
eu['g2n_src'] = np.where(eu.g2n.notna(),'unit','tech median')
eu['g2n'] = eu.g2n.fillna(eu.tech.map(med))
keys = eu[['fac','unit']]
duckdb.register('keys', keys)
h = duckdb.sql("""select e.* from 'work/epa_tx.parquet' e join keys k on e.fac=k.fac and e.unit=k.unit""").df()
h['ts'] = pd.to_datetime(h.d) + pd.to_timedelta(h.h, unit='h')
h = h.sort_values(['fac','unit','ts'])
res=[]; curves=[]
for (fac,unit), x in h.groupby(['fac','unit']):
    info = eu[(eu.fac==fac)&(eu.unit==unit)].iloc[0]
    x = x.set_index('ts')
    full = x.op.reindex(pd.date_range(x.index.min(), x.index.max(), freq='h')).fillna(0) >= 0.999
    # hours since start of the current full-hour run
    grp = (~full).cumsum()
    run_h = full.groupby(grp).cumsum()
    nxt = full.shift(-1, fill_value=False)
    ok = (run_h >= MIN_RUN[info.tech]) & nxt
    x = x.join(ok.rename('steady'))
    good = x.hi_ind.isin(['Measured','MEASURE','Calculated']) & (x.mw>0) & (x.hi>0)
    s = x[x.steady & good].copy()
    s['hr'] = s.hi/s.mw
    s = s[(s.hr>5)&(s.hr<30)]
    if len(s) < 50: continue
    lg = info.lsl_net*info.g2n
    band = s[(s.mw>=0.9*lg)&(s.mw<=1.15*lg)]
    p2 = s.mw.quantile(0.02); pmax = s.mw.quantile(0.99)
    fl = s[(s.mw>=p2)&(s.mw<=1.1*p2)]
    hi_band = s[s.mw>=0.9*pmax]
    allload = x[good & (x.mw>0)]
    def w(df): return df.hi.sum()/df.mw.sum() if len(df) else np.nan
    res.append(dict(fac=fac, unit=unit, fname=x.fname.iloc[0], tech=info.tech, trains=info.trains,
        lsl_net=info.lsl_net, g2n=info.g2n, g2n_src=info.g2n_src, lsl_gross=lg,
        steady_h=len(s), lsl_h=len(band), first=s.index.min().date(), last=s.index.max().date(),
        hr_lsl_gross=w(band), hr_lsl_net=w(band)*info.g2n,
        hr_lsl_net_2024on=w(band[band.index>='2024-01-01'])*info.g2n, lsl_h_2024on=int((band.index>='2024-01-01').sum()),
        floor_gross_mw=p2, hr_floor_net=w(fl)*info.g2n,
        pmax_gross=pmax, hr_full_net=w(hi_band)*info.g2n, hr_all_net=(allload.hi.sum()/(allload.mw*allload.op).sum()*info.g2n) if False else w(allload)*info.g2n,
        hr_lsl_net_halffixed=(band.hi.sum()/len(band)) / (band.mw.mean() - 0.5*(1-1/info.g2n)*pmax - 0.5*(1-1/info.g2n)*band.mw.mean()) if len(band) else np.nan,
        co2_t_per_mwh_lsl=(band.co2.sum()/band.mw.sum()*info.g2n) if len(band) else np.nan))
    s['loadfrac'] = (s.mw/pmax).clip(0,1.05)
    s['bin'] = (s.loadfrac*20).round()/20
    c = s.groupby('bin').apply(lambda d: pd.Series({'hr_net': d.hi.sum()/d.mw.sum()*info.g2n, 'n': len(d)})).reset_index()
    c['fac']=fac; c['unit']=unit; c['tech']=info.tech; c['trains']=info.trains; curves.append(c)
r = pd.DataFrame(res); r.to_csv('work/hr_lsl.csv', index=False)
pd.concat(curves).to_csv('work/hr_curves.csv', index=False)
pd.set_option('display.width',250)
print(r[['trains','tech','lsl_net','g2n','lsl_h','hr_lsl_net','hr_lsl_net_halffixed','hr_lsl_net_2024on','floor_gross_mw','hr_floor_net','hr_full_net','hr_all_net','first']].round(2).to_string())
