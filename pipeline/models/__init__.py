"""The forecast models, one module each, behind one contract:

    forecast(date, ctx) -> dict          (ctx: pipeline.forecast.context.Context)

Every module carries NAME and VERSION, and every row the pipeline writes from it carries both,
so two versions can be run over the same days and compared before one is promoted
(python -m pipeline.forecast.benchmark).  The page reads the files the models write; it never
computes a model.

  thermal_cutoff    which thermal units are committed for the day (the commitment clock): the
                    stay-on loss at the unit's own node against its own cutoff, in dollars
  thermal_dispatch  the shape within the day for the committed set (the dispatch clock): each
                    unit's offer curve met by the hourly day-ahead price, between LSL and HSL
  peaker_share      combustion turbines: online share by day-ahead price level and hour
  renewable_floor   wind and solar: available MW from the forecasts, less what prices itself
                    out at its own node
  storage_habit     batteries: not built yet (the battery data is loaded first, build step 3)

cutoff_history is a model too (NAME, VERSION, its own benchmark) but not a forecast: it refits
each unit's cutoff month by month to show when its behaviour changed, read by the events
list and the Unit page, never by the forecast.  So it is not in MODELS.
"""
from . import thermal_cutoff, thermal_dispatch, peaker_share, renewable_floor, storage_habit

MODELS = {m.NAME: m for m in (thermal_cutoff, thermal_dispatch, peaker_share, renewable_floor, storage_habit)}


def versions() -> dict:
    return {m.NAME: m.VERSION for m in MODELS.values()}
