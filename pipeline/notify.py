"""Subscriber emails: one email a day to each person who follows a unit the update found a change
for, on the day the change is first found.  Reads data/events.json.gz (pipeline/events.py) and
keeps data/notify_sent.json so an event is never sent twice.

How a static site sends email: the follow server (worker/, a Cloudflare Worker) holds who follows
which unit; the Unit page's form signs people up there and it confirms them by email.  This
step, run once a day after the afternoon update:

  1. takes the events whose first-seen date is after the last send and not before the events
     file's baseline (the first build, which is history, not news);
  2. reads the confirmed follows from the Worker's D1 database through Cloudflare's API (with
     the same token that deploys the Worker; there is no public endpoint listing addresses);
  3. sends each follower ONE email (Resend) covering every unit they follow that changed, with a
     link to stop each unit and a one-click unsubscribe from everything;
  4. sends OWNER_EMAIL a digest of everything found and how many people follow each unit
     (counts, never addresses);
  5. records the event ids and the counts in data/notify_sent.json.

Without RESEND_API_KEY, or with --dry-run / NOTIFY_DRY_RUN=1, nothing is sent: the emails that
would go out are summarised on the run summary and the record is not touched.  The first live
run marks everything already in the events file as sent, so nobody gets years of history.

Environment: RESEND_API_KEY, CLOUDFLARE_API_TOKEN, OWNER_EMAIL (repository secrets),
NOTIFY_DRY_RUN=1 (dry run), SITE_URL, NOTIFY_FROM.
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

from .config import DATA_DIR, SITE_URL
from .events import KINDS, PATH as EVENTS_PATH
from .log import warn, write_summary
from .store import read_json_gz

SENT_PATH = DATA_DIR / "notify_sent.json"
FOLLOW_CONFIG = Path(__file__).resolve().parent.parent / "site" / "follow.json"   # the Worker's address
DB_NAME = "ercot-follows"
CF_API = "https://api.cloudflare.com/client/v4"
RESEND_API = "https://api.resend.com"
FROM = os.environ.get("NOTIFY_FROM") or "ERCOT bid explorer <alerts@currenttech.energy>"
MAX_DAYS = 14              # events first seen more than this many days ago are never emailed
DAILY_CAP = 90             # Resend's free plan sends 100 a day; leave room for confirmation emails
SEND_SLEEP = 0.6           # Resend allows about 2 requests a second
TIMEOUT = 30

_TRAIN = re.compile(r"^(.*_CC\d+)_")


def train_of(u):
    m = _TRAIN.match(u)
    return m.group(1) if m else u


def matches(e, unit):
    """Does event e belong on the page of `unit`?  Same rule as the Unit page (site/unit-events.js):
    the unit's own events, its configuration's (bidding is per configuration), or a plant event
    that lists it."""
    return e["unit"] == unit or train_of(e["unit"]) == unit or unit in e.get("units", [])


# ------------------------------------------------------------- follows (D1) ---
def read_follows(token):
    """[(email, unit, row token)] for confirmed follows, from the Worker's D1 database."""
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token}"
    acct = s.get(f"{CF_API}/accounts", timeout=TIMEOUT).json()["result"][0]["id"]
    dbs = s.get(f"{CF_API}/accounts/{acct}/d1/database", params={"name": DB_NAME}, timeout=TIMEOUT).json()["result"]
    db = next(d["uuid"] for d in dbs if d["name"] == DB_NAME)
    r = s.post(f"{CF_API}/accounts/{acct}/d1/database/{db}/query", timeout=TIMEOUT,
               json={"sql": "SELECT email, unit, token FROM follows WHERE status = 'active' ORDER BY email, unit"})
    r.raise_for_status()
    return [(x["email"], x["unit"], x["token"]) for x in r.json()["result"][0]["results"]]


# ------------------------------------------------------------------ content ---
def _unit_link(unit):
    return f"{SITE_URL}unit.html?unit={unit}"


def _kind(e):
    return KINDS.get(e["kind"], e["kind"])


INTRO = ("Today's update found changes for units you follow. Unit-level data comes from ERCOT's 60-day "
         "disclosure, so these are dated about two months back.")


