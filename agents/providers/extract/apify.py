"""Apify Website Content Crawler adapter: one explicitly requested public article.

Budget: 60 s total (start + polling). The run is aborted when the budget is spent.
The start request is never retried (an unknown response may still have created a run);
status and dataset reads get at most one transient retry.
"""
import hashlib
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable, Optional

from ..provider_common import ProviderError, Transport, request_json, urllib_transport
from .url_guard import validate_public_url

API = "https://api.apify.com/v2"
ACTOR = "apify~website-content-crawler"
RUN_BUDGET_SECONDS = 60.0
CALL_TIMEOUT_SECONDS = 20.0
POLL_INTERVAL_SECONDS = 2.0
MAX_TEXT_CHARS = 50_000
MAX_TITLE_CHARS = 500
MIN_USABLE_CHARS = 200
_TERMINAL = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"}


@dataclass
class ExtractionResult:
    """`source` is a wire-shaped Source (contracts/JOSH.md Appendix C). When extraction fails,
    source.availability is "unavailable", it has no text, and `error` explains why."""
    source: dict
    error: Optional[dict] = None
    trace: dict = field(default_factory=dict)  # evidence: run id, status, timings (no secrets)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


class ApifyExtractor:
    def __init__(self, token: Optional[str] = None, transport: Transport = urllib_transport,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep,
                 resolver=None):
        self._token = token or os.environ.get("APIFY_TOKEN", "")
        if not self._token:
            raise ProviderError("UNAUTHORIZED", "APIFY_TOKEN is not set")
        self._transport, self._clock, self._sleep = transport, clock, sleep
        self._guard_kwargs = {"resolver": resolver} if resolver else {}

    def _call(self, method, path, payload=None, timeout=CALL_TIMEOUT_SECONDS, retry=False):
        headers = {"Authorization": f"Bearer {self._token}", "Accept": "application/json"}
        return request_json(self._transport, method, f"{API}{path}", headers, payload, timeout, retry)

    def extract_article(self, url: str, *, source_id: Optional[str] = None,
                        resource_id: Optional[str] = None) -> ExtractionResult:
        """Raises VALIDATION_ERROR for URLs that must never be sent to Apify (nothing is contacted).
        Provider failures return an unavailable Source plus a typed error instead of raising."""
        safe_url = validate_public_url(url, **self._guard_kwargs)

        started = self._clock()
        trace = {"requestedUrl": safe_url, "actor": ACTOR, "startedAt": _now()}

        def remaining() -> float:
            return RUN_BUDGET_SECONDS - (self._clock() - started)

        def call_timeout() -> float:
            return min(CALL_TIMEOUT_SECONDS, max(remaining(), 1.0))

        def unavailable(code: str, message: str) -> ExtractionResult:
            trace["elapsedSeconds"] = round(self._clock() - started, 2)
            return ExtractionResult(self._source(safe_url, None, "", source_id, resource_id, False),
                                    {"code": code, "message": message}, trace)

        try:
            status, body = self._call(
                "POST", f"/acts/{ACTOR}/runs",
                {"startUrls": [{"url": safe_url}], "maxCrawlPages": 1, "maxCrawlDepth": 0,
                 "saveMarkdown": False},
                timeout=call_timeout())
        except ProviderError as e:
            return unavailable(e.code, "could not start the extraction run (run state unknown)")
        run = body.get("data") if isinstance(body, dict) else None
        if status not in (200, 201) or not isinstance(run, dict) or not run.get("id"):
            code = "UNAUTHORIZED" if status in (401, 403) else "INTERNAL_ERROR"
            return unavailable(code, f"Apify did not start a run (HTTP {status})")
        run_id = run["id"]
        trace["apifyRunId"] = run_id

        run_status = run.get("status", "READY")
        while run_status not in _TERMINAL:
            if remaining() <= 0:
                self._abort(run_id)
                trace["finalStatus"] = "ABORT_REQUESTED_AFTER_BUDGET"
                return unavailable("PROVIDER_TIMEOUT", "extraction exceeded the 60 second budget")
            self._sleep(min(POLL_INTERVAL_SECONDS, max(remaining(), 0)))
            try:
                status, body = self._call("GET", f"/actor-runs/{run_id}", timeout=call_timeout(),
                                          retry=True)
            except ProviderError as e:
                self._abort(run_id)
                return unavailable(e.code, "lost contact with the extraction run")
            run = body.get("data") if isinstance(body, dict) else None
            if status != 200 or not isinstance(run, dict):
                self._abort(run_id)
                return unavailable("INTERNAL_ERROR", f"Apify status check failed (HTTP {status})")
            run_status = run.get("status", run_status)
        trace["finalStatus"] = run_status
        if run_status != "SUCCEEDED":
            return unavailable("CONTENT_UNAVAILABLE", f"extraction run ended as {run_status}")

        dataset_id = run.get("defaultDatasetId")
        try:
            status, items = self._call(
                "GET", f"/datasets/{dataset_id}/items?format=json&limit=1&clean=true",
                timeout=call_timeout(), retry=True)
        except ProviderError as e:
            return unavailable(e.code, "could not read the extraction result")
        if status != 200 or not isinstance(items, list) or not items or not isinstance(items[0], dict):
            return unavailable("CONTENT_UNAVAILABLE", "the page returned no content")
        item = items[0]

        loaded = (item.get("crawl") or {}).get("loadedUrl") or item.get("url") or safe_url
        try:
            trace["loadedUrl"] = validate_public_url(loaded, **self._guard_kwargs)
        except ProviderError:
            return unavailable("VALIDATION_ERROR",
                               "the page redirected to a private or invalid destination")

        text = _normalize(item.get("text") or "")
        if len(text) < MIN_USABLE_CHARS:
            return unavailable("CONTENT_UNAVAILABLE",
                               "the page returned little or no text (it may be blocked or behind a paywall)")
        title = ((item.get("metadata") or {}).get("title") or "").strip() or safe_url
        trace["elapsedSeconds"] = round(self._clock() - started, 2)
        return ExtractionResult(self._source(safe_url, title, text, source_id, resource_id, True, run_id),
                                None, trace)

    def _abort(self, run_id: str) -> None:
        try:
            self._call("POST", f"/actor-runs/{run_id}/abort", timeout=10.0)
        except ProviderError:
            pass  # best effort; Apify also enforces its own run timeout

    @staticmethod
    def _source(url, title, text, source_id, resource_id, ready, run_id=None) -> dict:
        text = text[:MAX_TEXT_CHARS]
        src = {
            "id": source_id or str(uuid.uuid4()),
            "url": url,
            "title": (title or url)[:MAX_TITLE_CHARS],
            "retrievedAt": _now(),
            "contentHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "extraction": "apify",
            "availability": "ready" if ready else "unavailable",
        }
        if resource_id:
            src["resourceId"] = resource_id
        if ready:
            src["text"] = text
            src["apifyRunId"] = run_id
        return src


def extract_article(url: str, **kwargs) -> ExtractionResult:
    """Module-level convenience: uses APIFY_TOKEN from the environment."""
    return ApifyExtractor().extract_article(url, **kwargs)


extractArticle = extract_article  # name used in the shared contract
