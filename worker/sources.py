"""Frames from operator-configured YouTube, direct HLS, or JPEG/PNG feeds."""
import os
import hashlib
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from urllib.parse import urlparse

import cv2
import numpy as np
import requests

HLS_TTL_S = 60 * 60  # googlevideo URLs last ~6h; refresh hourly to be safe
MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
_hls_cache: dict[str, tuple[str, float]] = {}


def _env_with_node() -> dict:
    env = os.environ.copy()
    if not shutil.which("node"):
        env["PATH"] = r"C:\Program Files\nodejs" + os.pathsep + env.get("PATH", "")
    return env


def resolve_hls(youtube_id: str) -> str | None:
    cached = _hls_cache.get(youtube_id)
    if cached and time.time() - cached[1] < HLS_TTL_S:
        return cached[0]
    cmd = [
        sys.executable, "-m", "yt_dlp", "--js-runtimes", "node", "-g",
        "-f", "232/best[height<=720]/best",
        f"https://www.youtube.com/watch?v={youtube_id}",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=_env_with_node())
    except subprocess.TimeoutExpired:
        return None
    url = out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
    if url:
        _hls_cache[youtube_id] = (url, time.time())
    else:
        print(f"[sources] yt-dlp failed for {youtube_id}: {out.stderr.strip()[-200:]}")
    return url


class LiveReader(threading.Thread):
    """Keeps an HLS stream open and always holds the newest decoded frame."""

    def __init__(self, key: str, resolve: Callable[[], str | None]):
        super().__init__(daemon=True)
        self.key = key
        self.resolve = resolve
        self.frame: np.ndarray | None = None
        self.frame_ts = 0.0
        self.lock = threading.Lock()

    def latest(self, max_age_s: float = 20.0) -> np.ndarray | None:
        with self.lock:
            if self.frame is not None and time.time() - self.frame_ts < max_age_s:
                return self.frame.copy()
        return None

    def run(self):
        while True:
            url = self.resolve()
            if not url:
                time.sleep(30)
                continue
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            fails = 0
            while fails < 50:
                ok, frame = cap.read()
                if not ok:
                    fails += 1
                    time.sleep(0.2)
                    continue
                fails = 0
                with self.lock:
                    self.frame, self.frame_ts = frame, time.time()
            cap.release()
            if self.key.startswith("youtube:"):
                _hls_cache.pop(self.key.removeprefix("youtube:"), None)
            print(f"[sources] reconnecting {self.key}")


_readers: dict[str, LiveReader] = {}


def grab_hls(key: str, resolve: Callable[[], str | None], wait_s: float = 30.0) -> np.ndarray | None:
    reader = _readers.get(key)
    if reader is None:
        reader = _readers[key] = LiveReader(key, resolve)
        reader.start()
    deadline = time.time() + wait_s
    while True:
        frame = reader.latest()
        if frame is not None or time.time() > deadline:
            return frame
        time.sleep(0.25)


def grab_thumbnail(youtube_id: str) -> np.ndarray | None:
    url = f"https://i.ytimg.com/vi/{youtube_id}/maxresdefault_live.jpg?t={int(time.time())}"
    r = requests.get(url, timeout=15)
    if r.status_code != 200:
        return None
    return cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)


def grab_snapshot(url: str) -> np.ndarray | None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("camera snapshot URL must be HTTPS without embedded credentials")
    with requests.get(url, headers={"Cache-Control": "no-cache"}, timeout=15, stream=True) as response:
        response.raise_for_status()
        content_type = response.headers.get("Content-Type", "").split(";")[0].lower()
        if content_type not in ("image/jpeg", "image/png", "image/webp"):
            raise ValueError(f"camera returned unexpected content type: {content_type}")
        chunks = []
        size = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            size += len(chunk)
            if size > MAX_SNAPSHOT_BYTES:
                raise ValueError("camera snapshot is too large")
            chunks.append(chunk)
    return cv2.imdecode(np.frombuffer(b"".join(chunks), np.uint8), cv2.IMREAD_COLOR)


def grab_frame(camera: dict) -> tuple[np.ndarray | None, str]:
    kind = camera.get("sourceType") or "youtube"
    if kind == "jpeg":
        return grab_snapshot(camera["sourceUrl"]), "snapshot"
    if kind == "hls":
        url = camera["sourceUrl"]
        if urlparse(url).scheme != "https":
            raise ValueError("camera HLS URL must be HTTPS")
        key = hashlib.sha256(url.encode()).hexdigest()[:16]
        return grab_hls(f"hls:{camera['camId']}:{key}", lambda: url), "hls"
    if kind == "youtube":
        youtube_id = camera["youtubeId"]
        frame = grab_hls(f"youtube:{youtube_id}", lambda: resolve_hls(youtube_id))
        if frame is not None:
            return frame, "youtube hls"
        return grab_thumbnail(youtube_id), "youtube thumbnail"
    raise ValueError(f"unsupported camera source: {kind}")
