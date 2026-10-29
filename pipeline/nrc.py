"""The NRC's daily power reactor status for ERCOT's nuclear units, collected as a record (the
commitment forecast that read it was retired in Oct 2026): the 60-day disclosure shows a
refuelling outage about sixty days late, the NRC report the morning it is under way.

Source: the NRC "Power Reactor Status Report" for the last 365 days, a pipe-separated text file
(ReportDt|Unit|Power), one row per reactor per day: its power level (% of rated) at about 04:00
Eastern on the report date, posted that morning.  No login.  Each run keeps every day the file
holds, so the history grows past 365 days.

Writes data/outages/nrc.json.gz:
  {"units": {NRC name: [our unit names]}, "days": {report date: {NRC name: power %}}}
"""
import datetime as dt
import io

import pandas as pd
import requests

from .config import DATA_DIR
from .log import warn
from .store import read_json_gz, write_json_gz

URL = ("https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/"
       "power-reactor-status-reports/PowerReactorStatusForLast365Days.txt")
PATH = DATA_DIR / "outages" / "nrc.json.gz"
UNITS = {"Comanche Peak 1": ["CPSES_UNIT1"], "Comanche Peak 2": ["CPSES_UNIT2"],
         "South Texas 1": ["STP_STP_G1_J01", "STP_STP_G1_J03", "STP_STP_G1_J04"],
         "South Texas 2": ["STP_STP_G2_J01", "STP_STP_G2_J03", "STP_STP_G2_J04"]}


def read_status(text: str) -> dict:
    """The report's text -> {date: {NRC name: power %}} for the ERCOT units."""
    f = pd.read_csv(io.StringIO(text), sep="|", dtype=str)
    f.columns = [c.strip() for c in f.columns]
    f = f[f["Unit"].str.strip().isin(UNITS)]
    out = {}
    for d, u, p in zip(f["ReportDt"], f["Unit"], f["Power"]):
        day = dt.datetime.strptime(d.strip().split(" ")[0], "%m/%d/%Y").date().isoformat()
        out.setdefault(day, {})[u.strip()] = float(p)
    return out


def fetch_nrc() -> None:
    try:
        r = requests.get(URL, timeout=60)
        r.raise_for_status()
        new = read_status(r.text)
    except Exception as e:      # the forecast runs without it (nuclear judged as before)
        warn(f"nrc: reactor status not fetched: {e}")
        return
    old = read_json_gz(PATH, default=None) or {"days": {}}
    days = {**old.get("days", {}), **new}
    write_json_gz(PATH, {"units": UNITS, "days": dict(sorted(days.items()))})
    print(f"nrc: reactor status for {len(new)} day(s), {len(days)} kept, latest {max(days) if days else None}")


if __name__ == "__main__":
    fetch_nrc()
