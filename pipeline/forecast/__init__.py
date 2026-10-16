"""The daily forecast files the Overview page renders (site layout plan, principle 6): one file
per operating day in a fixed schema, written by the pipeline from the models in
pipeline/models, plus an index and a score file.  The page does sums and shares only.

  data/forecast/<date>.json.gz      build.build_day
  data/forecast/index.json.gz       days, price bands, model versions
  data/forecast/scores.json.gz      every forecast day scored against the 2-day and 60-day
                                    answers (score.py), the track record the page shows

Usage:
  python -m pipeline.forecast                       # all days with a day-ahead price source
  python -m pipeline.forecast --days 2026-06-01 2026-06-30
  python -m pipeline.forecast --score               # rescore only
"""
