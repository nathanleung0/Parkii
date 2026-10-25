"""Capture an offline evaluation set from public ParkSight previews; never write to Convex."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_BYTES = 5 * 1024 * 1024


def get_bytes(url):
    with urllib.request.urlopen(url, timeout=20) as response:
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("Frame exceeds capture budget")
    return raw


def query(origin, function):
    body = json.dumps({"path": function, "args": {}, "format": "json"}).encode()
    request = urllib.request.Request(origin + "/api/query", data=body,
                                    headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read(MAX_BYTES + 1))
    if payload.get("status") != "success" or not isinstance(payload.get("value"), list):
        raise ValueError("Public evaluation query failed")
    return payload["value"]


def capture(args):
    origin = args.origin.rstrip("/")
    if not re.fullmatch(r"https://[a-z0-9]+(?:-[a-z0-9]+)*\.convex\.cloud", origin):
        raise ValueError("Use an HTTPS Convex cloud origin")
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "manifest.json"
    records = json.loads(manifest_path.read_text()) if manifest_path.exists() else []
    seen = {(r["camera_id"], r["sha256"]) for r in records}
    fixed_cameras = {}
    cameras_path = root / "cameras.json"
    if cameras_path.exists():
        fixed_cameras = {c["camId"]: c for c in json.loads(cameras_path.read_text())}
    for round_index in range(args.rounds):
        cameras = query(origin, "parking:listCameras")
        stalls = query(origin, "parking:listStalls")
        for camera in cameras:
            cam_id = camera.get("camId", "")
            if cam_id not in args.cam_ids or not re.fullmatch(r"[A-Za-z0-9_-]+", cam_id):
                continue
            marked = [{"label": s["label"], "polygon": s["polygon"]} for s in stalls
                      if s.get("cameraId") == camera.get("_id")]
            calibration = {"camId": cam_id, "name": camera.get("name"), "stalls": marked}
            if cam_id in fixed_cameras and fixed_cameras[cam_id] != calibration:
                print(f"{cam_id}: calibration changed; skipped to keep evaluation comparable", flush=True)
                continue
            url = camera.get("frameUrl", "")
            parsed = urlsplit(url)
            if parsed.scheme != "https" or parsed.hostname != urlsplit(origin).hostname or not parsed.path.startswith("/api/storage/"):
                print(f"{cam_id}: no public preview", flush=True)
                continue
            try:
                raw = get_bytes(url)
            except (OSError, ValueError):
                print(f"{cam_id}: preview unavailable; wait for next capture", flush=True)
                continue
            if not raw.startswith(b"\xff\xd8\xff"):
                print(f"{cam_id}: not a JPEG preview", flush=True)
                continue
            digest = hashlib.sha256(raw).hexdigest()
            if (cam_id, digest) in seen:
                continue
            seen.add((cam_id, digest))
            now = datetime.now(timezone.utc)
            relative = f"{cam_id}/{now.strftime('%Y%m%dT%H%M%S')}_{digest[:8]}.jpg"
            target = root / "frames" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            fixed_cameras.setdefault(cam_id, calibration)
            records.append({"frame": relative, "camera_id": cam_id, "captured_at": now.isoformat(),
                            "backend_last_seen_ms": camera.get("lastSeen"), "source": "cloud-preview",
                            "sha256": digest, "capture_round": round_index, "label_source": "not labeled"})
            print(f"captured {relative}", flush=True)
        cameras_path.write_text(json.dumps(list(fixed_cameras.values()), indent=2) + "\n")
        manifest_path.write_text(json.dumps(records, indent=2) + "\n")
        if round_index + 1 < args.rounds:
            time.sleep(args.interval)
    print(f"Captured {len(records)} unique frames; no predictions or backend states were used as labels.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--output", default="worker/recordings/evaluation")
    parser.add_argument("--cam-ids", nargs="+", default=["castro-cam1", "castro-cam2", "castro-cam5"])
    parser.add_argument("--rounds", type=int, default=12)
    parser.add_argument("--interval", type=float, default=35)
    args = parser.parse_args()
    if not 1 <= args.rounds <= 60 or args.interval < 10:
        parser.error("rounds must be 1..60 and interval at least 10 seconds")
    capture(args)
