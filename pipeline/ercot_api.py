"""Minimal client for the ERCOT Public API (https://apiexplorer.ercot.com).

Credentials come from environment variables:
  ERCOT_API_USERNAME, ERCOT_API_PASSWORD, ERCOT_API_SUBSCRIPTION_KEY
"""
import datetime as dt
import os
import random
import time
from typing import List

import requests

from .raw_store import RawStore, timed

BASE = "https://api.ercot.com/api/public-reports"
TOKEN_URL = ("https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/"
             "B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token")
CLIENT_ID = "fec253ea-0d06-4272-a5e6-b478baeecd70"
SCOPE = f"openid {CLIENT_ID} offline_access"


class ErcotAPI:
    def __init__(self, username=None, password=None, subscription_key=None, pause=2.1):
        self.username = username or os.environ.get("ERCOT_API_USERNAME")
        self.password = password or os.environ.get("ERCOT_API_PASSWORD")
        self.key = subscription_key or os.environ.get("ERCOT_API_SUBSCRIPTION_KEY")
        missing = [n for n, v in [("ERCOT_API_USERNAME", self.username),
                                  ("ERCOT_API_PASSWORD", self.password),
                                  ("ERCOT_API_SUBSCRIPTION_KEY", self.key)] if not v]
        if missing:
            raise RuntimeError(f"Missing ERCOT API credentials: {', '.join(missing)}")
        self.pause = pause            # seconds between calls (API allows ~30 calls/minute)
        self._token = None
        self._token_time = 0.0
        self._last_call = 0.0
        self.session = requests.Session()
        self.raw = RawStore()         # our own copy of every file downloaded (pipeline/raw_store.py)
        self._docs = {}               # (emil, doc id) -> archive listing entry, for the copy's metadata
        self.store_only = False       # download() reads only the raw store, never ERCOT (reprocess runs)

    # ------------------------------------------------------------ auth ----
    def _id_token(self) -> str:
        # ID tokens last one hour; renew after 50 minutes.
        if self._token and time.time() - self._token_time < 50 * 60:
            return self._token
        form = {"username": self.username, "password": self.password,
                "grant_type": "password", "scope": SCOPE,
                "client_id": CLIENT_ID, "response_type": "id_token"}
        # ERCOT's own examples pass these in the query string; fall back to a form body.
        r = self.session.post(TOKEN_URL, params=form, timeout=30)
        if r.status_code != 200:
            r = self.session.post(TOKEN_URL, data=form, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"ERCOT token request failed ({r.status_code}): {r.text[:300]}")
        self._token = r.json()["id_token"]
        self._token_time = time.time()
        return self._token

    def _request(self, method, url, **kw):
        for attempt in range(6):
            wait = self.pause - (time.time() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            headers = {"Authorization": f"Bearer {self._id_token()}",
                       "Ocp-Apim-Subscription-Key": self.key}
            self._last_call = time.time()
            try:
                r = self.session.request(method, url, headers=headers, timeout=300, **kw)
            except requests.RequestException as e:
                err = e
                r = None
            if r is not None and r.status_code == 200:
                return r
            if r is not None and r.status_code == 401:
                self._token = None            # token expired; fetch a new one
            if r is not None and r.status_code not in (401, 429, 500, 502, 503, 504):
                raise RuntimeError(f"{method} {url} -> {r.status_code}: {r.text[:300]}")
            delay = min(120, 5 * 2 ** attempt) * (1 + random.random() * 0.1)
            print(f"  retrying in {delay:.0f}s ({r.status_code if r is not None else err})")
            time.sleep(delay)
        raise RuntimeError(f"{method} {url} failed after retries")

    # --------------------------------------------------------- archives ---
    def list_archives(self, emil: str, posted_from: dt.datetime, posted_to: dt.datetime) -> List[dict]:
        """All archive documents for a report posted in [posted_from, posted_to)."""
        out, page = [], 1
        while True:
            r = self._request("GET", f"{BASE}/archive/{emil}", params={
                "postDatetimeFrom": posted_from.strftime("%Y-%m-%dT%H:%M:%S"),
                "postDatetimeTo": posted_to.strftime("%Y-%m-%dT%H:%M:%S"),
                "size": 1000, "page": page,
            })
            js = r.json()
            out.extend(js.get("archives", []))
            for doc in js.get("archives", []):
                if "docId" in doc:
                    self._docs[(emil, doc["docId"])] = doc
            total_pages = js.get("_meta", {}).get("totalPages", 1) or 1
            if page >= total_pages:
                break
            page += 1
        return out

    def download(self, emil: str, doc_id: int) -> bytes:
        """One archive document: our stored copy when there is one, else from ERCOT (and kept), unless
        store_only is set."""
        blob = self.raw.get(emil, doc_id)
        if blob is not None:
            print(f"    doc {doc_id}: {len(blob) / 1e6:.1f} MB from the raw store", flush=True)
            return blob
        if self.store_only:
            raise RuntimeError(f"doc {doc_id} is not in the raw store, and this run reads only the store")
        blob = timed(f"doc {doc_id} from ERCOT",
                     lambda: self._request("GET", f"{BASE}/archive/{emil}", params={"download": doc_id}).content)
        self.raw.put(emil, doc_id, blob, self._docs.get((emil, doc_id)))
        return blob

    def download_many(self, emil: str, doc_ids: List[int]) -> List[bytes]:
        """Bulk download (zip of zips), 1000 documents per request.  Not kept in the raw store:
        these are the many small price and load files, quick to download again."""
        blobs = []
        for i in range(0, len(doc_ids), 1000):
            r = self._request("POST", f"{BASE}/archive/{emil}/download",
                              json={"docIds": list(doc_ids[i:i + 1000])})
            blobs.append(r.content)
        return blobs
