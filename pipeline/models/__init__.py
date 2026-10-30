"""Fits of past unit decisions, each written to files the pages read; none is a forecast.

  operator_informed  each CC train's and gas steam unit's hourly on/off call judged with what its
                     operator knew (data/operator/), with its history days (operator_history),
                     turn-off points (operator_cutoffs) and scorecard (operator_scores)
  peaker_oi          each combustion turbine's hourly start and stop judged with what its operator
                     knew an hour ahead, its turn-on points and scores (data/peaker/oi.json.gz)
"""
