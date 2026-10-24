import json
import os
import unittest
from datetime import datetime

from agents import convex_client, format_reply, geocode, rules_service
from agents.providers.provider_common import ProviderError
from agents.street_rules import SF_TZ

SPOT = {"stallId": "s1", "label": "C1-2", "lat": 37.76134, "lng": -122.43509, "camera": "Castro St (Cam 1)",
        "distanceM": 57, "confidence": 1.0, "ageS": 4, "expiresAt": 1}


class GeocodeTest(unittest.TestCase):
    def no_net(self, _q):
        raise AssertionError("should not hit the network")

    def test_landmark_wins_and_longest_key(self):
        p = geocode.resolve("find me parking near the Castro Theatre", self.no_net)
        self.assertEqual((p.lat, p.lng, p.assumed), (37.76200, -122.43480, False))
        self.assertEqual(p.label, "Castro Theatre")

    def test_intersection_phrase(self):
        self.assertAlmostEqual(geocode.resolve("parking at 18th and Castro", self.no_net).lat, 37.76092)

    def test_unknown_place_uses_nominatim(self):
        p = geocode.resolve("parking near Dolores Park", lambda q: (37.7596, -122.4269))
        self.assertEqual((p.lat, p.assumed), (37.7596, False))
        self.assertEqual(p.label, "Dolores Park")

    def test_no_place_defaults_to_castro_and_says_so(self):
        p = geocode.resolve("find me a spot", self.no_net)
        self.assertTrue(p.assumed)
        self.assertEqual((p.lat, p.lng), geocode.CASTRO_CENTER)

    def test_nominatim_failure_falls_back(self):
        def boom(_q):
            raise OSError("offline")
        self.assertTrue(geocode.resolve("parking near Dolores Park", boom).assumed)

    def test_extract_place(self):
        self.assertEqual(geocode.extract_place("find parking close to the Mission Dolores."), "Mission Dolores")
        self.assertIsNone(geocode.extract_place("find me a spot"))


class FormatTest(unittest.TestCase):
    def test_full_reply(self):
        rules = {"streetCleaning": {"text": "Next street cleaning on Castro St (East side): Tuesday 6am-8am."},
                 "hits": [{"excerpt": "Most meters are enforced 9am-6pm.", "url": "https://www.sfmta.com/x"}]}
        text = format_reply.compose({"spot": SPOT, "reply": "Spot C1-2 is closest.", "frameUrl": "https://f/1"},
                                    "Castro Theatre", False, rules)
        for needle in ("Spot C1-2 is closest.", "held for you for 3 minutes", "57 m from Castro Theatre",
                       "Seen open 4s ago", "100% confidence", "Tuesday 6am-8am", "[source](https://www.sfmta.com/x)",
                       "[Latest camera frame](https://f/1)", "destination=37.76134,-122.43509"):
            self.assertIn(needle, text)

    def test_assumed_place_is_disclosed(self):
        text = format_reply.compose({"spot": SPOT, "reply": "ok"}, "the Castro", True, None)
        self.assertIn("you didn't name a place", text)
        self.assertNotIn("camera frame", text)

    def test_no_spot_returns_backend_reply(self):
        self.assertEqual(format_reply.compose({"spot": None, "reply": "None open."}, "x", False, None), "None open.")

    def test_no_raw_json(self):
        text = format_reply.compose({"spot": SPOT, "reply": "ok"}, "x", False, None)
        self.assertNotIn("stallId", text)


class ConvexClientTest(unittest.TestCase):
    def setUp(self):
        self.saved = {k: os.environ.get(k) for k in ("CONVEX_SITE_URL", "AGENT_SECRET", "VITE_CONVEX_SITE_URL")}
        os.environ["CONVEX_SITE_URL"], os.environ["AGENT_SECRET"] = "https://x.convex.site/", "s3cret"

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)

    def test_posts_secret_and_body(self):
        seen = {}

        def post(url, headers, body):
            seen.update(url=url, headers=headers, body=json.loads(body))
            return 200, json.dumps({"spot": SPOT, "reply": "hi"}).encode()

        out = convex_client.find_spot("near castro", 37.7, -122.4, "agent1q", post=post)
        self.assertEqual(seen["url"], "https://x.convex.site/agent/find")
        self.assertEqual(seen["headers"]["x-agent-secret"], "s3cret")
        self.assertEqual(seen["body"], {"text": "near castro", "lat": 37.7, "lng": -122.4, "sessionId": "agent1q"})
        self.assertEqual(out["spot"]["label"], "C1-2")

    def test_backend_error_is_safe(self):
        with self.assertRaises(convex_client.ParkSightError) as cm:
            convex_client.find_spot("x", 1, 2, "s", post=lambda *a: (500, b"stack trace with secrets"))
        self.assertNotIn("secrets", str(cm.exception))

    def test_not_configured(self):
        os.environ.pop("AGENT_SECRET")
        with self.assertRaises(convex_client.ParkSightError):
            convex_client.find_spot("x", 1, 2, "s")


class FakeRetrieval:
    def __init__(self, hits=None, error=None):
        self.hits, self.error, self.calls = hits or [], error, []

    def search_sources(self, query, scope, **_):
        self.calls.append((query, scope))
        if self.error:
            raise self.error

        class R:
            pass
        r = R()
        r.hits = self.hits
        return r


CLEAN = lambda lat, lng: {"warning": "later", "text": "Next street cleaning: Tuesday.", "next": None}  # noqa: E731


class RulesServiceTest(unittest.TestCase):
    def test_elastic_hits_are_scoped_and_labelled(self):
        fake = FakeRetrieval([{"title": "Meters", "url": "https://u", "excerpt": "4 hour limit", "score": 1.2}])
        out = rules_service.lookup_rules(37.7, -122.4, "near castro", retrieval=fake, cleaning=CLEAN)
        self.assertEqual(out["sources"], {"datasf": "ok", "elastic": "ok"})
        self.assertEqual(out["hits"][0]["excerpt"], "4 hour limit")
        scope = fake.calls[0][1]
        self.assertEqual((scope.user_id, scope.workspace_id), (rules_service.DEMO_USER, rules_service.WORKSPACE))

    def test_elastic_failure_is_reported_not_raised(self):
        out = rules_service.lookup_rules(1, 2, "", retrieval=FakeRetrieval(error=ProviderError("PROVIDER_TIMEOUT", "t")),
                                         cleaning=CLEAN)
        self.assertEqual(out["sources"]["elastic"], "error:PROVIDER_TIMEOUT")
        self.assertEqual(out["streetCleaning"]["text"], "Next street cleaning: Tuesday.")

    def test_unconfigured_elastic_is_not_claimed(self):
        saved = {k: os.environ.pop(k, None) for k in ("ELASTIC_KIBANA_URL", "ELASTIC_ES_URL", "ELASTIC_API_KEY")}
        try:
            out = rules_service.lookup_rules(1, 2, "", cleaning=CLEAN)
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v
        self.assertEqual(out["sources"]["elastic"], "not_configured")
        self.assertEqual(out["hits"], [])

    def test_datasf_error_is_reported(self):
        out = rules_service.lookup_rules(1, 2, "", retrieval=FakeRetrieval(),
                                         cleaning=lambda a, b: {"warning": None, "text": None, "next": None, "error": "OSError"})
        self.assertEqual(out["sources"]["datasf"], "error:OSError")


if __name__ == "__main__":
    unittest.main()
