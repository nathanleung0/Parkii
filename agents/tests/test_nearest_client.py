"""No-model selection tests with a FAKE transport; live verification is documented separately."""
import json
import os
import time
import unittest
from unittest.mock import patch

from agents import convex_client, nearest_client, format_reply

ORIGIN = "https://demo-123.convex.cloud"


def spot():
    return {"stallId": "s1", "label": "C1-2", "lat": 37.76134, "lng": -122.43509,
            "camera": "Castro St (Cam 1)", "distanceM": 57, "confidence": 1.0, "ageS": 4,
            "expiresAt": int(time.time() * 1000) + 180_000}


def success(value):
    return 200, json.dumps({"status": "success", "value": value}).encode()


class NearestModeTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"PARKSIGHT_PARKING_MODE": "nearest",
            "CONVEX_URL": "", "VITE_CONVEX_URL": "", "CONVEX_SITE_URL": "https://demo-123.convex.site",
            "AGENT_SECRET": "private-value-never-forward"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []

    def transport(self, url, headers, raw):
        body = json.loads(raw)
        self.calls.append((url, headers, body))
        if body["path"] == "parking:findSpot":
            return success(spot())
        if body["path"] == "parking:listCameras":
            return success([{"name": "Castro St (Cam 1)", "youtubeId": "tSZaTvW7LDA", "frameUrl": ORIGIN + "/api/storage/deleted-frame"}])
        raise AssertionError("Unexpected backend function")

    def test_uses_existing_mutation_and_does_not_forward_credentials_or_text(self):
        result = convex_client.find_spot("private message", 37.762, -122.4348, "test-sender", post=self.transport)
        self.assertEqual([c[0] for c in self.calls], [ORIGIN + "/api/mutation", ORIGIN + "/api/query"])
        self.assertEqual(self.calls[0][2], {"path": "parking:findSpot", "format": "json",
            "args": {"lat": 37.762, "lng": -122.4348, "sessionId": "agent:test-sender"}})
        self.assertNotIn("private-value-never-forward", str(self.calls))
        self.assertNotIn("private message", str(self.calls))
        self.assertNotIn("x-agent-secret", self.calls[0][1])
        self.assertEqual(result["selectionMode"], "nearest")
        self.assertIn("no language model", result["reply"])
        self.assertEqual(result["frameUrl"], "https://i.ytimg.com/vi/tSZaTvW7LDA/maxresdefault_live.jpg")
        self.assertEqual(result["cameraUrl"], "https://www.youtube.com/watch?v=tSZaTvW7LDA")

    def test_current_public_camera_contract_uses_safe_directory_link(self):
        def post(url, headers, raw):
            body = json.loads(raw)
            self.calls.append(body["path"])
            return success(spot()) if body["path"] == "parking:findSpot" else success([
                {"name":"Castro St (Cam 1)","camId":"castro-cam1","frameUrl":ORIGIN+"/api/storage/temporary"}])
        result = nearest_client.find_nearest(37.762,-122.4348,"s",post=post)
        self.assertEqual(result["cameraUrl"],"https://sfbaytimes.com/castro-street-cam/")
        self.assertIsNone(result["frameUrl"])
        reply = format_reply.compose(result,"Castro Theatre",False,None)
        self.assertIn("[Camera feeds]",reply)
        self.assertNotIn("temporary",reply)
        self.assertEqual(self.calls,["parking:findSpot","parking:listCameras"])

    def test_malformed_optional_camera_id_never_discards_the_hold(self):
        for cam_id in ([], {}, None, "unknown-camera"):
            def post(url, headers, raw):
                return success(spot()) if json.loads(raw)["path"] == "parking:findSpot" else success([
                    {"name":"Castro St (Cam 1)","camId":cam_id}])
            with self.subTest(cam_id=cam_id):
                result = nearest_client.find_nearest(37.762,-122.4348,"s",post=post)
                self.assertIsNotNone(result["spot"])
                self.assertIsNone(result["cameraUrl"])
                self.assertIsNone(result["frameUrl"])

    def test_no_available_spot_does_not_make_a_frame_query(self):
        def post(url, headers, body):
            self.calls.append(json.loads(body)["path"])
            return success(None)
        result = nearest_client.find_nearest(37.762, -122.4348, "s", post=post)
        self.assertIsNone(result["spot"])
        self.assertEqual(self.calls, ["parking:findSpot"])
        self.assertIn("no fresh, open spots", result["reply"])

    def test_backend_error_is_sanitized_and_not_retried(self):
        def post(*args):
            self.calls.append(args)
            return 500, b'{"errorMessage":"private-backend-error"}'
        with self.assertRaises(convex_client.ParkSightError) as error:
            nearest_client.find_nearest(37.762, -122.4348, "s", post=post)
        self.assertNotIn("private-backend-error", str(error.exception))
        self.assertEqual(len(self.calls), 1)

    def test_frame_lookup_failure_does_not_repeat_or_replace_the_hold(self):
        def post(url, headers, raw):
            body = json.loads(raw)
            self.calls.append(body["path"])
            return success(spot()) if body["path"] == "parking:findSpot" else (500, b"private")
        result = nearest_client.find_nearest(37.762, -122.4348, "s", post=post)
        self.assertIsNotNone(result["spot"])
        self.assertIsNone(result["frameUrl"])
        self.assertEqual(self.calls, ["parking:findSpot", "parking:listCameras"])

    def test_invalid_or_expired_spot_is_not_presented_as_a_hold(self):
        for key, value in (("lat", True), ("lng", float("nan")), ("confidence", 2), ("expiresAt", 1), ("ageS", 500)):
            with self.subTest(key=key):
                bad = spot()
                bad[key] = value
                with self.assertRaises(convex_client.ParkSightError):
                    nearest_client.find_nearest(37.762, -122.4348, "s", post=lambda *args: success(bad))

    def test_invalid_deployment_never_reaches_the_transport(self):
        for value in ("http://127.0.0.1:3210", "https://demo.convex.site.evil.example", "https://a:b@demo.convex.site",
                      "https://demo.convex.site/path", "https://demo.convex.site:", "https://demo.convex.site\n"):
            with self.subTest(value=value), patch.dict(os.environ, {"CONVEX_SITE_URL": value}):
                with self.assertRaises(convex_client.ParkSightError):
                    nearest_client.find_nearest(37.762, -122.4348, "s", post=lambda *args: self.fail("unexpected request"))

    def test_invalid_location_or_session_never_makes_a_mutation(self):
        for lat, lng, session in ((True, 1, "s"), (91, 1, "s"), (1, float("nan"), "s"), (1, 1, ""), (1, 1, "x"*251)):
            with self.assertRaises(convex_client.ParkSightError):
                nearest_client.find_nearest(lat, lng, session, post=lambda *args: self.fail("unexpected request"))

    def test_ambiguous_camera_names_or_untrusted_video_ids_are_omitted(self):
        for cameras in ([{"name": "Castro St (Cam 1)", "youtubeId": "javascript:alert(1)"}],
                        [{"name": "Castro St (Cam 1)", "youtubeId": "https://other.example/frame"}],
                        [{"name": "Castro St (Cam 1)", "youtubeId": "tSZaTvW7LDA"}]*2):
            def post(url, headers, raw):
                return success(spot()) if json.loads(raw)["path"] == "parking:findSpot" else success(cameras)
            with self.subTest(cameras=cameras):
                self.assertIsNone(nearest_client.find_nearest(37.762, -122.4348, "s", post=post)["frameUrl"])

    def test_thumbnail_is_not_presented_as_the_detection_snapshot(self):
        result = nearest_client.find_nearest(37.762, -122.4348, "s", post=self.transport)
        reply = format_reply.compose(result, "Castro Theatre", False, None)
        self.assertIn("[Camera thumbnail (may lag)]", reply)
        self.assertIn("[Live camera]", reply)
        self.assertNotIn("Latest camera frame", reply)
        self.assertNotIn("deleted-frame", reply)

    def test_unknown_selection_mode_fails_without_calling_the_paid_backend(self):
        with patch.dict(os.environ, {"PARKSIGHT_PARKING_MODE": "typo"}):
            with self.assertRaises(convex_client.ParkSightError):
                convex_client.find_spot("parking", 1, 2, "s", post=lambda *args: self.fail("unexpected request"))

    def test_malformed_success_envelope_is_sanitized(self):
        for raw in (b'not-json', b'[]', b'{"status":"error","errorMessage":"private"}', b'{"status":"success"}'):
            with self.assertRaises(convex_client.ParkSightError) as error:
                nearest_client.find_nearest(37.762, -122.4348, "s", post=lambda *args: (200, raw))
            self.assertNotIn("private", str(error.exception))


if __name__ == "__main__":
    unittest.main()
