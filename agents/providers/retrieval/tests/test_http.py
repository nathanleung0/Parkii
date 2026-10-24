"""Offline transport bounds; never contact a provider or read credentials."""
import io
import unittest
from unittest.mock import patch

from agents.providers.provider_common import ProviderError
from agents.providers.provider_common.http import MAX_RESPONSE_BYTES, urllib_transport


class Response(io.BytesIO):
    status = 200


class HttpBoundsTests(unittest.TestCase):
    def test_oversized_body_is_bounded_and_rejected(self):
        body = Response(b"x" * (MAX_RESPONSE_BYTES + 100))
        with patch("agents.providers.provider_common.http._opener.open", return_value=body):
            with self.assertRaises(ProviderError) as cm:
                urllib_transport("GET", "https://provider.example", {}, None, 20)
        self.assertEqual(cm.exception.code, "CONTENT_UNAVAILABLE")
        self.assertTrue(body.closed)

    def test_small_json_response_is_returned(self):
        with patch("agents.providers.provider_common.http._opener.open", return_value=Response(b'{"ok":true}')):
            self.assertEqual(urllib_transport("GET", "https://provider.example", {}, None, 20), (200, {"ok": True}))
