"""Subscriber emails: one digest a day, on the day the update first finds a change for a unit
someone follows, through Buttondown.  Reads data/events.json.gz (pipeline/events.py) and
keeps data/notify_sent.json so an event is never sent twice.

How a static site sends email: Buttondown holds the list.  The Unit page's form subscribes an
address with the tag "unit:<name>" (site/unit-events.js).  This step, run once a day after
the afternoon update:

  1. takes the events whose first-seen date is after the last send and not before the
     events file's baseline (the first build, which is history, not news);
  2. asks Buttondown who follows each of those units (GET /v1/subscribers?tag=unit:X,
     regular subscribers only);
  3. when anyone does, creates ONE email whose recipients are the subscribers with any of
     those unit tags (an "or" over "subscriber.tags contains unit:X" filters) and whose body
     shows each subscriber only their own units' sections, with Buttondown's Django
     templating ({% if 'unit:X' in subscriber.tags %}); so a person gets at most one email a
     day whatever they follow.  The email is sent (status about_to_send), archived nowhere
     (archival_mode disabled), and never goes to subscribers whose units did not change;
  4. a subscriber tagged OWNER_TAG gets, in the same email, a section listing every event
     sent and how many subscribers each unit has;
  5. records the event ids and the email id in data/notify_sent.json.

Without BUTTONDOWN_API_KEY, or with --dry-run, nothing is sent: the email that would go out
is printed and written to the run summary, and the record is not touched.  The first live
run marks everything already in the events file as sent, so nobody gets years of history.

Environment: BUTTONDOWN_API_KEY (repository secret), NOTIFY_DRY_RUN=1 (dry run), SITE_URL.
"""
import argparse
import datetime as dt
import json
import os
import sys
from collections import defaultdict

import requests

from .config import DATA_DIR, SITE_URL
from .events import KINDS, PATH as EVENTS_PATH
from .log import warn, write_summary
from .store import read_json_gz

API = "https://api.buttondown.com/v1"
SENT_PATH = DATA_DIR / "notify_sent.json"
OWNER_TAG = "owner"        # a subscriber with this tag gets the owner's digest section too
MAX_DAYS = 14              # events first seen more than this many days ago are never emailed
PAGE_SLEEP = 0.2
TIMEOUT = 30


class Buttondown:
    def __init__(self, key):
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Token {key}", "Content-Type": "application/json",
                               "X-Buttondown-Live-Dangerously": "true"})

    def subscribers(self, tag):
        """Regular (confirmed, not unsubscribed) subscribers carrying a tag."""
        out, page = [], 1
        while True:
            r = self.s.get(f"{API}/subscribers", params={"tag": tag, "type": "regular", "page": page}, timeout=TIMEOUT)
            r.raise_for_status()
            d = r.json()
            out += d.get("results", [])
            if len(out) >= d.get("count", 0) or not d.get("results"):
                return out
            page += 1

    def send(self, subject, body, tags):
        filters = {"predicate": "or", "groups": [],
                   "filters": [{"field": "subscriber.tags", "operator": "contains", "value": t} for t in tags]}
        r = self.s.post(f"{API}/emails", json={"subject": subject, "body": body, "status": "about_to_send",
                                               "archival_mode": "disabled", "commenting_mode": "disabled", "filters": filters},
                        timeout=TIMEOUT)
        if r.status_code >= 400:
            raise RuntimeError(f"Buttondown {r.status_code}: {r.text[:300]}")
        return r.json().get("id")


# ------------------------------------------------------------------ content ---
def _usd(x):
    return f"-${abs(x):,.0f}" if x < 0 else f"${x:,.0f}"


def _line(e):
    return f"- **{e['date']}** · {KINDS.get(e['kind'], e['kind'])}: {e['title']}"


def unit_section(unit, evs):
    link = f"{SITE_URL}unit.html?unit={unit}"
    lines = [f"## [{unit}]({link})", ""]
    lines += [_line(e) for e in sorted(evs, key=lambda e: e["date"], reverse=True)]
    return "\n".join(lines)


