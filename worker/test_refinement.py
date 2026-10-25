"""Contract and metric regression tests; no real model, GPU, cloud writes or paid services."""
import argparse
import importlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from compare_detectors import select_winner
from detection_metrics import aggregate, image_counts, paired_f1_interval
from refinement import complete_tile_boxes, fuse_vehicle_boxes, tile_windows
from vision import VisionConfig


class RefinementTest(unittest.TestCase):
    def test_bounded_tiles_cover_far_edge_and_do_not_duplicate_full_frame(self):
        windows=tile_windows((540,960),(0,0,960,540),320,.25,16)
        self.assertEqual(len(windows),8)
        self.assertTrue(any(w[2]==960 and w[3]==540 for w in windows))
        self.assertEqual(tile_windows((200,300),(0,0,300,200),320),[])
        with self.assertRaises(ValueError):
            tile_windows((1080,1920),(0,0,1920,1080),64,.25,4)

    def test_artificial_crop_edges_reject_truncated_vehicles(self):
        boxes,scores=complete_tile_boxes([[0,10,30,40],[10,10,30,40]],[.9,.8],(100,100,164,164),(200,200))
        self.assertEqual(boxes,[[10,10,30,40]])
        self.assertEqual(scores,[.8])
        self.assertEqual(len(complete_tile_boxes([[0,10,30,40]],[.9],(0,0,64,64),(200,200))[0]),1)

    def test_refinement_keeps_primary_box_instead_of_replacing_its_geometry(self):
        primary=[.1,.1,.3,.3,.6]
        refined=[.1,.1,.31,.31,.99]
        other=[.6,.6,.8,.8,.8]
        self.assertEqual(fuse_vehicle_boxes([primary,refined,other],preserve_first=1),[primary,other])

    def test_invalid_or_conflicting_modes_fail(self):
        for kwargs in ({"tile_size":12},{"tile_size":320,"parking_roi":True},{"tile_overlap":1},{"tile_limit":0},{"merge_iou":0}):
            with self.assertRaises(ValueError):
                VisionConfig(**kwargs)


class DetectionMetricTest(unittest.TestCase):
    def test_duplicate_is_false_positive_and_crowd_is_ignored(self):
        result=image_counts([[0,0,.2,.2,.9],[0,0,.2,.2,.8],[.7,.7,.8,.8,.7]],[[0,0,.2,.2]],[[.6,.6,.9,.9]])
        self.assertEqual(result,{"tp":1,"fp":1,"fn":0,"ignored_crowd":1})

    def test_negative_images_are_not_falsely_perfect_recall(self):
        row=image_counts([[0,0,.2,.2,.9]],[])
        self.assertEqual(row["fp"],1)
        self.assertIsNone(aggregate([row])["recall"])
        self.assertIsNone(aggregate([])["f1"])

    def test_selection_uses_validation_f1_then_latency(self):
        rows=[{"profile":"baseline","metrics":{"f1":.7},"latency_ms":{"median":1}},
              {"profile":"slow","metrics":{"f1":.8},"latency_ms":{"median":20}},
              {"profile":"fast","metrics":{"f1":.8},"latency_ms":{"median":5}}]
        self.assertEqual(select_winner(rows),"fast")

    def test_paired_interval_is_exactly_zero_for_identical_results(self):
        rows=[{"frame":"a","tp":2,"fp":1,"fn":1,"ignored_crowd":0}]
        interval=paired_f1_interval(rows,rows,iterations=20)
        self.assertEqual((interval["low_pp"],interval["high_pp"]),(0,0))
        with self.assertRaises(ValueError):
            paired_f1_interval(rows,[{**rows[0],"frame":"other"}])


class RFAdapterTest(unittest.TestCase):
    def test_sparse_coco_ids_and_pixel_boxes_map_to_existing_wire(self):
        from rf_detector import RFDETRDetector
        class Rows:
            def __init__(self, values): self.values=values
            def __getitem__(self, indexes): return SimpleNamespace(tolist=lambda:[self.values[i] for i in indexes])
        detector=RFDETRDetector.__new__(RFDETRDetector)
        detector.config=VisionConfig(model="rfdetr-small",imgsz=512)
        detector.model=Mock()
        detector.model.predict.return_value=SimpleNamespace(class_id=[1,3,4,6,8],
            xyxy=Rows([[0,0,20,10]]*5),confidence=Rows([.9]*5))
        frame=Mock(shape=(100,200,3))
        frame.__getitem__=Mock(return_value="RGB image")
        with patch.dict(sys.modules,{"PIL":SimpleNamespace(Image=SimpleNamespace(fromarray=Mock()))}):
            result=detector.detect(frame)
        self.assertEqual(result,[[0,0,.1,.1,.9]]*4)
        self.assertFalse(detector.model.predict.call_args.kwargs["include_source_image"])

    def test_unsupported_rf_settings_fail_before_model_load(self):
        from rf_detector import RFDETRDetector
        with self.assertRaises(ValueError):
            RFDETRDetector(VisionConfig(model="rfdetr-small",imgsz=1280))


