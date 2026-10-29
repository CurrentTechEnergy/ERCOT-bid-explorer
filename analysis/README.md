# Analysis

The forecast backtest and the scripts that read it were retired with the forecast layer. What
remains are the analysis track's builders, now in the pipeline:

### Decision table on actuals

`pipeline/decision_table.py` (moved from here for the goal page) builds the analysis track's table of every coal,
combined-cycle and gas steam train's stay-on decision through its day-ahead loss window from
2019 on, from the thermal history release (see its docstring for the columns):

    gh release download history -R CurrentTechEnergy/ERCOT-bid-explorer -p 'thermal-*' -p 'units-*' -p 'da-hubs-*' -D history
    python -m pipeline.decision_table --out decision-table

### Decision model on actuals

`pipeline/decision_rule.py` (moved from here as decision_model.py) fits a logistic stay-on rule for combined-cycle and gas steam trains on the
decision table over rolling 12-month windows, scores each on the month after it, and splits the
change in shutdowns between years into triggers and behaviour (see its docstring):

    python -m pipeline.decision_rule --table decision-table/decision-table.parquet --out decision-model [--no-award]
