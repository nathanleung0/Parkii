"""ParkSight Agent: ASI:One chat agent that finds and holds an open street-parking spot in the Castro.

Flow per message: geocode the place -> Convex /agent/find (Claude picks and holds a spot from live camera
data) -> ask the Rules Agent about street cleaning / rules at that spot -> reply with spot, freshness,
rules, a camera frame and directions.

Run:  python -m agents.parksight_agent
"""
import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

from uagents import Agent, Context, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    TextContent,
    chat_protocol_spec,
)

from . import convex_client, format_reply, geocode
from .config import ROOT, load_env, require
from .messages import RulesRequest, RulesResponse
from .rules_service import lookup_rules

load_env()

HELP = (
    "I find and hold an open street-parking spot in San Francisco's **Castro**, using live public cameras.\n\n"
    "Try: *find me parking near the Castro Theatre*."
)

agent = Agent(
    name="parksight-agent",
    seed=require("AGENT_SEED"),
    port=int(os.environ.get("AGENT_PORT", "8001")),
    mailbox=True,
    publish_agent_details=True,
    readme_path=str(ROOT / "PARKSIGHT_AGENT_README.md"),
    description=(
        "Finds and holds an open street-parking spot in San Francisco's Castro using live public cameras, "
        "then warns about street cleaning and parking rules. Ask: find me parking near the Castro Theatre."
    ),
)

chat = Protocol(spec=chat_protocol_spec)


def _reply(text: str) -> ChatMessage:
    return ChatMessage(
        timestamp=datetime.now(timezone.utc),
        msg_id=uuid4(),
        content=[TextContent(type="text", text=text), EndSessionContent(type="end-session")],
    )


async def rules_for(ctx: Context, lat: float, lng: float, query: str) -> dict:
    """Ask the Rules Agent over uAgent messaging; fall back to the same code in-process if it's unreachable."""
    address = os.environ.get("RULES_AGENT_ADDRESS", "")
    if address:
        try:
            response, status = await ctx.send_and_receive(
                address, RulesRequest(lat=lat, lng=lng, query=query), response_type=RulesResponse, timeout=10)
            if isinstance(response, RulesResponse):
                return {
                    "streetCleaning": {"text": response.cleaning_text, "warning": response.cleaning_warning},
                    "hits": [h.dict() for h in response.hits],
                    "sources": {"datasf": response.datasf, "elastic": response.elastic},
                }
            ctx.logger.warning(f"Rules Agent gave no response ({status}); using in-process lookup")
        except Exception as e:
            ctx.logger.warning(f"Rules Agent call failed ({type(e).__name__}); using in-process lookup")
    return await asyncio.to_thread(lookup_rules, lat, lng, query)


@chat.on_message(ChatMessage)
async def on_chat(ctx: Context, sender: str, msg: ChatMessage):
    await ctx.send(sender, ChatAcknowledgement(timestamp=datetime.now(timezone.utc), acknowledged_msg_id=msg.msg_id))
    text = " ".join(c.text for c in msg.content if isinstance(c, TextContent)).strip()
    if not text or len(text) > 2000:
        await ctx.send(sender, _reply(HELP))
        return

    place = await asyncio.to_thread(geocode.resolve, text)
    try:
        result = await asyncio.to_thread(convex_client.find_spot, text, place.lat, place.lng, sender)
    except convex_client.ParkSightError as e:
        await ctx.send(sender, _reply(str(e)))
        return
    except Exception as e:  # never leak backend details into chat
        ctx.logger.error(f"find_spot failed: {type(e).__name__}: {e}")
        await ctx.send(sender, _reply("Something went wrong finding a spot. Try again in a moment."))
        return

    rules = None
    spot = result.get("spot")
    if spot:
        rules = await rules_for(ctx, spot["lat"], spot["lng"], text)
        ctx.logger.info(f"rules sources: {rules.get('sources')}")
    await ctx.send(sender, _reply(format_reply.compose(result, place.label, place.assumed, rules)))


@chat.on_message(ChatAcknowledgement)
async def on_ack(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.info(f"ack from {sender} for {msg.acknowledged_msg_id}")


@agent.on_event("startup")
async def started(ctx: Context):
    ctx.logger.info(f"ParkSight Agent address: {agent.address}")


agent.include(chat, publish_manifest=True)

if __name__ == "__main__":
    agent.run()
