# Predictor analysis

Scripts that read one side of a backtest (`python -m pipeline.forecast.backtest`, see its
docstring) and explain its scores.  Each imports that side's own copy of the pipeline, so it
analyses the code that was scored, and writes `analysis-<name>.md` next to the side's `run.log`.

    python -m pipeline.forecast.backtest --against main --no-fit --out backtests/mine
    python analysis/floor_causes.py backtests/mine/current
    python analysis/floor_causes.py backtests/mine/ref

For a run of the Backtest workflow (.github/workflows/backtest.yml), download its `backtest`
artifact and rebuild both sides from its day files, with no forecasting:

    gh run download <run id> -n backtest -D backtests/mine-ci
    python -m pipeline.forecast.backtest --score-only --current <branch> --against main \
        --seed backtests/mine-ci/seed --out backtests/mine

| Script | Question |
|---|---|
| floor_causes.py | Where does the cheap-hour committed-minimum error come from (outage, called on but off, called off but on, CC configuration)? |
| calibration.py | Is a unit held at weight p online p of the time? (`--cheap` for cheap hours only) |
| calls.py | Through the loss window, did off/maybe/on calls match what the unit did? |
| outage_catch.py | How much of the cheap-hour overstatement the unplanned outage report would have removed (`--lag` days before D) |

The first script on a side computes every thermal unit-hour on the scored as-of days (about three
minutes) and caches it as `unit_hours.pkl` in the side folder; the rest reuse it.

## Decision table on actuals

`decision_table.py` is not a backtest script: it builds the analysis track's table of every coal,
combined-cycle and gas steam train's stay-on decision through its day-ahead loss window from
2019 on, from the thermal history release (see its docstring for the columns):

    gh release download history -R CurrentTechEnergy/ERCOT-bid-explorer -p 'thermal-*' -p 'units-*' -p 'da-hubs-*' -D history
    python analysis/decision_table.py --out decision-table
