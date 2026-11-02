# Unit heat rates from EPA hourly data

Builds `pipeline/reference/unit_heat_rates.csv`: each gas steam, coal and combined-cycle unit's
heat rate at minimum and at full load, in MMBtu per MWh of ERCOT net output. These are one-off
scripts (Nov 2026), run from a scratch directory. They are not part of the pipeline. A quarterly
refresh job is a later step.

Inputs. None of these are ERCOT downloads:
- EPA CAMPD bulk hourly emissions files (no key): `emissions/hourly/state/emissions-hourly-YYYY-tx.csv`
  for complete years and `emissions/hourly/quarter/emissions-hourly-YYYY-qN.csv` for the current
  year, from `https://api.epa.gov/easey/bulk-files/`. Facility attributes come from `facility/facility-YYYY.csv`.
- EIA-923 Schedules 2–5 (Page 4 generator data), for the EIA-based gross-to-net cross-check.
- The `history` release's `thermal-YYYY-MM.parquet` (hourly telemetered net output and state per unit).
- `map.csv` (gas steam and coal ERCOT unit to EPA facility/unit) and `cc_map.csv` (CC train to
  EPA facility). Joint-ownership units map to one EPA unit.

Order:
1. `fetch_epa.py YEAR OUT` and `fetch_q.py YYYY-qN OUT` stream the EPA files and keep Texas operating hours.
2. `load.py` writes one parquet of them.
3. `g2n.py` and `hr.py` give the EIA-923-based first pass (EPA gross scaled to EIA net). `gt.py` does the same for CC and CT.
4. `net.py` (gas steam and coal) and `cc_net.py` (CC) give the measured values: EPA heat input over
   ERCOT telemetered net output in the same UTC hour. EPA hours are local standard time; ERCOT
   hours ending are Central prevailing time. Steady hours only. "At minimum" is ERCOT state "m".

Results, Nov 2026 (2019 to Nov 2025): gas steam 13.4 at minimum (middle half 12.9 to 14.5, 37 units),
coal 11.9 (22 EPA units), CC 7.8 (52 trains). Station use is about 8% of gross at minimum for gas
steam and 11% for coal, against 3% and 6% at full load, and about half of it is fixed MW. Cogeneration
trains, Dansby (EPA gross implausible) and units with under 200 hours at minimum take the
technology median.
