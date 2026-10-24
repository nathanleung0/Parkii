"""Turn the place in a chat message into coordinates (Castro landmarks first, Nominatim fallback in SF)."""
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Callable, Optional

# Castro / Market / 18th area, the only place our cameras cover.
CASTRO_CENTER = (37.7612, -122.4350)
VIEWBOX = "-122.4450,37.7680,-122.4250,37.7540"  # left,top,right,bottom for Nominatim

LANDMARKS = {
    "castro theatre": (37.76200, -122.43480),
    "castro theater": (37.76200, -122.43480),
    "castro muni": (37.76264, -122.43500),
    "castro station": (37.76264, -122.43500),
    "harvey milk plaza": (37.76260, -122.43515),
    "castro and market": (37.76255, -122.43510),
    "castro & market": (37.76255, -122.43510),
    "market and castro": (37.76255, -122.43510),
    "castro and 18th": (37.76092, -122.43485),
    "castro & 18th": (37.76092, -122.43485),
    "18th and castro": (37.76092, -122.43485),
    "castro and 17th": (37.76195, -122.43490),
    "castro street": CASTRO_CENTER,
    "the castro": CASTRO_CENTER,
    "castro": CASTRO_CENTER,
}

# "near X", "around X", "by X", "at X", "close to X", "next to X"
_PLACE = re.compile(r"\b(?:near|around|by|at|close to|next to|in front of|outside)\s+(?:the\s+)?(.+?)[.?!]*$", re.I)

_last_nominatim = 0.0


@dataclass
class Place:
    lat: float
    lng: float
    label: str
    assumed: bool  # True when we defaulted to the Castro center because no place was given


def extract_place(text: str) -> Optional[str]:
    m = _PLACE.search(text.strip())
    return m.group(1).strip() if m else None


def _landmark(text: str) -> Optional[tuple]:
    lowered = text.lower()
    # longest key first so "castro theatre" wins over "castro"
    for key in sorted(LANDMARKS, key=len, reverse=True):
        if key in lowered:
            return key, LANDMARKS[key]
    return None


def _nominatim(query: str) -> Optional[tuple]:
    """One request per second, bounded to the Castro viewbox, identified User-Agent (Nominatim policy)."""
    global _last_nominatim
    wait = 1.0 - (time.monotonic() - _last_nominatim)
    if wait > 0:
        time.sleep(wait)
    _last_nominatim = time.monotonic()
    params = urllib.parse.urlencode({
        "q": f"{query}, San Francisco, CA", "format": "jsonv2", "limit": 1,
        "viewbox": VIEWBOX, "bounded": 1, "countrycodes": "us"})
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/search?{params}",
                                 headers={"User-Agent": "ParkSight/0.1 (Cal Hacks 13.0 hackathon project)"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    return (float(rows[0]["lat"]), float(rows[0]["lon"])) if rows else None


def resolve(text: str, nominatim: Callable[[str], Optional[tuple]] = _nominatim) -> Place:
    """Never raises: falls back to the Castro center and says so via `assumed`."""
    hit = _landmark(text)
    if hit:
        key, (lat, lng) = hit
        return Place(lat, lng, key.title().replace("Theater", "Theatre"), False)
    phrase = extract_place(text)
    if phrase:
        try:
            found = nominatim(phrase)
        except Exception:
            found = None
        if found:
            return Place(found[0], found[1], phrase, False)
    return Place(CASTRO_CENTER[0], CASTRO_CENTER[1], "the Castro", True)
