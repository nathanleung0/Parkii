"""Calls the Parkii Convex backend (POST /agent/find)."""
import json
import os
import urllib.error
import urllib.request


class ParkiiError(Exception):
    """Message is safe to show the user."""


def find_spot(text: str, lat: float, lng: float, session_id: str, post=None) -> dict:
    """Ask Convex for a held spot. `post(url, headers, body) -> (status, bytes)` is injectable for tests."""
    mode = os.environ.get("PARKII_PARKING_MODE", "assistant").strip().lower()
    if mode == "nearest":
        from .nearest_client import find_nearest
        return find_nearest(lat, lng, session_id, post=post)
    if mode != "assistant":
        raise ParkiiError("The parking selection mode isn't configured correctly.")
    site = os.environ.get("CONVEX_SITE_URL") or os.environ.get("VITE_CONVEX_SITE_URL", "")
    secret = os.environ.get("AGENT_SECRET", "")
    if not site or not secret:
        raise ParkiiError("The parking backend isn't configured yet.")
    body = json.dumps({"text": text, "lat": lat, "lng": lng, "sessionId": session_id}).encode()
    headers = {"Content-Type": "application/json", "x-agent-secret": secret}
    status, raw = (post or _post)(f"{site.rstrip('/')}/agent/find", headers, body)
    if status != 200:
        raise ParkiiError("The parking backend didn't answer. Try again in a moment.")
    return json.loads(raw)


def _post(url: str, headers: dict, body: bytes):
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:  # Claude + hold can take a few seconds
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, TimeoutError):
        return 0, b""
