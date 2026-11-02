# CC trains: EPA heat input of the train's gas turbines over ERCOT telemetered net output of the train
import pandas as pd, numpy as np, duckdb
mp = pd.read_csv('cc_map.csv')
t = pd.read_parquet('work/therm_cc.parquet'); t['state']=t.state.astype(str)
t = t[t.train.isin(mp.train)]
loc = pd.to_datetime(t.date) + pd.to_timedelta(t.he.astype(int)-1, unit='h')
t['utc'] = loc.dt.tz_localize('America/Chicago', ambiguous='NaT', nonexistent='NaT').dt.tz_convert('UTC').dt.tz_localize(None)
t = t.dropna(subset=['utc'])
on = t[t.state.isin(['m','a'])]
# one row per train-hour: total net, state m if every online config is at minimum
tr = on.groupby(['train','utc']).agg(out=('out','sum'), lsl=('lsl','sum'), st=('state', lambda s: 'm' if (s=='m').all() else 'a')).reset_index()
tr = tr.merge(mp, on='train')
e = duckdb.sql("select fac, unit, d, h, op, mw, hi, co2, hi_ind from 'work/epa_tx.parquet' where utype='Combined cycle'").df()
e = e[e.fac.isin(mp.fac)]
e['utc'] = pd.to_datetime(e.d) + pd.to_timedelta(e.h + 6, unit='h')
e['good'] = e.hi_ind.isin(['Measured','MEASURE','Calculated']) & (e.hi>0)
# assign each EPA unit to the train whose online hours it matches best (multi-train plants)
assign = {}
for f, trains in mp.groupby('fac').train:
    trains = list(trains); units = e[e.fac==f].unit.unique()
    if len(trains)==1:
        for u in units: assign[(f,u)] = trains[0]; continue
    hrs = pd.Index(sorted(set(e[e.fac==f].utc)|set(tr[tr.fac==f].utc)))
    ton = {tn: pd.Series(1, index=tr[tr.train==tn].utc).reindex(hrs, fill_value=0) for tn in trains}
    for u in units:
        uo = pd.Series(1, index=e[(e.fac==f)&(e.unit==u)&(e.op>0)].utc).reindex(hrs, fill_value=0)
        corr = {tn: np.corrcoef(uo, ton[tn])[0,1] if ton[tn].std()>0 and uo.std()>0 else -1 for tn in trains}
        best = max(corr, key=corr.get)
        if corr[best] > 0.3: assign[(f,u)] = best
a = pd.DataFrame([(f,u,tn) for (f,u),tn in assign.items()], columns=['fac','unit','train'])
a.to_csv('work/cc_unit_assign.csv', index=False)
e = e.merge(a, on=['fac','unit'])
# a train-hour counts only if every EPA unit that is on is a full hour with good data
eh = e.groupby(['train','utc']).agg(hi=('hi','sum'), mw=('mw','sum'), co2=('co2','sum'),
       on=('op', lambda s: (s>0).sum()), full=('op', lambda s: ((s>=0.999)|(s==0)).all()), good=('good', lambda s: s.all())).reset_index()
x = tr.merge(eh, on=['train','utc'])
x = x[x.full & x.good & (x.on>0) & (x.out>0) & (x.mw>0)]
x = x.sort_values(['train','utc'])
x['prev_ok'] = x.groupby('train').utc.diff().eq(pd.Timedelta('1h'))
x['run'] = x.groupby('train').prev_ok.transform(lambda s: s.groupby((~s).cumsum()).cumsum())
x = x[x.run>=4]
x['ratio'] = x.mw/x.out
x = x[(x.ratio>0.5)&(x.ratio<2.0)]
res=[]
for tn, y in x.groupby('train'):
    mn = y[y.st=='m']; full = y[y.out >= y.out.quantile(0.9)]
    d = dict(train=tn, fac=y.fac.iloc[0], epa_units=a[a.train==tn].unit.nunique(), joined_h=len(y), m_h=len(mn),
             gross_over_net_full=full.mw.sum()/full.out.sum(), hr_net_full=full.hi.sum()/full.out.sum(), hr_net_all=y.hi.sum()/y.out.sum())
    if len(mn)>=50:
        d.update(net_at_min=mn.out.median(), gross_over_net_min=mn.mw.sum()/mn.out.sum(), hr_net_min=mn.hi.sum()/mn.out.sum(), co2_per_net_mwh_min=mn.co2.sum()/mn.out.sum())
    res.append(d)
r = pd.DataFrame(res); r.to_csv('work/cc_station.csv', index=False)
pd.set_option('display.width',250); pd.set_option('display.max_rows',200)
print(r.round(3).to_string())
ok = r[(r.m_h>=200)]
print(len(ok), 'hr_net_min median', ok.hr_net_min.median().round(2), ok.hr_net_min.quantile([.25,.75]).round(2).tolist(), 'full', ok.hr_net_full.median().round(2), 'all', ok.hr_net_all.median().round(2))
