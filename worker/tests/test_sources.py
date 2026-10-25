import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch


def load_sources():
    cv2 = ModuleType("cv2")
    cv2.IMREAD_COLOR = 1
    cv2.CAP_FFMPEG = 2
    cv2.imdecode = lambda payload, _mode: payload
    numpy = ModuleType("numpy")
    numpy.ndarray = object
    numpy.uint8 = object()
    numpy.frombuffer = lambda payload, _dtype: payload
    requests = ModuleType("requests")
    with patch.dict(sys.modules, {"cv2": cv2, "numpy": numpy, "requests": requests}):
        path = Path(__file__).resolve().parents[1] / "sources.py"
        spec = importlib.util.spec_from_file_location("parkii_sources_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, content_type="image/jpeg", chunks=(b"camera-frame",)):
        self.headers = {"Content-Type": content_type}
        self.chunks = chunks

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def raise_for_status(self):
        pass

    def iter_content(self, chunk_size):
        return iter(self.chunks)


class SourcesTest(unittest.TestCase):
    def setUp(self):
        self.sources = load_sources()

    def test_https_snapshot_is_decoded_and_dispatched(self):
        self.sources.requests.get = lambda *_args, **_kwargs: FakeResponse()
        frame, source = self.sources.grab_frame({"camId": "test", "sourceType": "jpeg", "sourceUrl": "https://camera.example/frame.jpg"})
        self.assertEqual((frame, source), (b"camera-frame", "snapshot"))

    def test_snapshot_rejects_non_images_and_oversized_responses(self):
        self.sources.requests.get = lambda *_args, **_kwargs: FakeResponse("text/html")
        with self.assertRaises(ValueError):
            self.sources.grab_snapshot("https://camera.example/frame.jpg")
        self.sources.requests.get = lambda *_args, **_kwargs: FakeResponse(chunks=(b"x" * (self.sources.MAX_SNAPSHOT_BYTES + 1),))
        with self.assertRaises(ValueError):
            self.sources.grab_snapshot("https://camera.example/frame.jpg")
        with self.assertRaises(ValueError):
            self.sources.grab_snapshot("http://camera.example/frame.jpg")


if __name__ == "__main__":
    unittest.main()