def build_email(today, sections, worker, tokens):
    """(subject, html, text) for one follower.  sections: [(unit, [events])]; tokens: {unit: row token}."""
    units = [u for u, _ in sections]
    subject = f"ERCOT bid explorer: {', '.join(units[:3])}{' and more' if len(units) > 3 else ''} changed ({today})"
    h = [f"<p>{html.escape(INTRO)}</p>"]
    t = [INTRO, ""]
    for u, evs in sections:
        evs = sorted(evs, key=lambda e: e["date"], reverse=True)
        h.append(f'<h3><a href="{html.escape(_unit_link(u))}">{html.escape(u)}</a></h3><ul>')
        h += [f"<li><b>{e['date']}</b> · {html.escape(_kind(e))}: {html.escape(e['title'])}</li>" for e in evs]
        h.append(f'</ul><p style="font-size:12px"><a href="{worker}/unsubscribe?t={tokens[u]}">Stop following {html.escape(u)}</a></p>')
        t += [f"{u}  {_unit_link(u)}"] + [f"- {e['date']} · {_kind(e)}: {e['title']}" for e in evs]
        t += [f"Stop following {u}: {worker}/unsubscribe?t={tokens[u]}", ""]
    any_tok = tokens[units[0]]
    foot = (f"You get at most one of these a day, only when a unit you follow changed. Follow more units from their pages on "
            f"{SITE_URL}, or stop all emails: {worker}/unsubscribe?t={any_tok}&all=1")
    h.append(f'<p style="font-size:12px;color:#666">You get at most one of these a day, only when a unit you follow changed. '
             f'Follow more units from their pages on <a href="{SITE_URL}">the ERCOT bid explorer</a>, or '
             f'<a href="{worker}/unsubscribe?t={any_tok}&amp;all=1">stop all emails</a>.</p>')
    t.append(foot)
    return subject, "\n".join(h), "\n".join(t)


def build_owner_email(today, todo, followers, sent_to, skipped):
    """Every unit with a change today, and every followed unit that changed (a configuration or
    plant follow can differ from the event's unit), with follower and event counts."""
    subject = f"ERCOT bid explorer: owner's digest ({today})"
    units = sorted({e["unit"] for e in todo} | set(followers))
    rows = [(u, followers.get(u, 0), sum(1 for e in todo if matches(e, u))) for u in units]
    head = (f"{len(todo)} event(s) on {len({e['unit'] for e in todo})} unit(s) were found today. "
            f"{sent_to} follower email(s) went out" + (f"; {skipped} waited for tomorrow (daily cap)" if skipped else "") + ".")
    h = [f"<p>{html.escape(head)}</p>", "<table><tr><th align=left>Unit</th><th>Followers</th><th>Events</th></tr>"]
    h += [f'<tr><td><a href="{html.escape(_unit_link(u))}">{html.escape(u)}</a></td><td align=right>{f}</td><td align=right>{n}</td></tr>' for u, f, n in rows]
    h.append("</table>")
    t = [head, ""] + [f"{u}: {f} follower(s), {n} event(s)" for u, f, n in rows]
    return subject, "\n".join(h), "\n".join(t)


# ------------------------------------------------------------------- send ---
class Resend:
    def __init__(self, key):
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    def send(self, to, subject, html_body, text, unsubscribe=None):
        body = {"from": FROM, "to": [to], "subject": subject, "html": html_body, "text": text}
        if unsubscribe:
            body["headers"] = {"List-Unsubscribe": f"<{unsubscribe}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"}
        r = self.s.post(f"{RESEND_API}/emails", json=body, timeout=TIMEOUT)
        time.sleep(SEND_SLEEP)
        if r.status_code >= 400:
            raise RuntimeError(f"Resend {r.status_code}: {r.text[:300]}")
        return r.json().get("id")


# -------------------------------------------------------------------- main ---
def pending(ev, sent):
    """Events to consider today: first seen after the baseline, not already sent, not stale."""
    done = set(sent.get("event_ids", []))
    cutoff = (dt.date.today() - dt.timedelta(days=MAX_DAYS)).isoformat()
    base = ev.get("baseline")
    return [e for e in ev["events"] if e["id"] not in done and e["seen"] != base and e["seen"] >= cutoff]