def build_email(today, by_unit, followers, owner_rows):
    """(subject, body) for the day's digest.  by_unit: {unit: [events]}; followers: {unit: n}."""
    units = sorted(u for u in by_unit if followers.get(u))
    n_ev = sum(len(by_unit[u]) for u in units)
    subject = f"ERCOT bid explorer: changes for units you follow ({today})"
    parts = ["<!-- buttondown-editor-mode: plaintext -->",
             f"Today's update found changes for units you follow. Unit-level data comes from ERCOT's 60-day disclosure, so these are dated about two months back; each line links to the unit's page.", ""]
    for u in units:
        parts += [f"{{% if 'unit:{u}' in subscriber.tags %}}", unit_section(u, by_unit[u]), "{% endif %}", ""]
    parts += [f"{{% if '{OWNER_TAG}' in subscriber.tags %}}", "## Owner's digest", "",
              "Everything sent today, with how many confirmed subscribers follow each unit:", ""]
    parts += [f"- {u}: {followers.get(u, 0)} subscriber{'' if followers.get(u, 0) == 1 else 's'}, {len(by_unit[u])} event{'' if len(by_unit[u]) == 1 else 's'}" for u in sorted(by_unit)]
    parts += ["", f"{len(owner_rows)} event(s) found today in all, {n_ev} of them for followed units.", "{% endif %}", "",
              f"You get at most one of these a day, only when a unit you follow changed. Unsubscribe with the link below, or follow more units from their pages on [{SITE_URL}]({SITE_URL})."]
    return subject, "\n".join(parts)


# -------------------------------------------------------------------- main ---
def pending(ev, sent):
    """Events to consider today: first seen after the baseline, not already sent, not stale."""
    done = set(sent.get("event_ids", []))
    cutoff = (dt.date.today() - dt.timedelta(days=MAX_DAYS)).isoformat()
    base = ev.get("baseline")
    return [e for e in ev["events"] if e["id"] not in done and e["seen"] != base and e["seen"] >= cutoff]


def units_of(e):
    return [e["unit"], *e.get("units", [])]


def run(dry_run=False):
    ev = read_json_gz(EVENTS_PATH, default=None)
    if not ev:
        print("notify: no events file, nothing to do")
        return 0
    key = os.environ.get("BUTTONDOWN_API_KEY")
    dry_run = dry_run or not key or os.environ.get("NOTIFY_DRY_RUN") == "1"
    sent = json.loads(SENT_PATH.read_text()) if SENT_PATH.exists() else None
    today = dt.date.today().isoformat()
    if sent is None and not dry_run:
        # first live run: everything already found is history
        sent = {"started": today, "event_ids": sorted(e["id"] for e in ev["events"]), "sends": []}
        SENT_PATH.write_text(json.dumps(sent, separators=(",", ":")))
        print(f"notify: first run, {len(sent['event_ids'])} existing events marked as sent; nothing emailed")
        return 0
    sent = sent or {"started": None, "event_ids": [], "sends": []}
    todo = pending(ev, sent)
    if not todo:
        print("notify: no new events since the last send")
        return 0
    by_unit = defaultdict(list)
    for e in todo:
        for u in units_of(e):
            by_unit[u].append(e)
    api = None if dry_run else Buttondown(key)
    followers = {}
    for u in sorted(by_unit):
        followers[u] = len(api.subscribers(f"unit:{u}")) if api else 0
    subject, body = build_email(today, by_unit, followers, todo)
    tags = [f"unit:{u}" for u in sorted(by_unit) if followers.get(u)] + [OWNER_TAG]
    lines = ["### Subscriber emails", "",
             f"{len(todo)} new event(s) on {len(by_unit)} unit(s); {sum(1 for u in by_unit if followers.get(u))} followed unit(s)" + (" (dry run, nothing sent)" if dry_run else ""), ""]
    if dry_run:
        lines += ["<details><summary>The email that would go out</summary>", "", f"**{subject}**", "", "```", body, "```", "</details>"]
        write_summary(lines)
        print("\n".join(lines))
        return 0
    if not any(followers.values()):
        email_id = None
        print(f"notify: {len(todo)} new event(s), none on a followed unit; nothing emailed")
    else:
        try:
            email_id = api.send(subject, body, tags)
        except Exception as ex:   # a failed send leaves the events pending for the next run
            warn(f"notify: send failed, events kept for the next run: {ex}")
            return 1
        print(f"notify: email {email_id} sent for {len(todo)} event(s) on {len(by_unit)} unit(s)")
    sent["event_ids"] = sorted(set(sent["event_ids"]) | {e["id"] for e in todo})
    sent["sends"].append({"date": today, "email_id": email_id, "events": len(todo),
                          "units": {u: followers.get(u, 0) for u in sorted(by_unit)}})
    sent["sends"] = sent["sends"][-400:]
    SENT_PATH.write_text(json.dumps(sent, separators=(",", ":")))
    lines.append(f"Email {email_id or '(none: no followers)'} · " + ", ".join(f"{u} ({followers.get(u, 0)})" for u in sorted(by_unit)))
    write_summary(lines)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="print the email that would go out; send nothing, record nothing")
    args = ap.parse_args(argv)
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
