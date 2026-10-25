"""Frame sources: YouTube Live (HLS via yt-dlp) with a thumbnail fallback."""
import os
import shutil
import subprocess
import sys
import threading
import time

import cv2
import numpy as np
import requests

HLS_TTL_S = 60 * 60  # googlevideo URLs last ~6h; refresh hourly to be safe
_hls_cache: dict[str, tuple[str, float]] = {}
_live_ids: dict[str, str] = {}  # source -> video ID it last resolved to

# A source is either a video ID or a channel ID (UC...). Channels resolve to
# whatever they are broadcasting now, so restarted streams are picked up.


def _watch_url(source: str) -> str:
    if source.startswith("UC") and len(source) == 24:
        return f"https://www.youtube.com/channel/{source}/live"
    return f"https://www.youtube.com/watch?v={source}"


def _env_with_node() -> dict:
    env = os.environ.copy()
    if not shutil.which("node"):
        env["PATH"] = r"C:\Program Files\nodejs" + os.pathsep + env.get("PATH", "")
    return env


def resolve_hls(source: str) -> str | None:
    cached = _hls_cache.get(source)
    if cached and time.time() - cached[1] < HLS_TTL_S:
        return cached[0]
    cmd = [
        sys.executable, "-m", "yt_dlp", "--js-runtimes", "node",
        "--print", "id", "--print", "urls",
        "-f", "232/best[height<=720]/best",
        _watch_url(source),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=_env_with_node())
    except subprocess.TimeoutExpired:
        return None
    lines = out.stdout.strip().splitlines() if out.returncode == 0 else []
    if len(lines) < 2:
        print(f"[sources] yt-dlp failed for {source}: {out.stderr.strip()[-200:]}")
        return None
    video_id, url = lines[0], lines[1]
    if _live_ids.get(source) != video_id:
        if source != video_id:
            print(f"[sources] {source} is live as {video_id}")
        _live_ids[source] = video_id
    _hls_cache[source] = (url, time.time())
    return url


class LiveReader(threading.Thread):
    """Keeps an HLS stream open and always holds the newest decoded frame."""

    def __init__(self, source: str):
        super().__init__(daemon=True)
        self.source = source
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
            url = resolve_hls(self.source)
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
            _hls_cache.pop(self.source, None)  # stream ended or URL expired: re-resolve
            print(f"[sources] reconnecting {self.source}")


_readers: dict[str, LiveReader] = {}


def grab_hls(source: str, wait_s: float = 30.0) -> np.ndarray | None:
    reader = _readers.get(source)
    if reader is None:
        reader = _readers[source] = LiveReader(source)
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


def grab_frame(youtube_id: str, channel_id: str | None = None) -> tuple[np.ndarray | None, str]:
    source = channel_id or youtube_id
    frame = grab_hls(source)
    if frame is not None:
        return frame, "hls"
    return grab_thumbnail(_live_ids.get(source, youtube_id)), "thumbnail"
