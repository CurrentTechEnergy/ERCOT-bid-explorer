# Match ERCOT units (CT, unmapped CC trains, two steam units) to EPA units by hourly output correlation
import sys, duckdb, numpy as np, pandas as pd
W = sys.argv[1]; EPA = '/mnt/project-files/analysis/epa-heat-rates/epa-tx-hourly-operating-2019-2026q2.parquet'
t = duckdb.sql(f"select unit, tech, date, he, state, out, lsl, hsl from '{W}/dl/thermal-*.parquet'").df()
cc_un = ['BYU','CAL','DIB','FLCNS','FORMOSA','INGLCOSW','KMCHI','WFCOGEN']
t['key'] = t.unit
cc = t.tech == 'combined_cycle'
t.loc[cc, 'key'] = t.loc[cc, 'unit'].str.replace(r'_(CT|ST|CC)?\d*$', '', regex=True)
want = (t.tech == 'combustion_turbine') | t.unit.isin(['STEAM_STEAM_2','STEAM_STEAM_3']) | (cc & t.unit.str.split('_').str[0].isin(cc_un))
t = t[want].copy()
loc = pd.to_datetime(t.date) + pd.to_timedelta(t.he.astype(int) - 1, unit='h')
t['utc'] = loc.dt.tz_localize('America/Chicago', ambiguous='NaT', nonexistent='NaT').dt.tz_convert('UTC').dt.tz_localize(None)
t = t.dropna(subset=['utc'])
t.to_parquet(f'{W}/work/ercot.parquet')
lo, hi = t.utc.min(), t.utc.max()
e = duckdb.sql(f"select fac, unit, fname, d, h, mw, hi, op, hi_ind, utype from '{EPA}' where d >= '2024-05-30'").df()
e['utc'] = pd.to_datetime(e.d) + pd.to_timedelta(e.h + 6, unit='h')
e = e[(e.utc >= lo) & (e.utc <= hi)]
e['eid'] = e.fac.astype(str) + ':' + e.unit.astype(str)
e.to_parquet(f'{W}/work/epa.parquet')
idx = pd.date_range(lo, hi, freq='h')
A = t.pivot_table(index='utc', columns='key', values='out', aggfunc='sum').reindex(idx).fillna(0).clip(lower=0)
B = e.pivot_table(index='utc', columns='eid', values='mw', aggfunc='sum').reindex(idx).fillna(0)
def z(M):
    X = M.values; X = X - X.mean(0); s = X.std(0); s[s == 0] = np.inf; return X / s
C = z(A).T @ z(B) / len(idx)
names = e.groupby('eid').agg(fname=('fname','first'), utype=('utype','first'))
tech = t.groupby('key').tech.first()
rows = []
for i, k in enumerate(A.columns):
    o = np.argsort(-C[i])[:2]
    b = B.columns[o[0]]
    both = (A[k] > 1) & (B[b] > 1)
    rows.append(dict(key=k, tech=tech[k], epa=b, fname=names.fname[b], corr=C[i, o[0]], second=B.columns[o[1]], corr2=C[i, o[1]],
                     ratio=(B[b][both] / A[k][both]).median() if both.any() else np.nan, hours=int(both.sum()), ercot_on=int((A[k] > 1).sum())))
r = pd.DataFrame(rows).sort_values(['tech','key'])
r.to_csv(f'{W}/work/match.csv', index=False)
pd.set_option('display.width', 250); pd.set_option('display.max_rows', 400)
print(r.round(3).to_string(index=False))
