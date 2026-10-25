"""Analyze only NYC DOT cameras recently selected in the review UI.

Run separately from poll.py so catalog browsing cannot slow parking occupancy.
The worker uploads the exact JPEG it analyzed alongside its boxes; the UI
never overlays detections on a different, newer camera image.
"""

import argparse
import base64
import hashlib
import time

import cv2
import requests
import torch._utils  # noqa: F401  needed by some torch checkpoints
from ultralytics import YOLO

from poll import load_env, VEHICLE_CLASSES
from sources import grab_snapshot


def detect(model: YOLO, image, confidence: float, size: int) -> list[list[float]]:
    height, width = image.shape[:2]
    result = model.predict(image, classes=VEHICLE_CLASSES, conf=confidence,
                           imgsz=size, verbose=False)[0]
    boxes = []
    for (x1, y1, x2, y2), score, class_id in zip(
        result.boxes.xyxy.tolist(), result.boxes.conf.tolist(), result.boxes.cls.tolist()
    ):
        boxes.append([
            round(x1 / width, 4), round(y1 / height, 4),
            round(x2 / width, 4), round(y2 / height, 4),
            round(score, 3), int(class_id),
        ])
    return boxes


def run(args):
    env = load_env()
    site = env.get("CONVEX_SITE_URL") or env["VITE_CONVEX_SITE_URL"]
    secret = env.get("INGEST_SECRET")
    if not secret:
        raise RuntimeError("INGEST_SECRET is required in .env.local or the environment")
    headers = {"x-ingest-secret": secret}
    model = YOLO(args.model)
    last_sent: dict[str, float] = {}
    last_digest: dict[str, str] = {}
    while True:
        try:
            queue_response = requests.get(f"{site}/nyc-analysis-queue", headers=headers, timeout=10)
            queue_response.raise_for_status()
            queue = queue_response.json()
            for camera in queue:
                camera_id = camera["cameraId"]
                if time.time() - last_sent.get(camera_id, 0) < args.refresh:
                    continue
                try:
                    image = grab_snapshot(camera["imageUrl"])
                    if image is None:
                        continue
                    ok, jpg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not ok:
                        continue
                    digest = hashlib.blake2b(jpg.tobytes(), digest_size=8).hexdigest()
                    if digest == last_digest.get(camera_id):
                        last_sent[camera_id] = time.time()
                        print(f"[nyc] {camera_id} source image unchanged", flush=True)
                        continue
                    start = time.perf_counter()
                    vehicles = detect(model, image, args.conf, args.imgsz)
                    payload = {
                        "cameraId": camera_id,
                        "observedAt": int(time.time() * 1000),
                        "frame": base64.b64encode(jpg.tobytes()).decode("ascii"),
                        "vehicles": vehicles,
                    }
                    response = requests.post(f"{site}/nyc-observation", json=payload,
                                             headers=headers, timeout=20)
                    response.raise_for_status()
                    last_sent[camera_id] = time.time()
                    last_digest[camera_id] = digest
                    print(f"[nyc] {camera_id}: {len(vehicles)} candidates in "
                          f"{time.perf_counter() - start:.1f}s", flush=True)
                except (requests.RequestException, ValueError, KeyError) as error:
                    print(f"[nyc] {camera_id}: {type(error).__name__}: {error}", flush=True)
        except (requests.RequestException, ValueError) as error:
            print(f"[nyc] queue unavailable: {type(error).__name__}", flush=True)
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--model", default="yolo11s.pt")
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--refresh", type=float, default=30)
    args = parser.parse_args()
    if args.interval <= 0 or args.refresh <= 0:
        parser.error("interval and refresh must be positive")
    run(args)
