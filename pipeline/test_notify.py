"""Checks that pipeline/notify.py never puts a follower's address or a working link in the run
log or summary, which are public on this repository.  Needs no network or secrets:

    python -m pipeline.test_notify

Runs notify with fake follows and events, captures stdout and the summary file, and fails if a
follower's email address or row token shows up in either.
"""
import contextlib
import datetime as dt
import io
import json
import os
import sys
import tempfile
from pathlib import Path

from . import notify

EMAIL = "follower@example.com"
TOKEN = "f00dfacecafe" * 4


def _run(env, dry_run=False):
    """(return code, stdout + summary text) of one notify run on fake data."""
    today = dt.date.today().isoformat()
    events = {"baseline": "2000-01-01", "events": [
        {"id": "CPSES_UNIT1|x|group", "unit": "CPSES_UNIT1", "kind": "group", "title": "moved group",
         "date": today, "seen": today}]}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        sent = tmp / "notify_sent.json"
        sent.write_text(json.dumps({"started": "2000-01-01", "event_ids": [], "sends": []}))
        follow = tmp / "follow.json"
        follow.write_text(json.dumps({"url": "https://follows.example.workers.dev"}))
        summary = tmp / "summary.md"
        saved = {k: os.environ.get(k) for k in [*env, "GITHUB_STEP_SUMMARY"]}
        orig = (notify.read_json_gz, notify.read_follows, notify.SENT_PATH, notify.FOLLOW_CONFIG)
        try:
            os.environ["GITHUB_STEP_SUMMARY"] = str(summary)
            for k, v in env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            notify.read_json_gz = lambda path, default=None: events
            notify.read_follows = lambda token: [(EMAIL, "CPSES_UNIT1", TOKEN)]
            notify.SENT_PATH, notify.FOLLOW_CONFIG = sent, follow
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = notify.run(dry_run=dry_run)
        finally:
            notify.read_json_gz, notify.read_follows, notify.SENT_PATH, notify.FOLLOW_CONFIG = orig
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        text = out.getvalue() + (summary.read_text() if summary.exists() else "")
    return rc, text


def main():
    cases = {
        "dry run (NOTIFY_DRY_RUN=1)": ({"RESEND_API_KEY": "re_x", "CLOUDFLARE_API_TOKEN": "cf_x", "NOTIFY_DRY_RUN": "1"}, False),
        "dry run (--dry-run)": ({"RESEND_API_KEY": "re_x", "CLOUDFLARE_API_TOKEN": "cf_x", "NOTIFY_DRY_RUN": None}, True),
        "no RESEND_API_KEY": ({"RESEND_API_KEY": None, "CLOUDFLARE_API_TOKEN": "cf_x", "NOTIFY_DRY_RUN": None}, False),
    }
    failed = 0
    for name, (env, dry) in cases.items():
        rc, text = _run(env, dry)
        leaks = [w for w in (EMAIL, TOKEN) if w in text]
        ok = rc == 0 and not leaks
        failed += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f": log shows {leaks}" if leaks else "") + (f": exit {rc}" if rc else ""))
    if "TOKEN" not in _run(cases["dry run (NOTIFY_DRY_RUN=1)"][0])[1]:
        failed += 1
        print("FAIL dry run: the sample email is missing")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
