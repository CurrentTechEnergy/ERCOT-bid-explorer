"""Which look-ahead reports ERCOT publishes, how far back their archives go, and how big they are.

A one-off probe for the operator-informed peaker model (Oct 2026): RTD indicative LMPs, the
intra-hour wind, solar and load forecasts, and the real-time ORDC adders.  It reads ERCOT's
product catalogue, lists each candidate report's archive one day at a time at a few points back
in time (listing only: no report is downloaded), and asks the raw store whether it holds the
hourly wind, solar and load forecast files the retired forecast layer fetched.  Writes nothing;
the report goes to stdout and, in Actions, the run summary.

  python -m pipeline.probe_catalogue
"""
import datetime as dt
import os
import re

from .ercot_api import BASE, ErcotAPI

MATCH = re.compile(r"indicative|intra.?hour|look.?ahead|ordc|adder|load forecast|wind power|solar power|"
                   r"photovoltaic|system adequacy|reserves", re.I)
CANDIDATES = ["np6-970-cd", "np3-562-cd", "np4-752-cd", "np4-751-cd", "np6-323-cd"]
BACK_DAYS = [1, 7, 30, 90, 180, 365, 540, 730, 1095, 1460, 2190, 3650]
STORE_CHECK = ["np4-732-cd", "np4-737-cd", "np3-565-cd", "np6-345-cd"]

lines = []


def say(s=""):
    print(s, flush=True)
    lines.append(s)


def _products(js):
    """Every dict that carries an emilId, anywhere in the catalogue response."""
    if isinstance(js, dict):
        if "emilId" in js:
            yield js
        for v in js.values():
            yield from _products(v)
    elif isinstance(js, list):
        for v in js:
            yield from _products(v)


def catalogue(api):
    seen, page = {}, 1
    while page <= 50:
        js = api._request("GET", BASE, params={"page": page, "size": 1000}).json()
        if page == 1:
            say(f"catalogue top-level keys: {sorted(js) if isinstance(js, dict) else type(js).__name__}")
        new = 0
        for p in _products(js):
            k = str(p.get("emilId")).lower()
            if k not in seen:
                seen[k] = p
                new += 1
        pages = (js.get("_meta") or {}).get("totalPages", 1) if isinstance(js, dict) else 1
        if page >= (pages or 1) or not new:
            break
        page += 1
    say(f"{len(seen)} products in the catalogue")
    hits = {k: p for k, p in seen.items() if MATCH.search(f"{p.get('name', '')} {p.get('description', '')}")}
    say("")
    say("| EMIL id | Name |")
    say("| --- | --- |")
    for k, p in sorted(hits.items()):
        say(f"| {k} | {p.get('name', '')} |")
    return seen, hits


def archive_depth(api, emil):
    now = dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    say("")
    say(f"### {emil}")
    sample = None
    for b in BACK_DAYS:
        t0 = now - dt.timedelta(days=b)
        try:
            docs = api.list_archives(emil, t0, t0 + dt.timedelta(days=1))
        except Exception as e:  # noqa: BLE001 - a probe reports every failure and carries on
            say(f"- {b} days back: error {str(e)[:160]}")
            break
        say(f"- {b} days back ({t0:%Y-%m-%d}): {len(docs)} documents that day")
        if docs and sample is None:
            sample = docs[0]
        if not docs and b > 30:
            break
    if sample:
        say(f"- one listing entry: { {k: v for k, v in sample.items() if k != '_links'} }")


def store_check(api):
    say("")
    say("### Raw store: the retired hourly forecast and load files")
    for emil in STORE_CHECK:
        for b in (2, 120, 400):
            t0 = dt.datetime.utcnow() - dt.timedelta(days=b)
            try:
                docs = api.list_archives(emil, t0, t0 + dt.timedelta(hours=6))
            except Exception as e:  # noqa: BLE001
                say(f"- {emil}, {b} days back: listing error {str(e)[:120]}")
                continue
            ids = [d["docId"] for d in docs if "docId" in d][:5]
            held = sum(1 for i in ids if api.raw.has(emil, i))
            say(f"- {emil}, {b} days back: {held} of {len(ids)} sampled documents in the store")


def main():
    api = ErcotAPI()
    _, hits = catalogue(api)
    for emil in sorted(set(CANDIDATES) | {k for k, p in hits.items()
                                          if re.search(r"indicative|intra.?hour|ordc|adder", p.get("name", ""), re.I)}):
        archive_depth(api, emil)
    store_check(api)
    out = os.environ.get("GITHUB_STEP_SUMMARY")
    if out:
        with open(out, "a") as f:
            f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
