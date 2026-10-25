"""ParkSight worker: grab camera frames, detect vehicles, push to Convex.

Occupancy itself is computed in Convex (convex/ingest.ts) from the vehicle
boxes, so stall edits in the Calibrate view apply without restarting this.

Usage:
  python poll.py                   # live loop
  python poll.py --once --debug    # one pass, write annotated frames to debug/
  python poll.py --record recordings
  python poll.py --replay recordings
"""
import argparse
import base64
import hashlib
import itertools
import os
import pathlib
import time

import cv2
import numpy as np
import requests
from sources import grab_frame
from sharding import belongs_to_shard
from vision import VehicleDetector, add_vision_args, config_from_args

ROOT = pathlib.Path(__file__).resolve().parent
UPLOAD_WIDTH = 960


def load_env() -> dict:
    env = {}
    for name in (ROOT.parent / ".env.local", ROOT / ".env"):
        if name.exists():
            for line in name.read_text().splitlines():
                line = line.split("#", 1)[0].strip()
                if "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip('"')
    env.update({k: v for k, v in os.environ.items() if k in ("CONVEX_SITE_URL", "INGEST_SECRET")})
    return env


class Worker:
    def __init__(self, args):
        env = load_env()
        self.site = env.get("CONVEX_SITE_URL") or env["VITE_CONVEX_SITE_URL"]
        self.secret = env.get("INGEST_SECRET", "")
        self.args = args
        self.detector = VehicleDetector(config_from_args(args))
        print(f"[vision] {self.detector.describe()}")
        self.last_hash: dict[str, int] = {}
        self.last_preview: dict[str, float] = {}
        self.camera_cache: tuple[float, list[dict]] = (0, [])
        self.replay_iters: dict[str, itertools.cycle] = {}

    def cameras(self) -> list[dict]:
        if time.time() - self.camera_cache[0] < 60:
            return self.camera_cache[1]
        r = requests.get(
            f"{self.site}/cameras", headers={"x-ingest-secret": self.secret}, timeout=10
        )
        r.raise_for_status()
        cameras = r.json()
        self.camera_cache = (time.time(), cameras)
        return cameras

    def next_frame(self, cam: dict) -> tuple[np.ndarray | None, str]:
        if self.args.replay:
            if cam["camId"] not in self.replay_iters:
                files = sorted((pathlib.Path(self.args.replay) / cam["camId"]).glob("*.jpg"))
                if not files:
                    return None, "replay"
                self.replay_iters[cam["camId"]] = itertools.cycle(files)
            return cv2.imread(str(next(self.replay_iters[cam["camId"]]))), "replay"
        return grab_frame(cam)

    def detect(self, frame: np.ndarray, stalls=()) -> list[list[float]]:
        return self.detector.detect(frame, stalls)

    def push(self, cam: dict, frame: np.ndarray, vehicles: list, include_preview: bool) -> dict:
        body = {
            "camId": cam["camId"],
            "ts": int(time.time() * 1000),
            "vehicles": vehicles,
        }
        if include_preview:
            h, w = frame.shape[:2]
            small = cv2.resize(frame, (UPLOAD_WIDTH, round(h * UPLOAD_WIDTH / w)))
            ok, jpg = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if not ok:
                raise RuntimeError("could not encode camera preview")
            body["frame"] = base64.b64encode(jpg.tobytes()).decode()
        r = requests.post(
            f"{self.site}/ingest", json=body, headers={"x-ingest-secret": self.secret}, timeout=20
        )
        r.raise_for_status()
        return r.json()

    def debug_image(self, cam: dict, frame: np.ndarray, vehicles: list):
        h, w = frame.shape[:2]
        img = frame.copy()
        for x1, y1, x2, y2, c in vehicles:
            cv2.rectangle(img, (int(x1 * w), int(y1 * h)), (int(x2 * w), int(y2 * h)), (0, 200, 255), 2)
            cv2.putText(img, f"{c:.2f}", (int(x1 * w), int(y1 * h) - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
        for s in cam.get("stalls", []):
            pts = np.array([[int(x * w), int(y * h)] for x, y in s["polygon"]], np.int32)
            cv2.polylines(img, [pts], True, (80, 255, 80), 2)
            cv2.putText(img, s["label"], tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 255, 80), 1)
        out = ROOT / "debug"
        out.mkdir(exist_ok=True)
        cv2.imwrite(str(out / f"{cam['camId']}.jpg"), img)

    def record(self, cam: dict, frame: np.ndarray):
        d = pathlib.Path(self.args.record) / cam["camId"]
        d.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(d / f"{int(time.time())}.jpg"), frame)

    def step(self, cam: dict):
        t0 = time.time()
        frame, src = self.next_frame(cam)
        if frame is None:
            print(f"[{cam['camId']}] no frame ({src})")
            return
        digest = int.from_bytes(hashlib.blake2b(frame[::16, ::16].tobytes(), digest_size=8).digest(), "big")
        if self.last_hash.get(cam["camId"]) == digest and not self.args.replay:
            print(f"[{cam['camId']}] frame unchanged, skipping")
            return
        self.last_hash[cam["camId"]] = digest
        vehicles = self.detect(frame, cam.get("stalls", []))
        if self.args.record:
            self.record(cam, frame)
        if self.args.debug:
            self.debug_image(cam, frame, vehicles)
        preview = time.time() - self.last_preview.get(cam["camId"], 0) >= self.args.preview_interval
        result = {} if self.args.dry_run else self.push(cam, frame, vehicles, preview)
        if preview and not self.args.dry_run:
            self.last_preview[cam["camId"]] = time.time()
        print(f"[{cam['camId']}] {src} {len(vehicles)} vehicles, {result} in {time.time() - t0:.1f}s")

    def run(self):
        while True:
            try:
                cams = self.cameras()
            except requests.RequestException as e:  # backend restarting / offline: keep the worker alive
                print(f"[worker] can't reach Convex ({type(e).__name__}); retrying")
                if self.args.once:
                    raise
                time.sleep(5)
                continue
            if self.args.only:
                cams = [c for c in cams if c["camId"] in self.args.only]
            if self.args.shard_count > 1:
                cams = [c for c in cams if belongs_to_shard(c["camId"], self.args.shard_index, self.args.shard_count)]
            cycle_start = time.time()
            for cam in cams:
                try:
                    self.step(cam)
                except Exception as e:  # keep going if one camera fails
                    print(f"[{cam['camId']}] error: {e}")
            if self.args.once:
                return
            if time.time() - cycle_start > self.args.interval:
                print(f"[worker] cycle exceeded {self.args.interval}s; add worker shards or increase interval")
            time.sleep(max(0.0, self.args.interval - (time.time() - cycle_start)))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--once", action="store_true")
    p.add_argument("--debug", action="store_true", help="write annotated frames to worker/debug/")
    p.add_argument("--dry-run", action="store_true", help="don't push to Convex")
    p.add_argument("--record", metavar="DIR")
    p.add_argument("--replay", metavar="DIR")
    p.add_argument("--only", nargs="*", help="camIds to process")
    p.add_argument("--interval", type=float, default=15.0, help="seconds per full camera cycle")
    p.add_argument("--preview-interval", type=float, default=60.0, help="seconds between preview uploads per camera")
    p.add_argument("--shard-count", type=int, default=1, help="number of worker processes sharing cameras")
    p.add_argument("--shard-index", type=int, default=0, help="this worker's shard, starting at zero")
    add_vision_args(p)
    args = p.parse_args()
    if args.shard_count < 1 or not 0 <= args.shard_index < args.shard_count:
        p.error("shard-index must be between 0 and shard-count - 1")
    if args.interval <= 0 or args.preview_interval <= 0:
        p.error("intervals must be positive")
    Worker(args).run()
