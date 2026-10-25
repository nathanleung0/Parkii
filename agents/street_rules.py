"""Street-cleaning lookup from DataSF's Street Sweeping Schedule (public Socrata dataset yhqp-riqs).

Pure functions (`nearest_block`, `next_sweep`, `describe`) are unit-tested without network access;
`lookup` does the one HTTPS call. Times are San Francisco local time.
"""
import json
import math
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

DATASET = "https://data.sf.gov/resource/yhqp-riqs.json"
SF_TZ = ZoneInfo("America/Los_Angeles")
SEARCH_RADIUS_DEG_LAT = 0.00030  # ~33 m
SEARCH_RADIUS_DEG_LNG = 0.00038  # ~33 m at SF's latitude
TIMEOUT_S = 10

# DataSF weekday strings -> Python weekday() (Monday = 0)
WEEKDAYS = {"Mon": 0, "Tues": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
LONG_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass
class Sweep:
    corridor: str
    limits: str
    side: str
    weekday: int  # Monday = 0
    start_hour: int
    end_hour: int
    weeks: tuple  # which occurrence of the weekday in the month (1..5) is swept


def _meters(lat: float, lng: float, lat2: float, lng2: float) -> float:
    dy = (lat2 - lat) * 111_320
    dx = (lng2 - lng) * 111_320 * math.cos(math.radians(lat))
    return math.hypot(dx, dy)


def _segment_distance(lat: float, lng: float, a: list, b: list) -> float:
    """Distance in meters from a point to segment a->b; a, b are [lng, lat]."""
    ax, ay = a[0], a[1]
    bx, by = b[0], b[1]
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((lng - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy)))
    return _meters(lat, lng, ay + t * dy, ax + t * dx)


def _row_distance(lat: float, lng: float, row: dict) -> float:
    coords = (row.get("line") or {}).get("coordinates") or []
    if len(coords) < 2:
        return float("inf")
    return min(_segment_distance(lat, lng, coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def parse_rows(rows: list) -> list:
    out = []
    for r in rows:
        day = WEEKDAYS.get(r.get("weekday", ""))
        try:
            start, end = int(r["fromhour"]), int(r["tohour"])
        except (KeyError, TypeError, ValueError):
            continue
        if day is None:
            continue
        weeks = tuple(i for i in range(1, 6) if str(r.get(f"week{i}", "0")) == "1")
        if not weeks:
            continue
        out.append((r, Sweep(r.get("corridor", "?"), r.get("limits", ""), r.get("blockside", ""),
                             day, start, end, weeks)))
    return out


def nearest_block(lat: float, lng: float, rows: list) -> list:
    """All sweeps on the single closest block face (same corridor, limits and side)."""
    parsed = parse_rows(rows)
    if not parsed:
        return []
    best_row, best = min(parsed, key=lambda p: _row_distance(lat, lng, p[0]))
    key = (best.corridor, best.limits, best.side)
    return [s for _, s in parsed if (s.corridor, s.limits, s.side) == key]


def _week_of_month(d: datetime) -> int:
    return (d.day - 1) // 7 + 1


def next_sweep(sweeps: list, now: Optional[datetime] = None) -> Optional[tuple]:
    """(start datetime, Sweep) of the soonest sweep that hasn't ended yet, or None."""
    now = (now or datetime.now(SF_TZ)).astimezone(SF_TZ)
    best = None
    for s in sweeps:
        for offset in range(0, 36):  # long enough to reach every 5th-week-only schedule
            day = (now + timedelta(days=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
            if day.weekday() != s.weekday or _week_of_month(day) not in s.weeks:
                continue
            start = day.replace(hour=s.start_hour)
            end = day.replace(hour=s.end_hour)
            if end <= now:
                continue
            if best is None or start < best[0]:
                best = (start, s)
            break
    return best


def describe(sweeps: list, now: Optional[datetime] = None) -> dict:
    """Short, driver-facing summary plus the structured next sweep."""
    now = (now or datetime.now(SF_TZ)).astimezone(SF_TZ)
    nxt = next_sweep(sweeps, now)
    if not sweeps or nxt is None:
        return {"warning": None, "text": "No street-cleaning restriction found for this block.", "next": None}
    start, s = nxt
    hours_away = (start - now).total_seconds() / 3600
    when = f"{LONG_NAMES[s.weekday]} {_fmt_hour(s.start_hour)}-{_fmt_hour(s.end_hour)}"
    if start <= now:  # sweeping is happening right now
        text = f"Street cleaning is in effect right now on {s.corridor} ({s.side} side) until {_fmt_hour(s.end_hour)}. Don't park here."
        warning = "now"
    elif hours_away < 24:
        text = f"Street cleaning on {s.corridor} ({s.side} side) starts {when} - less than a day away. You'd need to move your car."
        warning = "soon"
    else:
        text = f"Next street cleaning on {s.corridor} ({s.side} side): {when}. Move your car before then."
        warning = "later"
    return {
        "warning": warning,
        "text": text,
        "next": {"corridor": s.corridor, "side": s.side, "limits": s.limits, "start": start.isoformat(),
                 "endHour": s.end_hour},
    }


def _fmt_hour(h: int) -> str:
    return f"{h % 12 or 12}{'am' if h < 12 else 'pm'}"


def lookup(lat: float, lng: float, now: Optional[datetime] = None, fetch=None) -> dict:
    """Street-cleaning summary for a stall location. `fetch(url) -> list[dict]` is injectable for tests."""
    box = (f"POLYGON(({lng - SEARCH_RADIUS_DEG_LNG} {lat - SEARCH_RADIUS_DEG_LAT}, "
           f"{lng + SEARCH_RADIUS_DEG_LNG} {lat - SEARCH_RADIUS_DEG_LAT}, "
           f"{lng + SEARCH_RADIUS_DEG_LNG} {lat + SEARCH_RADIUS_DEG_LAT}, "
           f"{lng - SEARCH_RADIUS_DEG_LNG} {lat + SEARCH_RADIUS_DEG_LAT}, "
           f"{lng - SEARCH_RADIUS_DEG_LNG} {lat - SEARCH_RADIUS_DEG_LAT}))")
    query = urllib.parse.urlencode({"$where": f"intersects(line, '{box}')", "$limit": "50"})
    url = f"{DATASET}?{query}"
    try:
        rows = (fetch or _fetch)(url)
    except Exception as e:  # network/provider failure must not break the parking answer
        return {"warning": None, "text": None, "next": None, "error": type(e).__name__}
    return describe(nearest_block(lat, lng, rows), now)


def _fetch(url: str) -> list:
    req = urllib.request.Request(url, headers={"User-Agent": "Parkii/0.1 (Cal Hacks 13.0)"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:  # redirects to data.sf.gov are followed
        return json.loads(resp.read().decode("utf-8"))
