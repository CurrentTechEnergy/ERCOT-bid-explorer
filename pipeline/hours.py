"""How many real hours one stored hour slot stands for.

The site stores every operating day as 24 hour-ending slots.  On the spring-forward Sunday hour
ending 3 does not exist and its slot stays empty (a 23-hour day).  On the fall-back Sunday (the
first Sunday of November) ERCOT publishes 25 hours, and every parser folds the two hour-ending-2
rows into one slot (their average).  Counting that slot twice gives each year its 8,760 hours
(8,784 in a leap year), and puts the second hour back into yearly averages, percentiles and MWh
sums.  The folded slot holds the two hours' average, so a threshold count treats both at that
average.
"""
import datetime as dt

import numpy as np
import pandas as pd


def fallback_day(year: int) -> dt.date:
    """The fall-back Sunday: the first Sunday of November (US rule since 2007)."""
    d = dt.date(year, 11, 1)
    return d + dt.timedelta(days=(6 - d.weekday()) % 7)


def is_fallback(date) -> bool:
    d = date if isinstance(date, dt.date) else dt.date.fromisoformat(str(date)[:10])
    return d == fallback_day(d.year)


def hour_weight(dates, he) -> np.ndarray:
    """2.0 for hour ending 2 on the fall-back Sunday, else 1.0.  `dates` are dates or YYYY-MM-DD
    strings, `he` hour ending 1..24 (array-likes of one length, or scalars)."""
    d = pd.to_datetime(pd.Series(np.atleast_1d(np.asarray(dates)).astype(str)).str[:10])
    h = np.atleast_1d(np.asarray(he, dtype=int))
    fb = (d.dt.month == 11) & (d.dt.dayofweek == 6) & (d.dt.day <= 7)
    return np.where(fb.to_numpy() & (h == 2), 2.0, 1.0)


def day_weights(date) -> np.ndarray:
    """The 24 slot weights of one day (index 0 = hour ending 1)."""
    w = np.ones(24)
    if is_fallback(date):
        w[1] = 2.0
    return w


def repeat_folded(df: pd.DataFrame, date_col="date", he_col="he") -> pd.DataFrame:
    """`df` with each fall-back hour-ending-2 row repeated once, so plain counts, means and
    percentiles over the rows see the year's full hours."""
    w = hour_weight(df[date_col].to_numpy(), df[he_col].to_numpy()).astype(int)
    return df.loc[df.index.repeat(w)] if (w > 1).any() else df
