"""Is each input still arriving?  Run at the end of every update (.github/workflows/update.yml).

Most fetch failures only warn and keep the stored data (a source that is down for a day is
normal), so a source that stops for good would otherwise go unnoticed.  This compares each
input's newest day with how far behind it normally runs and writes data/freshness.json:

  {"checked": UTC time, "today": Central date,
   "sources": {key: {"label", "latest", "behind", "allowed", "stale"}}}

"behind" is in days (business days for the gas hubs), "allowed" the most it may fall behind
before it counts as stale.

With --issues (the workflow passes it), one GitHub issue labelled stale-data stays open while
anything is stale: opened with the list of stale sources, commented on (which notifies) when
another source goes stale, its table refreshed silently on later runs, and closed with a comment
once everything has caught up.  Needs the gh CLI and GH_TOKEN.  Never fails the run: a problem
with gh only warns.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
from zoneinfo import ZoneInfo

import numpy as np

from . import private
from .config import DATA_DIR
from .log import warn, write_summary
from .store import read_json_gz

PATH = DATA_DIR / "freshness.json"
LABEL = "stale-data"
DAM_POSTED = 14     # Central hour by which tomorrow's DAM results are in (posted ~13:30)

# key in index.json "days" -> (label, days behind allowed). The 2-day reports and real-time
# prices run two days behind, the 60-day disclosure sixty; one missed day of slack on top.
INDEX_SOURCES = {
    "2d": ("2-day SCED curves (NP3-908-ER)", 3),
    "2dgen": ("2-day generation (NP3-910-ER)", 3),
    "prices": ("Real-time hub prices", 3),
    "nodes": ("Real-time resource-node prices", 3),
    "60d": ("60-day SCED disclosure", 63),
    "dam": ("60-day DAM disclosure", 63),
    "storage": ("60-day storage", 63),
}
# files with a "days" dict or list -> label. They hold tomorrow once the DAM has posted.
FORWARD_SOURCES = {
    "dam_nodes.json.gz": "DAM node prices",
    "dam_lambda.json.gz": "DAM system lambda",
}


def _days(path):
    """The days a {"days": ...} file holds, as ISO strings."""
    d = (read_json_gz(path) or {}).get("days") or []
    return list(d)


def _row(label, latest, behind, allowed):
    return {"label": label, "latest": latest, "behind": behind, "allowed": allowed,
            "stale": latest is None or behind > allowed}


def check(now=None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    local = now.astimezone(ZoneInfo("America/Chicago"))
    today = local.date()
    behind = lambda d: (today - dt.date.fromisoformat(d)).days     # noqa: E731
    out = {}

    index = json.loads((DATA_DIR / "index.json").read_text())
    for key, (label, allowed) in INDEX_SOURCES.items():
        days = index["days"].get(key) or []
        latest = max(days) if days else None
        out[key] = _row(label, latest, behind(latest) if latest else None, allowed)

    # forward-looking: tomorrow after the DAM posts, today before it
    allowed = -1 if local.hour >= DAM_POSTED else 0
    for name, label in FORWARD_SOURCES.items():
        days = _days(DATA_DIR / name)
        latest = max(days) if days else None
        out[name.split(".")[0]] = _row(label, latest, behind(latest) if latest else None, allowed)

    # gas hubs post on trading days, a day or so late
    hubs = (private.read("gas_hubs.json.gz") or {}).get("hubs") or {}
    for code, h in hubs.items():
        latest = max(h.get("dates") or [""]) or None
        lag = int(np.busday_count(latest, today.isoformat())) if latest else None
        out[f"gas_{code}"] = _row(f"Gas price, {h.get('name', code)}", latest, lag, 3)

    unplanned = sorted(p.name[:10] for p in (DATA_DIR / "outages" / "unplanned").glob("20*.json.gz"))
    out["unplanned"] = _row("Unplanned outages (NP1-346-ER)", unplanned[-1] if unplanned else None,
                            behind(unplanned[-1]) if unplanned else None, 5)
    nrc = _days(DATA_DIR / "outages" / "nrc.json.gz")
    out["nrc"] = _row("NRC reactor status", max(nrc) if nrc else None,
                      behind(max(nrc)) if nrc else None, 2)

    return {"checked": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "today": today.isoformat(),
            "sources": out}


def _gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


TITLE = "Stale data inputs"


def _table(rows):
    return "\n".join(["| Source | Newest day | Behind | Allowed |", "|---|---|---|---|"]
                     + [f"| {r['label']} (`{k}`) | {r['latest'] or 'none'} | {r['behind']} | {r['allowed']} |"
                        for k, r in rows.items()])


def sync_issue(result) -> None:
    """One open issue while anything is stale: opened with the list, a comment (which notifies)
    when another source goes stale, the body refreshed silently on every run, and closed once
    everything has caught up."""
    stale = {k: r for k, r in result["sources"].items() if r["stale"]}
    try:
        _gh("label", "create", LABEL, "--force", "--color", "d93f0b",
            "--description", "An input to the update has stopped arriving (pipeline/freshness.py)")
        found = json.loads(_gh("issue", "list", "--label", LABEL, "--state", "open",
                               "--json", "number,body", "--limit", "1"))
        issue = found[0] if found else None
        body = (f"These inputs have fallen further behind than usual (days; gas hubs in trading days):"
                f"\n\n{_table(stale)}\n\nLast checked {result['checked']} by {os.environ.get('RUN_URL') or 'the update run'}. "
                "Opened, refreshed and closed by `pipeline/freshness.py`; it closes itself once every "
                "source has caught up.\n\n<!-- stale: " + " ".join(sorted(stale)) + " -->")
        if stale and not issue:
            _gh("issue", "create", "--title", TITLE, "--label", LABEL, "--body", body)
        elif stale:
            before = set(issue["body"].split("<!-- stale: ")[-1].split(" -->")[0].split()) if "<!-- stale: " in issue["body"] else set()
            _gh("issue", "edit", str(issue["number"]), "--body", body)
            if set(stale) - before:
                _gh("issue", "comment", str(issue["number"]), "--body",
                    "Now also stale:\n\n" + _table({k: stale[k] for k in sorted(set(stale) - before)}))
        elif issue:
            _gh("issue", "close", str(issue["number"]), "--reason", "completed",
                "--comment", f"Every input has caught up ({result['checked']}).")
    except Exception as e:
        warn(f"freshness: GitHub issue not updated: {e}")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--issues", action="store_true", help="open, refresh and close GitHub issues")
    args = ap.parse_args(argv)
    result = check()
    PATH.write_text(json.dumps(result, indent=1) + "\n")
    stale = {k: r for k, r in result["sources"].items() if r["stale"]}
    for k, r in stale.items():
        warn(f"stale data: {r['label']} newest {r['latest']}, {r['behind']} behind (allowed {r['allowed']})")
    write_summary(["### Data freshness", "", "| Source | Newest | Behind | Allowed |", "|---|---|---|---|"]
                  + [f"| {'**stale** ' if r['stale'] else ''}{r['label']} | {r['latest']} | {r['behind']} | {r['allowed']} |"
                     for r in result["sources"].values()])
    print(f"freshness: {len(result['sources'])} sources, {len(stale)} stale")
    if args.issues:
        sync_issue(result)


if __name__ == "__main__":
    main()
