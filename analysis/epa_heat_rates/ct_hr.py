# Per-unit CT heat rate on ERCOT net: EPA heat input / ERCOT telemetered output, same UTC hour
import sys, numpy as np, pandas as pd
W = sys.argv[1]
m = pd.read_csv(f'{W}/work/match.csv')
t = pd.read_parquet(f'{W}/work/ercot.parquet'); e = pd.read_parquet(f'{W}/work/epa.parquet')
B = e.pivot_table(index='utc', columns='eid', values='mw', aggfunc='sum')
A = t.pivot_table(index='utc', columns='key', values='out', aggfunc='sum')
maps = []
for r in m[m.tech == 'combustion_turbine'].itertuples():
    if r.corr < 0.85:
        continue
    eids = [r.epa]
    if r.ratio < 0.8 and r.corr2 >= 0.85:
        eids.append(r.second)
    a = A[r.key].reindex(B.index).fillna(0); b = B[eids].fillna(0).sum(axis=1)
    both = (a > 1) & (b > 1)
    ratio = (b[both] / a[both]).median()
    if 0.9 <= ratio <= 1.25:
        maps.append(dict(unit=r.key, epa='+'.join(eids), fname=r.fname, corr=r.corr, gross_net=ratio))
mp = pd.DataFrame(maps)
res = []
for r in mp.itertuples():
    eids = r.epa.split('+')
    ee = e[e.eid.isin(eids)].groupby('utc').agg(hi=('hi', 'sum'), mw=('mw', 'sum'), op=('op', 'min'), n=('eid', 'count'),
         ok=('hi_ind', lambda s: s.isin(['Measured', 'MEASURE', 'Calculated']).all()))
    tt = t[t.key == r.unit].set_index('utc')[['state', 'out', 'lsl', 'hsl']]
    x = tt.join(ee, how='inner')
    x = x[(x.n == len(eids)) & (x.op >= 0.999) & x.ok & (x.out > 0) & (x.hi > 0) & x.state.isin(['m', 'a'])].sort_index()
    x['steady'] = x.index.to_series().diff().eq(pd.Timedelta('1h'))
    x = x[x.steady]
    mn = x[x.state == 'm']; fl = x[x.out >= x.out.quantile(0.9)] if len(x) else x
    res.append(dict(unit=r.unit, epa=r.epa, fname=r.fname, corr=round(r.corr, 3), gross_net=round(r.gross_net, 3), hours=len(x), min_hours=len(mn),
                    hr_min=mn.hi.sum() / mn.out.sum() if len(mn) else np.nan, hr_full=fl.hi.sum() / fl.out.sum() if len(fl) else np.nan,
                    hr_all=x.hi.sum() / x.out.sum() if len(x) else np.nan))
r = pd.DataFrame(res); r.to_csv(f'{W}/work/ct_hr.csv', index=False)
print(len(r), 'mapped;', (r.min_hours >= 50).sum(), 'with 50+ min hours;', (r.hours >= 50).sum(), 'with 50+ steady hours')
for c in ('hr_min', 'hr_full', 'hr_all'):
    v = r[(r.hours >= 50)][c].dropna(); print(c, v.quantile([.1, .25, .5, .75, .9]).round(2).tolist())
pd.set_option('display.width', 250); pd.set_option('display.max_rows', 300)
print(r.round(2).sort_values('hr_full').to_string(index=False))
