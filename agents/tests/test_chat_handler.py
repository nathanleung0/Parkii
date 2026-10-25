"""Offline ACP handler tests: no real agent registration, backend requests, or holds."""
import importlib
import os
import sys
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from uagents_core.contrib.protocols.chat import ChatAcknowledgement, ChatMessage, EndSessionContent, TextContent


class ChatHandlerTest(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with patch.dict(os.environ, {"AGENT_SEED": "offline-test-seed"}), \
                patch("agents.config.load_env"), patch("uagents.Agent"):
            cls.module = importlib.import_module("agents.parkii_agent")
            cls.module.agent.address = "agent1offline-test"

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop("agents.parkii_agent", None)

    def setUp(self):
        self.mode = patch.dict(os.environ, {"PARKII_CHAT_ONLY": "0"})
        self.mode.start()
        self.addCleanup(self.mode.stop)

    def context(self):
        return SimpleNamespace(send=AsyncMock(), logger=MagicMock())

    def message(self, text):
        return ChatMessage(timestamp=datetime.now(timezone.utc), msg_id=uuid4(),
                           content=[TextContent(type="text", text=text)])

    async def test_help_and_greetings_acknowledge_without_any_tools(self):
        for text in ("help", "HELP!", "hello", "hi", "hey", "what can you do?", "test connection", "Tell me what you were created to do", "@agent1offline-test help"):
            with self.subTest(text=text):
                ctx, msg = self.context(), self.message(text)
                with patch.object(self.module.geocode, "resolve", side_effect=AssertionError("unexpected geocoding")), \
                        patch.object(self.module.convex_client, "find_spot", side_effect=AssertionError("unexpected parking request")), \
                        patch.object(self.module, "rules_for", side_effect=AssertionError("unexpected rules request")):
                    await self.module.on_chat(ctx, "test-sender", msg)
                calls = ctx.send.await_args_list
                self.assertEqual(len(calls), 2)
                ack, reply = calls[0].args[1], calls[1].args[1]
                self.assertIsInstance(ack, ChatAcknowledgement)
                self.assertEqual(ack.acknowledged_msg_id, msg.msg_id)
                self.assertTrue(any(isinstance(c, EndSessionContent) for c in reply.content))
                self.assertIn("does not search for parking", reply.content[0].text)

    async def test_parking_request_with_help_prefix_still_calls_backend_once(self):
        ctx = self.context()
        text = "help me find parking near the Castro Theatre"
        place = SimpleNamespace(lat=37.762, lng=-122.4348, label="Castro Theatre", assumed=False, resolved=True)
        with patch.object(self.module.geocode, "resolve", return_value=place), \
                patch.object(self.module.convex_client, "find_spot", return_value={"spot": None, "reply": "No open spots (test fixture)."}) as find:
            await self.module.on_chat(ctx, "test-sender", self.message(text))
        find.assert_called_once_with(text, place.lat, place.lng, "test-sender")
        self.assertIn("test fixture", ctx.send.await_args_list[1].args[1].content[0].text)

    async def test_unresolved_location_never_calls_the_parking_backend(self):
        ctx = self.context()
        place = SimpleNamespace(resolved=False, label="an unknown destination")
        with patch.object(self.module.geocode, "resolve", return_value=place), \
                patch.object(self.module.convex_client, "find_spot", side_effect=AssertionError("unexpected parking")):
            await self.module.on_chat(ctx, "test-sender", self.message("parking near unknown destination"))
        self.assertIn("couldn't locate", ctx.send.await_args_list[1].args[1].content[0].text)

    async def test_backend_exception_details_do_not_reach_logs_or_reply(self):
        ctx = self.context()
        place = SimpleNamespace(lat=37.762, lng=-122.4348, resolved=True)
        with patch.object(self.module.geocode, "resolve", return_value=place), \
                patch.object(self.module.convex_client, "find_spot", side_effect=RuntimeError("private-error-marker")):
            await self.module.on_chat(ctx, "test-sender", self.message("find parking near Castro Theatre"))
        self.assertNotIn("private-error-marker", str(ctx.logger.error.call_args))
        self.assertNotIn("private-error-marker", ctx.send.await_args_list[1].args[1].content[0].text)
        self.assertIn("RuntimeError", ctx.logger.error.call_args.args[0])

    async def test_chat_only_mode_blocks_all_parking_tools(self):
        ctx = self.context()
        with patch.dict(os.environ, {"PARKII_CHAT_ONLY": "1"}), \
                patch.object(self.module.geocode, "resolve", side_effect=AssertionError("unexpected geocoding")), \
                patch.object(self.module.convex_client, "find_spot", side_effect=AssertionError("unexpected parking request")), \
                patch.object(self.module, "rules_for", side_effect=AssertionError("unexpected rules request")):
            await self.module.on_chat(ctx, "test-sender", self.message("find parking near Castro Theatre"))
        self.assertEqual(ctx.send.await_count, 2)
        self.assertIn("No spot has been requested or held", ctx.send.await_args_list[1].args[1].content[0].text)

    async def test_oversized_message_stays_offline(self):
        ctx = self.context()
        with patch.object(self.module.geocode, "resolve", side_effect=AssertionError("unexpected geocoding")), \
                patch.object(self.module.convex_client, "find_spot", side_effect=AssertionError("unexpected parking request")):
            await self.module.on_chat(ctx, "test-sender", self.message("x" * 2001))
        self.assertEqual(ctx.send.await_count, 2)


if __name__ == "__main__":
    unittest.main()
