# Gross and net output at minimum and at full load, CC trains (cc_map.csv) and matched CTs
# (ct_hr.csv): EPA gross load against ERCOT telemetered net, same UTC hour, steady hours,
# history release months in W/dl (2024-06 to 2025-11)
import sys, duckdb, numpy as np, pandas as pd
W, CCMAP, CTHR = sys.argv[1:4]
EPA = '/mnt/project-files/analysis/epa-heat-rates/epa-tx-hourly-operating-2019-2026q2.parquet'
t = duckdb.sql(f"select unit, tech, date, he, state, out from '{W}/dl/thermal-*.parquet' where tech in ('combined_cycle','combustion_turbine')").df()
cc = t.tech == 'combined_cycle'
t['key'] = np.where(cc, t.unit.str.extract(r'^(.*_CC\d+)_', expand=False), t.unit)
loc = pd.to_datetime(t.date) + pd.to_timedelta(t.he.astype(int) - 1, unit='h')
t['utc'] = loc.dt.tz_localize('America/Chicago', ambiguous='NaT', nonexistent='NaT').dt.tz_convert('UTC').dt.tz_localize(None)
t = t.dropna(subset=['utc', 'key'])
# train state: m if any config m and none a? use: running at minimum when every online config is "m"
g = t[t.state.isin(['m', 'a'])].groupby(['key', 'utc']).agg(out=('out', 'sum'), st=('state', lambda s: 'm' if (s == 'm').all() else 'a')).reset_index()
e = duckdb.sql(f"select fac, unit, d, h, mw, op from '{EPA}' where d >= '2024-05-30'").df()
e['utc'] = pd.to_datetime(e.d) + pd.to_timedelta(e.h + 6, unit='h')
e['eid'] = e.fac.astype(str) + ':' + e.unit.astype(str)
cm = pd.read_csv(CCMAP, dtype=str); ct = pd.read_csv(CTHR, dtype=str)
pairs = [(r.train, [f"{r.fac}:{u}" for u in e[e.fac == int(r.fac)].unit.unique()]) for r in cm.itertuples()] + \
        [(r.unit, r.epa.split('+')) for r in ct.itertuples()]
res = []
for key, eids in pairs:
    ee = e[e.eid.isin(eids)].groupby('utc').agg(mw=('mw', 'sum'), op=('op', 'min'), n=('eid', 'count'))
    x = g[g.key == key].set_index('utc').join(ee, how='inner')
    x = x[(x.out > 0) & (x.mw > 0) & (x.op >= 0.999)].sort_index()
    if key in set(cm.train):
        x = x[x.n == x.n.max()] if len(x) else x     # every EPA unit of the plant reporting
    x = x[x.index.to_series().diff().eq(pd.Timedelta('1h'))]
    x = x[(x.mw / x.out).between(0.95, 1.3)]
    if len(x) < 50:
        continue
    mn = x[x.st == 'm']; fl = x[x.out >= x.out.quantile(0.9)]
    res.append(dict(unit=key, hours=len(x), min_h=len(mn), gross_min=mn.mw.median() if len(mn) >= 30 else np.nan, net_min=mn.out.median() if len(mn) >= 30 else np.nan,
                    gross_full=fl.mw.median(), net_full=fl.out.median(), su_share_full=1 - fl.out.sum() / fl.mw.sum(),
                    su_share_min=1 - mn.out.sum() / mn.mw.sum() if len(mn) >= 30 else np.nan))
r = pd.DataFrame(res); r.to_csv(f'{W}/work/output_full.csv', index=False)
print(len(r)); print(r.round(3).head(12).to_string(index=False)); print(r[['su_share_min','su_share_full']].describe().round(3))
