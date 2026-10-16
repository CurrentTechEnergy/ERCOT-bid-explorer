"""Batteries: not built yet.  Blair asked for the battery data (DAM ESR awards, state of charge,
ancillary-service responsibilities) to be loaded before any battery model is built; that is
build step 3.  The forecast file carries the storage rows now (null) so the page needs no
change when this module fills them.
"""
NAME = "storage_habit"
VERSION = None


def forecast(date, ctx) -> dict:
    return {"rows": None, "inputs": {}}
