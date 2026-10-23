"""Keep every ERCOT file the pipeline downloads, so a reparse reads our own copy instead of
downloading the file from ERCOT again.

Files live in a private Cloudflare R2 bucket (S3-compatible), one object per ERCOT document:

    raw/<emil, lower case>/<doc id>

exactly the bytes ERCOT served.  ERCOT's document id is the key because the name of a 60-day
file carries its posting date (about operating day + 60), not the operating day.  The posting
time and file name from the archive listing go with each object as metadata (x-amz-meta-posted,
x-amz-meta-name).

ErcotAPI.download reads the bucket first, falls back to ERCOT on a miss and writes what ERCOT
served to the bucket.  Only zips are kept (an error page or empty body is never stored), and a
bucket that is not configured or not reachable only warns: the pipeline then downloads from
ERCOT as before.

Configured with repository secrets, given only to the jobs that fetch:
  R2_ENDPOINT           https://<account id>.r2.cloudflarestorage.com
  R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY    an R2 API token with Object Read & Write
  R2_BUCKET             optional, default "ercot-raw"

Requests are signed with AWS Signature V4 by hand (below), so no new package is needed.
"""
import datetime as dt
import hashlib
import hmac
import os
import time
from urllib.parse import quote

import requests

from .log import warn

# A run stops keeping files after this many bytes (and warns), so a bug cannot fill the bucket.
# Downloading carries on as before.  The whole 60-day history is roughly 10 to 20 GB.
RUN_LIMIT = int(float(os.environ.get("R2_RUN_LIMIT_GB") or 20) * 1e9)
REGION = "auto"             # R2 accepts "auto" for SigV4
SERVICE = "s3"


def _key(emil: str, doc_id) -> str:
    return f"raw/{emil.lower()}/{doc_id}"


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class RawStore:
    def __init__(self, endpoint=None, access_key=None, secret_key=None, bucket=None):
        self.endpoint = (endpoint or os.environ.get("R2_ENDPOINT") or "").rstrip("/")
        self.access_key = access_key or os.environ.get("R2_ACCESS_KEY_ID")
        self.secret_key = secret_key or os.environ.get("R2_SECRET_ACCESS_KEY")
        self.bucket = bucket or os.environ.get("R2_BUCKET") or "ercot-raw"
        self.enabled = bool(self.endpoint and self.access_key and self.secret_key)
        self.session = requests.Session()
        self.stats = {"hit": 0, "miss": 0, "stored": 0, "hit_bytes": 0, "stored_bytes": 0}
        self._failed = False        # warn once per run, then stop trying

    # ----------------------------------------------------------- signing ---
    def _headers(self, method: str, key: str, body: bytes = b"", extra=None, now=None) -> dict:
        now = now or dt.datetime.now(dt.timezone.utc)
        amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        host = self.endpoint.split("://", 1)[-1]
        payload = hashlib.sha256(body).hexdigest()
        headers = {"host": host, "x-amz-content-sha256": payload, "x-amz-date": amz_date}
        headers.update({k.lower(): str(v) for k, v in (extra or {}).items()})
        names = sorted(headers)
        canonical = "\n".join([
            method, self._path(key), "",
            "".join(f"{n}:{headers[n].strip()}\n" for n in names),
            ";".join(names), payload,
        ])
        scope = f"{day}/{REGION}/{SERVICE}/aws4_request"
        to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope,
                             hashlib.sha256(canonical.encode()).hexdigest()])
        k = _sign(f"AWS4{self.secret_key}".encode(), day)
        for part in (REGION, SERVICE, "aws4_request"):
            k = _sign(k, part)
        signature = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = (f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, "
                                    f"SignedHeaders={';'.join(names)}, Signature={signature}")
        del headers["host"]         # requests sets it
        return headers

    def _path(self, key: str) -> str:
        return f"/{quote(self.bucket)}/{quote(key, safe='/')}"

    def _url(self, key: str) -> str:
        return self.endpoint + self._path(key)

    def _give_up(self, what: str, e) -> None:
        if not self._failed:
            warn(f"raw store: {what} failed ({e}); downloading from ERCOT without keeping files for the rest of this run")
        self._failed = True

    # ------------------------------------------------------------- use -----
    def get(self, emil: str, doc_id):
        """The stored file, or None when it is not stored (or the bucket is unavailable)."""
        if not self.enabled or self._failed:
            return None
        key = _key(emil, doc_id)
        try:
            r = self.session.get(self._url(key), headers=self._headers("GET", key), timeout=300)
        except requests.RequestException as e:
            self._give_up(f"reading {key}", e)
            return None
        if r.status_code == 404:
            self.stats["miss"] += 1
            return None
        if r.status_code != 200:
            self._give_up(f"reading {key}", f"HTTP {r.status_code}: {r.text[:200]}")
            return None
        blob = r.content
        if blob[:2] != b"PK":       # never hand the parser anything but a zip
            self.stats["miss"] += 1
            return None
        self.stats["hit"] += 1
        self.stats["hit_bytes"] += len(blob)
        return blob

    def put(self, emil: str, doc_id, blob: bytes, doc=None) -> None:
        """Keep a downloaded file. Only zips are kept; failures only warn."""
        if not self.enabled or self._failed or blob[:2] != b"PK":
            return
        if self.stats["stored_bytes"] + len(blob) > RUN_LIMIT:
            self._give_up("storing", f"this run has stored {self.stats['stored_bytes'] / 1e9:.1f} GB, "
                                     f"the limit is {RUN_LIMIT / 1e9:.0f} GB (R2_RUN_LIMIT_GB)")
            return
        key = _key(emil, doc_id)
        meta = {}
        for field, name in (("postDatetime", "posted"), ("friendlyName", "name"), ("constructedName", "file")):
            v = (doc or {}).get(field)
            if v:
                meta[f"x-amz-meta-{name}"] = quote(str(v), safe="")   # header values must be ASCII
        extra = {"content-type": "application/zip", **meta}
        try:
            r = self.session.put(self._url(key), data=blob,
                                 headers=self._headers("PUT", key, blob, extra), timeout=600)
        except requests.RequestException as e:
            self._give_up(f"storing {key}", e)
            return
        if r.status_code != 200:
            self._give_up(f"storing {key}", f"HTTP {r.status_code}: {r.text[:200]}")
            return
        self.stats["stored"] += 1
        self.stats["stored_bytes"] += len(blob)

    def summary(self) -> str:
        s = self.stats
        return (f"raw store: {s['hit']} file(s) read from the bucket ({s['hit_bytes'] / 1e6:.0f} MB), "
                f"{s['miss']} not there, {s['stored']} stored ({s['stored_bytes'] / 1e6:.0f} MB)")


