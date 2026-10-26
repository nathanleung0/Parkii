"""NYC DOT policy for jpeg snapshot cameras with storeFrames == False.

No network: the grabber, the POST function and the YOLO model are all fakes.
"""
import argparse
import contextlib
import importlib
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import cv2
import numpy as np
import requests  # noqa: F401  imported before stubbing so sys.modules restore never drops it

WORKER = Path(__file__).resolve().parents[1]
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))


def load_poll():
    # poll.py imports torch and ultralytics at module level; stub them so no weights or GPU stack load.
    torch = types.ModuleType("torch")
    torch_utils = types.ModuleType("torch._utils")
    ultralytics = types.ModuleType("ultralytics")
    ultralytics.YOLO = object
    with patch.dict(sys.modules, {"torch": torch, "torch._utils": torch_utils, "ultralytics": ultralytics}):
        return importlib.import_module("poll")


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeResponse:
    def raise_for_status(self):
        pass

    def json(self):
        return {"ok": True}


class FakePost:
    def __init__(self):
        self.calls = []

    def __call__(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return FakeResponse()


class FakeGrab:
    def __init__(self):
        self.calls = []

    def __call__(self, cam):
        self.calls.append(cam["camId"])
        # A different value per call so the unchanged-frame check never hides a fetch.
        return np.full((240, 320, 3), len(self.calls) % 250 + 1, dtype=np.uint8), "snapshot"


class FakeModel:
    def predict(self, frame, **_kwargs):
        boxes = types.SimpleNamespace(
            xyxy=types.SimpleNamespace(tolist=lambda: [[10.0, 20.0, 110.0, 220.0]]),
            conf=types.SimpleNamespace(tolist=lambda: [0.9]),
            cls=types.SimpleNamespace(tolist=lambda: [2.0]),
        )
        return [types.SimpleNamespace(boxes=boxes)]


def make_args(**overrides):
    base = dict(
        model="unused.pt", conf=0.25, imgsz=1280, replay=None, record=None, debug=False,
        dry_run=False, preview_interval=60.0, once=True, interval=15.0, only=None,
        shard_count=1, shard_index=0,
    )
    base.update(overrides)
    return argparse.Namespace(**base)


def jpeg_cam(**extra):
    return {"camId": "nyc-1", "sourceType": "jpeg", "sourceUrl": "https://camera.example/frame.jpg", **extra}


class NycPolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.poll = load_poll()

    def setUp(self):
        env = patch.dict(os.environ, {"CONVEX_SITE_URL": "https://convex.test", "INGEST_SECRET": "test-secret"})
        env.start()
        self.addCleanup(env.stop)
        self.clock = FakeClock()
        self.post = FakePost()
        self.grab = FakeGrab()
        self.model = FakeModel()

    def make_worker(self, **args):
        return self.poll.Worker(make_args(**args), grab=self.grab, post=self.post, model=self.model, clock=self.clock)

    def test_frame_is_sent_only_when_storeFrames_is_not_false(self):
        cases = {
            "storeFrames false": ({"storeFrames": False}, False),
            "storeFrames true": ({"storeFrames": True}, True),
            "storeFrames absent": ({}, True),
        }
        for name, (extra, expect_frame) in cases.items():
            with self.subTest(name):
                self.post.calls.clear()
                self.make_worker().step(jpeg_cam(**extra))
                self.assertEqual(len(self.post.calls), 1)
                body = self.post.calls[0]["json"]
                self.assertEqual(body["camId"], "nyc-1")
                self.assertEqual(len(body["vehicles"]), 1)
                self.assertIn("ts", body)
                if expect_frame:
                    self.assertIn("frame", body)
                    self.assertIsInstance(body["frame"], str)
                    self.assertTrue(body["frame"])
                else:
                    self.assertNotIn("frame", body)
                    self.assertEqual(set(body), {"camId", "ts", "vehicles"})

    def test_storeFrames_false_camera_is_not_fetched_twice_within_5s(self):
        worker = self.make_worker()
        cam = jpeg_cam(storeFrames=False)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            worker.step(cam)
            self.clock.advance(4.5)
            worker.step(cam)
        self.assertEqual(self.grab.calls, ["nyc-1"])
        self.assertEqual(len(self.post.calls), 1)
        self.assertIn("skipped", out.getvalue())

        self.clock.advance(0.5)  # 5.0 s after the first fetch: allowed again
        worker.step(cam)
        self.assertEqual(self.grab.calls, ["nyc-1", "nyc-1"])
        self.assertEqual(len(self.post.calls), 2)

    def test_default_camera_is_not_throttled(self):
        worker = self.make_worker()
        worker.step(jpeg_cam())
        worker.step(jpeg_cam())
        self.assertEqual(self.grab.calls, ["nyc-1", "nyc-1"])
        self.assertEqual(len(self.post.calls), 2)

    def test_storeFrames_false_never_records_debugs_or_encodes_images(self):
        with tempfile.TemporaryDirectory() as record_dir, \
                patch.object(self.poll.Worker, "record") as record, \
                patch.object(self.poll.Worker, "debug_image") as debug_image, \
                patch.object(self.poll.cv2, "imwrite") as imwrite, \
                patch.object(self.poll.cv2, "imencode") as imencode:
            self.make_worker(record=record_dir, debug=True).step(jpeg_cam(storeFrames=False))
            record.assert_not_called()
            debug_image.assert_not_called()
            imwrite.assert_not_called()
            imencode.assert_not_called()
            self.assertEqual(os.listdir(record_dir), [])
            self.assertEqual(len(self.post.calls), 1)  # still detected and posted without a frame

    def test_storeFrames_true_still_records_and_debugs(self):
        with tempfile.TemporaryDirectory() as record_dir, \
                patch.object(self.poll.Worker, "record") as record, \
                patch.object(self.poll.Worker, "debug_image") as debug_image:
            self.make_worker(record=record_dir, debug=True).step(jpeg_cam(storeFrames=True))
            record.assert_called_once()
            debug_image.assert_called_once()


if __name__ == "__main__":
    unittest.main()
