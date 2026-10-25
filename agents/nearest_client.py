"""Reuse the web app's public Convex findSpot mutation without a language-model call."""
import json
import math
import os
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from .convex_client import ParkSightError

MAX_RESPONSE_BYTES = 1_000_000
ERROR = "The parking backend didn't answer correctly. Try again in a moment."


def _number(value, low, high):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def _origin(env=None):
    env = os.environ if env is None else env
    value = env.get("CONVEX_URL") or env.get("VITE_CONVEX_URL")
    suffix = ".convex.cloud"
    if not value:
        value = env.get("CONVEX_SITE_URL") or env.get("VITE_CONVEX_SITE_URL", "")
        suffix = ".convex.site"
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        slug = host.removesuffix(suffix)
        valid = (value == value.strip() and not any(c.isspace() or ord(c) < 32 for c in value)
                 and parsed.scheme == "https" and host.endswith(suffix) and bool(slug)
                 and all(c in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in slug)
                 and slug[0].isalnum() and slug[-1].isalnum()
                 and parsed.username is None and parsed.password is None and parsed.port is None
                 and parsed.netloc.lower() == host and parsed.path in ("", "/")
                 and not parsed.query and not parsed.fragment)
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ParkSightError("Configure a valid HTTPS Convex cloud deployment for nearest-spot mode.")
    return "https://" + slug + ".convex.cloud"


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _post(url, headers, body):
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.build_opener(_NoRedirects()).open(request, timeout=20) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ParkSightError(ERROR)
            return response.status, raw
    except urllib.error.HTTPError as error:
        return error.code, b""
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b""


def _call(origin, kind, function, args, post):
    body = json.dumps({"path": function, "args": args, "format": "json"}).encode()
    status, raw = post(origin + "/api/" + kind, {"Content-Type": "application/json"}, body)
    if status != 200 or not isinstance(raw, bytes) or len(raw) > MAX_RESPONSE_BYTES:
        raise ParkSightError(ERROR)
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ParkSightError(ERROR) from None
    if not isinstance(payload, dict) or payload.get("status") != "success" or "value" not in payload:
        raise ParkSightError(ERROR)
    return payload["value"]


def _valid_spot(spot):
    return (isinstance(spot, dict)
            and all(isinstance(spot.get(k), str) and 0 < len(spot[k]) <= 256 for k in ("stallId", "label", "camera"))
            and _number(spot.get("lat"), -90, 90) and _number(spot.get("lng"), -180, 180)
            and _number(spot.get("distanceM"), 0, 50_000_000)
            and _number(spot.get("confidence"), 0, 1) and _number(spot.get("ageS"), 0, 90)
            and _number(spot.get("expiresAt"), 1, 10_000_000_000_000)
            and spot["expiresAt"] > time.time() * 1000)


def _camera_links(origin, spot, post):
    try:
        cameras = _call(origin, "query", "parking:listCameras", {}, post)
        if not isinstance(cameras, list) or len(cameras) > 100:
            return {}
        matches = [c for c in cameras if isinstance(c, dict) and c.get("name") == spot["camera"]]
        if len(matches) != 1:
            return {}
        video_id = matches[0].get("youtubeId")
        # The current public camera API intentionally omits private source fields.
        # A fixed official directory remains useful without inventing a frame URL.
        if video_id is None and matches[0].get("camId") in {f"castro-cam{i}" for i in range(1, 6)}:
            return {"cameraUrl": "https://sfbaytimes.com/castro-street-cam/", "cameraLinkKind": "directory"}
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            return {}
        # Ingest deletes the preceding stored frame. Stable links use the same public camera
        # source as worker/sources.py, explicitly labeled as a potentially lagging thumbnail.
        return {"cameraUrl": "https://www.youtube.com/watch?v=" + video_id,
                "frameUrl": "https://i.ytimg.com/vi/" + video_id + "/maxresdefault_live.jpg",
                "frameKind": "thumbnail"}
    except ParkSightError:
        return {}  # Never retry or replace the already-created hold for a camera-link failure.


def find_nearest(lat, lng, session_id, post=None):
    """The existing shared mutation owns freshness, conflicts and the three-minute app hold."""
    if (not _number(lat, -90, 90) or not _number(lng, -180, 180)
            or not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 250):
        raise ParkSightError("Provide a valid location and chat session before finding parking.")
    origin = _origin()
    transport = post or _post
    # Use the same namespace as /agent/find; never accept a caller-selected function name.
    spot = _call(origin, "mutation", "parking:findSpot",
                 {"lat": lat, "lng": lng, "sessionId": "agent:" + session_id}, transport)
    mode = "Nearest-spot mode (no language model)"
    if spot is None:
        return {"spot": None, "reply": mode + ": no fresh, open spots are available on the cameras right now.",
                "frameUrl": None, "selectionMode": "nearest"}
    if not _valid_spot(spot):
        raise ParkSightError(ERROR)
    links = _camera_links(origin, spot, transport)
    return {"spot": spot, "reply": mode + f": {spot['label']} is the nearest available spot.",
            "frameUrl": links.get("frameUrl"), "frameKind": links.get("frameKind"),
            "cameraUrl": links.get("cameraUrl"), "cameraLinkKind": links.get("cameraLinkKind"), "selectionMode": "nearest"}
