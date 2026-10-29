"""Fits of past unit decisions, each written to files the pages read; none is a forecast.

  operator_informed  each CC train's and gas steam unit's hourly on/off call judged with what its
                     operator knew (data/operator/), with its history days (operator_history),
                     turn-off points (operator_cutoffs) and scorecard (operator_scores)
  peaker_rt          each combustion turbine's hours online against the real-time price at its
                     own node (the Commitment page's start chart)
"""
