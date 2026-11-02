# Station use measured directly: EPA gross vs ERCOT telemetered net output (history release thermal-*),
# same hour, gas steam and coal; heat rate on ERCOT net at minimum (state "m")
import pandas as pd, numpy as np, duckdb
mp = pd.read_csv('map.csv', dtype={'unit':str})
t = pd.read_parquet('work/therm_sc.parquet'); t['unit']=t.unit.astype(str); t['state']=t.state.astype(str)
t = t.merge(mp[['train','fac','unit']].rename(columns={'unit':'eunit'}), left_on='unit', right_on='train')
# ERCOT hour ending in Central prevailing time -> UTC hour beginning
loc = pd.to_datetime(t.date) + pd.to_timedelta(t.he.astype(int)-1, unit='h')
t['utc'] = loc.dt.tz_localize('America/Chicago', ambiguous='NaT', nonexistent='NaT').dt.tz_convert('UTC').dt.tz_localize(None)
t = t.dropna(subset=['utc'])
# joint-ownership splits: sum net and LSL, state = all parts in the same state else mixed
g = t.groupby(['fac','eunit','utc']).agg(out=('out','sum'), lsl=('lsl','sum'), n=('train','count'),
      st=('state', lambda s: s.iloc[0] if (s==s.iloc[0]).all() else 'x')).reset_index()
e = duckdb.sql("select fac, unit eunit, d, h, op, mw, hi, co2, hi_ind from 'work/epa_tx.parquet'").df()
e = e[e.fac.isin(mp.fac.unique())]
e['utc'] = pd.to_datetime(e.d) + pd.to_timedelta(e.h + 6, unit='h')   # EPA hours are local standard time
x = g.merge(e, on=['fac','eunit','utc'])
x = x[(x.op>=0.999) & x.hi_ind.isin(['Measured','MEASURE','Calculated']) & (x.mw>0) & (x.hi>0) & (x.out>0) & x.st.isin(['m','a'])]
x = x.sort_values(['fac','eunit','utc'])
# steady: previous 3 hours also joined and running
x['prev_ok'] = x.groupby(['fac','eunit']).utc.diff().eq(pd.Timedelta('1h'))
x['run'] = x.groupby(['fac','eunit']).prev_ok.transform(lambda s: s.groupby((~s).cumsum()).cumsum())
x = x[x.run>=6]
x['aux'] = x.mw - x.out; x['auxf'] = x.aux/x.mw
x = x[(x.auxf>-0.05)&(x.auxf<0.4)]
x.to_parquet('work/gross_net_joined.parquet')
names = mp.groupby(['fac','unit']).agg(trains=('train', lambda s:'+'.join(s)), tech=('tech','first')).reset_index().rename(columns={'unit':'eunit'})
res=[]
for (f,u), y in x.groupby(['fac','eunit']):
    mn = y[y.st=='m']; hi = y[y.mw >= y.mw.quantile(0.9)]
    if len(mn) < 50: 
        res.append(dict(fac=f, eunit=u, m_h=len(mn))); continue
    b, a = np.polyfit(y.mw, y.aux, 1) if y.mw.std()>5 else (np.nan, np.nan)
    res.append(dict(fac=f, eunit=u, m_h=len(mn), joined_h=len(y),
        net_at_min=mn.out.median(), gross_at_min=mn.mw.median(),
        aux_mw_min=mn.aux.median(), aux_share_min=mn.aux.sum()/mn.mw.sum(),
        aux_mw_full=hi.aux.median(), aux_share_full=hi.aux.sum()/hi.mw.sum(),
        aux_fixed_mw=a, aux_per_mw=b,
        hr_net_min=mn.hi.sum()/mn.out.sum(), hr_gross_min=mn.hi.sum()/mn.mw.sum(),
        hr_net_full=hi.hi.sum()/hi.out.sum(), co2_per_net_mwh_min=mn.co2.sum()/mn.out.sum()))
r = names.merge(pd.DataFrame(res), on=['fac','eunit'], how='right')
r.to_csv('work/station_use.csv', index=False)
pd.set_option('display.width',250)
print(r.drop(columns=['fac','eunit']).round(3).to_string())