class CalibrationAuditTest(unittest.TestCase):
    def test_bad_and_edge_geometry_require_review_without_becoming_occupancy(self):
        from calibration_audit import audit
        report=audit([{"camId":"c","stalls":[
            {"label":"edge","polygon":[[0,.1],[.2,.1],[.2,.3]]},
            {"label":"bad","polygon":[[float("nan"),.1]]},
            {"label":"normal","polygon":[[.1,.1],[.2,.1],[.2,.3]]}]}])
        self.assertEqual(report["with_geometry_warnings"],2)
        self.assertTrue(all(row["visual_review_required"] for row in report["stalls"]))
        self.assertTrue(all("status" not in row for row in report["stalls"]))


class WorkerSafetyTest(unittest.TestCase):
    def worker_module(self):
        fake=SimpleNamespace(ndarray=object)
        with patch.dict(sys.modules,{"cv2":fake,"numpy":fake,"requests":fake,"sources":SimpleNamespace(grab_frame=Mock())}):
            module=importlib.import_module("poll")
        self.addCleanup(lambda:sys.modules.pop("poll",None))
        return module

    def test_failed_inference_does_not_cache_a_frame_as_successful(self):
        module=self.worker_module()
        worker=module.Worker.__new__(module.Worker)
        frame=Mock()
        frame.__getitem__=Mock(return_value=SimpleNamespace(tobytes=lambda:b"same-frame"))
        worker.next_frame=lambda cam:(frame,"test-fixture")
        worker.args=SimpleNamespace(replay=None,record=None,debug=False,dry_run=False,preview_interval=60)
        worker.last_hash,worker.last_preview={},{}
        worker.detect=Mock(side_effect=[RuntimeError("failed"),[]])
        worker.push=Mock(return_value={})
        with patch("builtins.print"):
            with self.assertRaises(RuntimeError):
                worker.step({"camId":"c"})
            self.assertEqual(worker.last_hash,{})
            worker.step({"camId":"c"})
        self.assertEqual(worker.detect.call_count,2)
        self.assertIn("c",worker.last_hash)

    def test_failed_upload_preserves_retry_and_preview_state(self):
        module=self.worker_module()
        worker=module.Worker.__new__(module.Worker)
        frame=Mock()
        frame.__getitem__=Mock(return_value=SimpleNamespace(tobytes=lambda:b"same-frame"))
        worker.next_frame=lambda cam:(frame,"test-fixture")
        worker.args=SimpleNamespace(replay=None,record=None,debug=False,dry_run=False,preview_interval=60)
        worker.last_hash,worker.last_preview={},{}
        worker.detect=Mock(return_value=[])
        worker.push=Mock(side_effect=[RuntimeError("failed upload"),{}])
        with patch("builtins.print"):
            with self.assertRaises(RuntimeError): worker.step({"camId":"c"})
            self.assertEqual(worker.last_hash,{})
            self.assertEqual(worker.last_preview,{})
            worker.step({"camId":"c"})
        self.assertEqual(worker.push.call_count,2)
        self.assertIn("c",worker.last_hash)

    def test_offline_calibration_never_requests_backend_and_cannot_be_published(self):
        module=self.worker_module()
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"cameras.json"
            path.write_text(json.dumps([{"camId":"c","stalls":[]}]))
            args=SimpleNamespace(cameras_file=str(path),dry_run=True,model="yolo11s.pt",imgsz=1280,conf=.25,
                                 device="cpu",half=False,parking_roi=False,roi_margin=.15)
            with patch.object(module,"load_env",return_value={}),patch.object(module,"create_detector"):
                with patch("builtins.print"):
                    worker=module.Worker(args)
                self.assertEqual(worker.cameras()[0]["camId"],"c")
                args.dry_run=False
                with self.assertRaises(ValueError):
                    module.Worker(args)


if __name__=="__main__":
    unittest.main()
