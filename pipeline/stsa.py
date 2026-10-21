"""ERCOT's Short-Term System Adequacy report (NP3-763-CD): the online generation and load
resource capacity for each hour of the current day and the next six, from the QSEs' current
operating plans, posted hourly.

  python -m pipeline.stsa --sample      # list and parse a few postings, print what they hold
"""
import argparse
import datetime as dt
import io

import pandas as pd

from .store import iter_csvs, zip_names

EMIL = "np3-763-cd"


def sample(api):
    """Print the file names, columns and first rows of the newest posting and of one from
    the first days of January 2024, and how many postings a day."""
    now = dt.datetime.now()
    for since in (now - dt.timedelta(days=1), dt.datetime(2024, 1, 2)):
        docs = sorted(api.list_archives(EMIL, since, since + dt.timedelta(days=1)),
                      key=lambda x: x.get("postDatetime", ""))
        print(f"{EMIL}: {len(docs)} posting(s) from {since:%Y-%m-%d %H:%M}")
        if not docs:
            continue
        doc = docs[-1]
        print("  newest:", {k: doc.get(k) for k in ("postDatetime", "friendlyName", "docId")})
        blob = api.download(EMIL, doc["docId"])
        print("  files:", zip_names(blob))
        for n, b in iter_csvs(blob, "x.zip"):
            f = pd.read_csv(io.BytesIO(b))
            print(f"  {n}: {len(f)} rows, columns {list(f.columns)}")
            with pd.option_context("display.width", 250, "display.max_columns", 40):
                print(f.head(4).to_string())
                print(f.tail(2).to_string())


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", action="store_true", help="parse a few postings and print them")
    args = ap.parse_args(argv)
    from .ercot_api import ErcotAPI
    if args.sample:
        sample(ErcotAPI())


if __name__ == "__main__":
    main()
