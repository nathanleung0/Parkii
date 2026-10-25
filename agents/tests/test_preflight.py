"""Regression checks for safe, offline agent readiness reporting."""
import io
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from agents import preflight
from agents.preflight import check_settings, cloud_site_configured


class ReadinessTest(unittest.TestCase):
    def test_cloud_origin_only(self):
        for value in ("https://demo-123.convex.site", "https://demo-123.convex.site/"):
            with self.subTest(value=value):
                self.assertTrue(cloud_site_configured(value))
        for value in (
            "", "http://127.0.0.1:3210", "https://demo.convex.cloud",
            "https://demo.convex.site.evil.example", "https://demo.convex.site/path",
            "https://user:password@demo.convex.site", "https://demo.convex.site:443",
            "https://demo.convex.site?token=secret", "https://demo.convex.site#secret",
            "https://demo.convex.site\n", "https://demo.convex.site:",
            "https://.convex.site", "https://-demo.convex.site", "https://nested.demo.convex.site",
        ):
            with self.subTest(value=value):
                self.assertFalse(cloud_site_configured(value))

    def test_checks_do_not_echo_secrets_or_urls(self):
        secret, seed = "private-secret-value", "private-seed-value"
        env = {"CONVEX_SITE_URL": "https://private-demo.convex.site",
               "AGENT_SECRET": secret, "AGENT_SEED": seed}
        report = repr(check_settings(env))
        for value in env.values():
            self.assertNotIn(value, report)
        self.assertFalse(any(c.status == "FAIL" for c in check_settings(env)))
        self.assertTrue(any(c.status == "WARN" for c in check_settings(env)))

    def test_missing_settings_fail_without_network(self):
        checks = check_settings({})
        self.assertEqual(sum(c.status == "FAIL" for c in checks), 3)

    def test_frontend_url_alias_and_remote_rules(self):
        checks = check_settings({"VITE_CONVEX_SITE_URL": "https://demo.convex.site",
                                 "AGENT_SECRET": "secret", "AGENT_SEED": "seed",
                                 "RULES_AGENT_ADDRESS": "agent-address"})
        self.assertTrue(all(c.status == "PASS" for c in checks))


    def test_nearest_mode_accepts_cloud_origin_without_assistant_secret(self):
        env = {"PARKII_PARKING_MODE":"nearest","CONVEX_URL":"https://demo.convex.cloud","AGENT_SEED":"private-seed"}
        checks = check_settings(env)
        self.assertFalse(any(c.status == "FAIL" for c in checks))
        self.assertNotIn("private-seed", repr(checks))
        self.assertFalse(any(c.name == "AGENT_SECRET" for c in checks))

    def test_invalid_nearest_origin_and_unknown_mode_fail(self):
        for env in ({"PARKII_PARKING_MODE":"nearest","CONVEX_URL":"https://evil.example","AGENT_SEED":"s"},
                    {"PARKII_PARKING_MODE":"typo","AGENT_SEED":"s"}):
            self.assertTrue(any(c.status == "FAIL" for c in check_settings(env)))

    def test_cli_stays_offline_and_hides_configured_values(self):
        env = {"CONVEX_SITE_URL": "https://demo.convex.site",
               "AGENT_SECRET": "secret-do-not-print", "AGENT_SEED": "seed-do-not-print"}
        output = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch.object(preflight, "load_env"), \
                patch.object(preflight, "version", return_value="0.26.1"), \
                patch("socket.create_connection", side_effect=AssertionError("unexpected network request")), \
                redirect_stdout(output):
            self.assertEqual(preflight.main(), 0)
        for value in env.values():
            self.assertNotIn(value, output.getvalue())
        self.assertIn("does not verify", output.getvalue())

if __name__ == "__main__":
    unittest.main()
