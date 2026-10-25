"""Compose the ASI:One chat reply. Plain markdown, no raw JSON or backend error text."""
from typing import Optional

HOLD_MINUTES = 3


def directions_url(lat: float, lng: float) -> str:
    return f"https://www.google.com/maps/dir/?api=1&destination={lat},{lng}&travelmode=driving"


def compose(result: dict, place_label: str, assumed: bool, rules: Optional[dict]) -> str:
    spot = result.get("spot")
    if not spot:
        return result.get("reply") or "I couldn't find an open spot on the cameras right now. Try again in a minute."

    lines = [result.get("reply", "").strip() or f"Spot {spot['label']} looks open.", ""]
    lines.append(f"**Spot {spot['label']}** on {spot['camera']} won't be shown to other ParkSight users for {HOLD_MINUTES} minutes. Anyone may still take it.")
    detail = f"{spot['distanceM']} m from {place_label}"
    if assumed:
        detail += " (you didn't name a place, so I used the middle of the Castro)"
    lines.append(f"- {detail}")
    lines.append(f"- Processed {spot['ageS']}s ago from a camera, {round(spot['confidence'] * 100)}% detection agreement. "
                 "Camera data can lag, so look before you pull in.")

    if rules:
        cleaning = (rules.get("streetCleaning") or {}).get("text")
        if cleaning:
            lines.append(f"- 🧹 {cleaning}")
        hit = (rules.get("hits") or [None])[0]
        if hit and hit.get("excerpt"):
            source = f" ([source]({hit['url']}))" if hit.get("url") else ""
            lines.append(f"- 📋 {hit['excerpt']}{source}")

    links = []
    if result.get("frameUrl"):
        label = "Camera thumbnail (may lag)" if result.get("frameKind") == "thumbnail" else "Latest camera frame"
        links.append(f"[{label}]({result['frameUrl']})")
    if result.get("cameraUrl"):
        links.append(f"[Live camera]({result['cameraUrl']})")
    links.append(f"[Directions]({directions_url(spot['lat'], spot['lng'])})")
    lines += ["", " · ".join(links)]
    return "\n".join(lines)