def timed(label: str, fn):
    """Run fn() and print how long it took and how big the result was."""
    t0 = time.time()
    blob = fn()
    print(f"    {label}: {len(blob) / 1e6:.1f} MB in {time.time() - t0:.1f}s", flush=True)
    return blob


def check() -> int:
    """A quick end-to-end check (the "Check raw store" workflow): write a small test object to the
    bucket and read it back, then fetch the newest 2-day SCED curves file twice through ErcotAPI;
    the second fetch must come from the bucket.  One ERCOT download at most."""
    import sys
    from .config import EMIL_2DAY
    from .ercot_api import ErcotAPI

    api = ErcotAPI()
    store = api.raw
    if not store.enabled:
        print("raw store: R2_ENDPOINT, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is not set")
        return 1
    test = b"PK raw store check " + dt.datetime.now(dt.timezone.utc).isoformat().encode()
    store.put("_check", "test", test)
    back = store.get("_check", "test")
    print(f"write and read back a test object: {'ok' if back == test else 'FAILED'}")
    if back != test:
        return 1
    now = dt.datetime.now()
    docs = sorted(api.list_archives(EMIL_2DAY, now - dt.timedelta(days=3), now + dt.timedelta(days=1)),
                  key=lambda d: d.get("postDatetime", ""))
    if not docs:
        print(f"no {EMIL_2DAY} file posted in the last 3 days to test with")
        return 1
    doc = docs[-1]
    print(f"fetching {doc.get('friendlyName', doc['docId'])} (doc {doc['docId']}) twice")
    hits = store.stats["hit"]
    first = api.download(EMIL_2DAY, doc["docId"])
    second = api.download(EMIL_2DAY, doc["docId"])
    from_store = store.stats["hit"] > hits
    ok = first == second and first[:2] == b"PK" and from_store
    print(f"same bytes both times: {first == second}; second fetch from the bucket: {from_store}")
    print(store.summary())
    print("raw store check:", "ok" if ok else "FAILED")
    sys.stdout.flush()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(check())