def plan(todo, follows):
    """{email: [(unit, [events])]} for followers with changes, and {unit: followers} for the units
    that changed (keyed by the followed unit name)."""
    per = defaultdict(list)
    followers = defaultdict(int)
    for email, unit, _ in follows:
        evs = [e for e in todo if matches(e, unit)]
        if evs:
            per[email].append((unit, evs))
            followers[unit] += 1
    return per, followers


def run(dry_run=False):
    ev = read_json_gz(EVENTS_PATH, default=None)
    if not ev:
        print("notify: no events file, nothing to do")
        return 0
    key = os.environ.get("RESEND_API_KEY")
    cf = os.environ.get("CLOUDFLARE_API_TOKEN")
    owner = os.environ.get("OWNER_EMAIL")
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
        by_unit[e["unit"]].append(e)

    follows, worker = [], None
    if FOLLOW_CONFIG.exists():
        worker = json.loads(FOLLOW_CONFIG.read_text()).get("url")
    if cf and worker:
        try:
            follows = read_follows(cf)
        except Exception as ex:   # no follows read: keep the events for the next run
            warn(f"notify: couldn't read follows from Cloudflare, events kept for the next run: {ex}")
            return 1
    elif not dry_run:
        warn("notify: CLOUDFLARE_API_TOKEN or site/follow.json missing; no follower emails, owner digest only")
    per, followers = plan(todo, follows)
    tokens = {(e, u): t for e, u, t in follows}

    lines = ["### Subscriber emails", "",
             f"{len(todo)} new event(s) on {len(by_unit)} unit(s); {len(per)} follower(s) to email, "
             f"{len(follows)} confirmed follow(s) in all" + (" (dry run, nothing sent)" if dry_run else ""), ""]
    recipients = sorted(per)[:DAILY_CAP]
    skipped = len(per) - len(recipients)
    if dry_run:
        if recipients:
            subject, _, text = build_email(today, per[recipients[0]], worker or "<worker>",
                                           {u: tokens.get((recipients[0], u), "TOKEN") for u, _ in per[recipients[0]]})
            lines += ["<details><summary>The first follower email that would go out</summary>", "", f"**{subject}**", "", "```", text, "```", "</details>"]
        write_summary(lines)
        print("\n".join(lines))
        return 0

    api = Resend(key)
    ok, failed = 0, []
    for email in recipients:
        toks = {u: tokens[(email, u)] for u, _ in per[email]}
        subject, h, t = build_email(today, per[email], worker, toks)
        try:
            api.send(email, subject, h, t, unsubscribe=f"{worker}/unsubscribe?t={next(iter(toks.values()))}&all=1")
            ok += 1
        except Exception as ex:
            failed.append(email)
            warn(f"notify: send failed for one follower: {ex}")
    if recipients and not ok:
        warn("notify: every follower email failed; events kept for the next run")
        return 1
    if owner:
        try:
            api.send(owner, *build_owner_email(today, todo, followers, ok, skipped))
        except Exception as ex:
            warn(f"notify: owner digest failed: {ex}")
    # events go in the record once the day's emails are out; a capped or failed follower misses them
    sent["event_ids"] = sorted(set(sent["event_ids"]) | {e["id"] for e in todo})
    sent["sends"].append({"date": today, "provider": "resend", "events": len(todo), "emails": ok,
                          "failed": len(failed), "capped": skipped, "followers": dict(sorted(followers.items()))})
    sent["sends"] = sent["sends"][-400:]
    SENT_PATH.write_text(json.dumps(sent, separators=(",", ":")))
    lines.append(f"{ok} follower email(s) sent, {len(failed)} failed, {skipped} over the daily cap" +
                 ("; owner digest sent" if owner else "; no OWNER_EMAIL, no owner digest"))
    write_summary(lines)
    print("\n".join(lines))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="summarise the emails that would go out; send nothing, record nothing")
    args = ap.parse_args(argv)
    return run(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
