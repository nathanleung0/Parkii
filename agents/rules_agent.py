"""Rules Agent: answers "what are the parking rules at this spot?" for the Parkii Agent.

Run:  python -m agents.rules_agent
Prints its agent address; put it in agents/.env as RULES_AGENT_ADDRESS for the Parkii Agent.
"""
import os

from uagents import Agent, Context

from .config import load_env, require
from .messages import RuleHit, RulesRequest, RulesResponse
from .rules_service import lookup_rules

load_env()

PORT = int(os.environ.get("RULES_AGENT_PORT", "8002"))
# Default: reachable through an Agentverse mailbox (create it once in the inspector). Set
# RULES_AGENT_MAILBOX=0 to serve a plain local endpoint instead, for agents on the same machine.
TRANSPORT = {"mailbox": True} if os.environ.get("RULES_AGENT_MAILBOX", "1") != "0" else {
    "endpoint": [f"http://127.0.0.1:{PORT}/submit"]}

agent = Agent(
    name="parkii-rules-agent",
    seed=require("RULES_AGENT_SEED"),
    port=PORT,
    **TRANSPORT,
    publish_agent_details=True,
    description="Looks up San Francisco street-cleaning schedules (DataSF) and SFMTA parking rules for a location.",
)


@agent.on_event("startup")
async def started(ctx: Context):
    ctx.logger.info(f"Rules Agent address: {agent.address}")


@agent.on_message(RulesRequest, replies=RulesResponse)
async def handle(ctx: Context, sender: str, msg: RulesRequest):
    rules = lookup_rules(msg.lat, msg.lng, msg.query)
    cleaning = rules["streetCleaning"]
    await ctx.send(sender, RulesResponse(
        cleaning_text=cleaning.get("text"),
        cleaning_warning=cleaning.get("warning"),
        hits=[RuleHit(title=h.get("title"), url=h.get("url"), excerpt=h.get("excerpt")) for h in rules["hits"]],
        datasf=rules["sources"]["datasf"],
        elastic=rules["sources"]["elastic"],
    ))


if __name__ == "__main__":
    agent.run()
