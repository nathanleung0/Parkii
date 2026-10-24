"""Minimal JSON-over-HTTP helper (stdlib only) with an injectable transport for tests.

- Redirects are never followed, so credentials cannot be forwarded to another host.
- Retries are opt-in per call: at most one retry, only for timeouts, 429 and 5xx.
- Error messages never include request headers or bodies.
"""
import json
import socket
import urllib.error
import urllib.request
from typing import Any, Callable, Optional, Tuple

from .errors import ProviderError

# (method, url, headers, body, timeout_seconds) -> (status, parsed JSON or text or None)
Transport = Callable[[str, str, dict, Optional[bytes], float], Tuple[int, Any]]
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def _read_bounded(response):
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ProviderError("CONTENT_UNAVAILABLE", "provider response exceeded the size limit")
    return raw


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_transport(method: str, url: str, headers: dict, body: Optional[bytes], timeout: float):
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with _opener.open(req, timeout=timeout) as resp:
            status, raw = resp.status, _read_bounded(resp)
    except urllib.error.HTTPError as e:
        try:
            status, raw = e.code, _read_bounded(e)
        finally:
            e.close()
    except (socket.timeout, TimeoutError):
        raise ProviderError("PROVIDER_TIMEOUT", "provider request timed out")
    except urllib.error.URLError as e:
        if isinstance(e.reason, (socket.timeout, TimeoutError)):
            raise ProviderError("PROVIDER_TIMEOUT", "provider request timed out")
        raise ProviderError("INTERNAL_ERROR", "could not reach provider")
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")[:500]


def request_json(transport: Transport, method: str, url: str, headers: dict,
                 payload: Any = None, timeout: float = 20.0, retry: bool = False):
    """Returns (status, parsed). Raises ProviderError only for transport-level failures."""
    hdrs = dict(headers)
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    attempts = 2 if retry else 1
    for attempt in range(attempts):
        try:
            status, parsed = transport(method, url, hdrs, body, timeout)
        except ProviderError as e:
            if attempt + 1 < attempts and e.code == "PROVIDER_TIMEOUT":
                continue
            raise
        if attempt + 1 < attempts and (status == 429 or status >= 500):
            continue
        return status, parsed
    raise ProviderError("INTERNAL_ERROR", "unreachable")  # pragma: no cover
