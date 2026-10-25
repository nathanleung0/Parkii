"""Turn a San Francisco place in a chat message into coordinates."""
import json
import os
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from typing import Callable, Optional

# Castro remains the demo default when a user supplies no destination.
CASTRO_CENTER = (37.7612, -122.4350)
VIEWBOX = "-122.53,37.84,-122.35,37.69"  # San Francisco: left,top,right,bottom
GEOCODER_URL = os.getenv("GEOCODER_URL", "https://nominatim.openstreetmap.org/search")

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

# "near X", "in X", "on X", "around X", "by X", "at X", "close to X"
_PLACE = re.compile(r"\b(?:in front of|close to|next to|near|around|outside|in|on|by|at)\s+(?:the\s+)?(.+?)[.?!]*$", re.I)

_last_nominatim = 0.0


@dataclass
class Place:
    lat: float
    lng: float
    label: str
    assumed: bool  # True when we defaulted to the Castro center because no place was given
    resolved: bool = True


def extract_place(text: str) -> Optional[str]:
    m = _PLACE.search(text.strip())
    return m.group(1).strip() if m else None


def _landmark(text: str) -> Optional[tuple]:
    phrase = extract_place(text)
    if phrase:
        key = phrase.lower().strip(" .,!? ")
        if key in LANDMARKS:
            return key, LANDMARKS[key]
    return None


@lru_cache(maxsize=2048)
def _nominatim(query: str) -> Optional[tuple]:
    """Cached, bounded SF lookup. Use a dedicated provider when scaling past one process."""
    global _last_nominatim
    wait = 1.0 - (time.monotonic() - _last_nominatim)
    if wait > 0:
        time.sleep(wait)
    _last_nominatim = time.monotonic()
    params = urllib.parse.urlencode({
        "q": f"{query}, San Francisco, CA", "format": "jsonv2", "limit": 1,
        "viewbox": VIEWBOX, "bounded": 1, "countrycodes": "us"})
    req = urllib.request.Request(f"{GEOCODER_URL}?{params}",
                                 headers={"User-Agent": "Parkii/0.1 (Cal Hacks 13.0 hackathon project)"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    return (float(rows[0]["lat"]), float(rows[0]["lon"])) if rows else None


def resolve(text: str, nominatim: Callable[[str], Optional[tuple]] = _nominatim) -> Place:
    """Never route an explicitly named but unresolved destination to Castro."""
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
        return Place(0, 0, phrase, False, False)
    return Place(CASTRO_CENTER[0], CASTRO_CENTER[1], "the Castro", True)
