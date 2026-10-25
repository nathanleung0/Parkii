"""Fast contract tests: no torch, network, GPU, or Convex required."""
import argparse
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import benchmark
from evaluation import occupancy, score_stalls, summarize
from vision import (VehicleDetector, VisionConfig, add_vision_args, config_from_args,
                    normalize_boxes, parking_crop, resolve_device)


class CoordinatesTest(unittest.TestCase):
    def test_roi_translation_preserves_full_frame_wire_coordinates(self):
        result = normalize_boxes([[10, 20, 110, 120]], [.873], (200, 300, 500, 600), (720, 1280, 3))
        self.assertEqual(result, [[.1641, .4444, .2422, .5833, .873]])

    def test_clamp_and_drop_invalid_or_degenerate(self):
        result = normalize_boxes([[-10, -20, 2000, 900], [2, 2, 1, 1], [float("nan"), 1, 3, 4]],
                                 [.9, .9, .9], (0, 0, 1280, 720), (720, 1280, 3))
        self.assertEqual(result, [[0, 0, 1, 1, .9]])

    def test_crop_includes_context_and_falls_back_without_valid_calibration(self):
        stalls = [{"polygon": [[.4, .5], [.6, .5], [.6, .7], [.4, .7]]}]
        self.assertEqual(parking_crop((100, 100), stalls, .1), (30, 40, 70, 80))
        for invalid in ([], [{"polygon": [[float("nan"), .5]]}], [{"polygon": [[2, 3]]}],
                        [{"polygon": [[.1, .1], [.2, .2], [.3, .3]]}]):
            self.assertEqual(parking_crop((720, 1280), invalid), (0, 0, 1280, 720))

    def test_detector_passes_vehicle_filter_and_maps_crop(self):
        detector = VehicleDetector.__new__(VehicleDetector)
        detector.config = VisionConfig(parking_roi=True, roi_margin=0)
        detector.device = "0"
        result = SimpleNamespace(boxes=SimpleNamespace(xyxy=Mock(), conf=Mock()))
        result.boxes.xyxy.tolist.return_value = [[0, 0, 20, 20]]
        result.boxes.conf.tolist.return_value = [.8]
        detector.model = Mock()
        detector.model.predict.return_value = [result]
        frame = Mock(shape=(100, 100, 3))
        frame.__getitem__ = Mock(return_value="cropped frame")
        boxes = detector.detect(frame, [{"polygon": [[.2, .3], [.4, .3], [.4, .5], [.2, .5]]}])
        self.assertEqual(boxes, [[.2, .3, .4, .5, .8]])
        self.assertEqual(detector.model.predict.call_args.kwargs["classes"], [2, 3, 5, 7])
        self.assertEqual(detector.model.predict.call_args.kwargs["device"], "0")


class ConfigTest(unittest.TestCase):
    def test_defaults_and_baseline_override(self):
        parser = argparse.ArgumentParser()
        add_vision_args(parser)
        self.assertEqual(config_from_args(parser.parse_args([])).model, "yolo11s.pt")
        self.assertEqual(config_from_args(parser.parse_args(["--model", "yolo11s.pt"])).model, "yolo11s.pt")

    def test_invalid_settings(self):
        for kwargs in ({"imgsz": 0}, {"imgsz": 123}, {"conf": float("nan")},
                       {"conf": 1}, {"roi_margin": -1}, {"device": "0,1"}):
            with self.assertRaises(ValueError):
                VisionConfig(**kwargs)

    def test_explicit_gpu_never_silently_falls_back_to_cpu(self):
        torch = Mock()
        torch.cuda.is_available.return_value = False
        self.assertEqual(resolve_device("auto", torch), "cpu")
        with self.assertRaises(RuntimeError):
            resolve_device("0", torch)
        torch.cuda.is_available.return_value = True
        torch.cuda.device_count.return_value = 1
        self.assertEqual(resolve_device("auto", torch), "0")
        with self.assertRaises(RuntimeError):
            resolve_device("1", torch)


class ParkingMetricsTest(unittest.TestCase):
    def test_uses_bottom_strip_and_not_whole_car_box(self):
        upper = [[0, 0], [1, 0], [1, .5], [0, .5]]
        lower = [[0, .65], [1, .65], [1, 1], [0, 1]]
        self.assertEqual(occupancy(upper, [[0, 0, 1, 1, .9]]), 0)
        self.assertAlmostEqual(occupancy(lower, [[0, 0, 1, 1, .9]]), 1)
        self.assertAlmostEqual(occupancy([[0, .65], [.5, .65], [.5, 1], [0, 1]], [[0, 0, 1, 1]]), .5)

    def test_false_open_denominator_and_unknown_labels(self):
        stalls = [{"label": k, "polygon": [[0, 0], [1, 0], [1, 1], [0, 1]]} for k in "abc"]
        rows = score_stalls(stalls, [], {"a": "taken", "b": "open", "c": "unknown"})
        metrics = summarize(rows)
        self.assertEqual(metrics["labeled_stall_frames"], 2)
        self.assertEqual(metrics["false_open_rate_among_predicted_open"], .5)
        self.assertIsNone(summarize([])["accuracy"])
        self.assertIsNone(summarize([{ "predicted": "taken", "expected": "taken"}])["false_open_rate_among_predicted_open"])


class BenchmarkTest(unittest.TestCase):
    def test_both_models_get_identical_frames_and_write_normalized_predictions(self):
        fake_cv = SimpleNamespace(imread=lambda _: "frame")
        instances = []

        class Detector:
            def __init__(self, config):
                self.config = config
                self.torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
                self.calls = []
                instances.append(self)

            def detect(self, frame, stalls):
                self.calls.append((frame, stalls))
                return [[.1, .2, .3, .4, .9]]

            def synchronize(self):
                pass

            def describe(self):
                return {"model": self.config.model, "device": "cpu"}

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            frames = root / "frames" / "cam1"
            frames.mkdir(parents=True)
            (frames / "b.jpg").touch()
            (frames / "a.png").touch()
            args = SimpleNamespace(frames=str(root / "frames"), output=str(root / "out"),
                                   models=["yolo11s.pt", "yolo26m.pt"], cameras=None, labels=None,
                                   imgsz=1280, conf=.25, device="cpu", half=False,
                                   parking_roi=False, roi_margin=.15, limit=None, warmup=1, annotate=False)
            with patch.dict("sys.modules", {"cv2": fake_cv}), patch.object(benchmark, "VehicleDetector", Detector), patch("builtins.print"):
                report = benchmark.run(args)
            self.assertEqual([p["frame"] for p in report["models"][0]["predictions"]], ["cam1/a.png", "cam1/b.jpg"])
            self.assertEqual([p["frame"] for p in report["models"][0]["predictions"]],
                             [p["frame"] for p in report["models"][1]["predictions"]])
            self.assertEqual(len(instances[0].calls), 3)  # warm-up excluded from report
            self.assertEqual(len(report["models"][0]["predictions"]), 2)
            self.assertIsNone(report["models"][0]["metrics"]["accuracy"])
            self.assertEqual(json.loads((root / "out/report.json").read_text()), report)

    def test_output_inside_input_is_rejected_before_reading_images(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict("sys.modules", {"cv2": Mock()}):
            args = SimpleNamespace(frames=folder, output=str(Path(folder) / "annotated"))
            with self.assertRaisesRegex(ValueError, "outside"):
                benchmark.run(args)


if __name__ == "__main__":
    unittest.main()
