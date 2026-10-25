# ParkSight agents (Fetch.ai)

For an initial ASI:One check without parking requests, see [connection-only chat testing](CHAT_TESTING.md).
For actual nearest-spot selection without a language model, see [nearest-spot mode](NEAREST_MODE.md).

Two uAgents that make ParkSight usable from **ASI:One chat** with no custom frontend.

| Agent | File | What it does |
|---|---|---|
| **ParkSight Agent** (`parksight-agent`) | `parksight_agent.py` | Agent Chat Protocol agent. Geocodes the place in the message, calls Convex `POST /agent/find` (Claude picks a spot from live camera data and **holds it for 3 minutes**), asks the Rules Agent about the spot, and replies with spot, freshness, rules, camera frame and directions. |
| **Rules Agent** (`parksight-rules-agent`) | `rules_agent.py` | Answers `RulesRequest(lat, lng, query)` with street-cleaning info (DataSF) and, when configured, a cited SFMTA rule excerpt (Elastic over Apify-crawled pages). |

Dev addresses (derived from the seeds in Nathan's local `agents/.env`; **seeds are not committed**):

- ParkSight Agent: `agent1qw5tx396kdrv2e78hf5qu7a7et2afvwx7q2qgjl8v2v4dnra6d0fvqzf2uv`
- Rules Agent: `agent1qgjy6v57hkhydmnl2mxn684g0qkl3wvrwlavjv26sy2qz6m87dxpxya0glu`

An address is fixed by its seed. Whoever hosts the demo agent must keep one seed and put the resulting address in the
submission README. Fetch also asks for the `innovationlab` and `hackathon` badges (markdown on the
[Cal Hacks hackpack](https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack)); paste them at the top of the root README.

## Run

```bash
python -m venv agents/.venv
agents/.venv/Scripts/pip install -r agents/requirements.txt        # bin/ instead of Scripts/ on mac/linux
cp agents/.env.example agents/.env                                 # fill in seeds, CONVEX_SITE_URL, AGENT_SECRET

# terminal 1 (optional, see "Rules Agent" below)
agents/.venv/Scripts/python -m agents.rules_agent                  # prints its address -> RULES_AGENT_ADDRESS
# terminal 2
agents/.venv/Scripts/python -m agents.parksight_agent
```

`AGENT_SECRET` must equal the value set on Convex (`npx convex env set AGENT_SECRET <value>`).

**One-time Agentverse step (needs your Agentverse login):** each agent logs `Agent mailbox not found: create one using the
agent inspector`. Open the printed inspector link, click **Connect → Mailbox**, then use **Chat with Agent** from the
Agentverse profile to reach ASI:One. The ParkSight Agent has already published its `AgentChatProtocol` manifest.

## Rules Agent and the in-process fallback

The ParkSight Agent contacts the Rules Agent over uAgent messaging (`send_and_receive`, 10 s timeout) when
`RULES_AGENT_ADDRESS` is set. If it's unset or unreachable, the **same** `rules_service.lookup_rules` runs in-process, so
a flaky Agentverse connection never breaks a parking answer. Set `RULES_AGENT_MAILBOX=0` to run the Rules Agent on a
plain local endpoint (same-machine setups).

## Rules sources: what is real

`lookup_rules` reports which sources actually ran (`sources: {datasf, elastic}`), and the reply never claims more:

- **DataSF street sweeping**: public dataset `yhqp-riqs`, no key. Verified live: queries by a small polygon around the
  stall (`intersects(line, ...)`), picks the nearest block face, computes the next sweep in SF time.
- **Elastic + Apify**: `python -m agents.seed_rules` crawls four SFMTA pages with Apify and indexes them in Elastic
  (`ELASTIC_INDEX=parksight-rules`). Needs `APIFY_TOKEN` and `ELASTIC_*`. Without them the reply simply has no rule excerpt.

## Tests

```bash
agents/.venv/Scripts/python -m unittest discover -s agents/tests -t .                  # offline agent tests
python -m unittest discover -s agents/providers/extract/tests -t .                     # 18 tests (from Vortex)
python -m unittest discover -s agents/providers/retrieval/tests -t .                   # 17 tests (from Vortex)
```

## Verified vs not (be upfront with judges)

Verified here:
- Chat handler end to end against the live local backend: geocode, held spot, real DataSF street-cleaning text, camera frame link, directions, acknowledgement plus end-session.
- Both agents boot; the ParkSight Agent publishes its `AgentChatProtocol` manifest.
- On Nova's demo host, an ASI:One message reached the local agent and returned the explicit
  connection-only reply without requesting parking. A subsequent @mention-prefixed help
  message returned the capability reply inside the same ASI:One conversation.
- Nearest-spot mode completed a real ASI:One parking request with C5-1, an application hold, DataSF
  street-cleaning text, working camera thumbnail, live-camera link and directions. No LLM was called.
- Convex `/agent/find`: 401 without secret, 400 on a bad body, two sessions get two different spots.

Not verified:
- **Language-model-backed parking workflow inside ASI:One**: nearest-spot mode is verified live;
  the Claude path is unverified pending confirmation of the team's backend credits.
- **uAgent-to-uAgent delivery** (ParkSight Agent to Rules Agent): the local test timed out because Agentverse's registration API was timing out from this machine; the in-process fallback covers it.
- **Apify crawl and Elastic search against real services**: adapters pass fake-transport unit tests only (inherited from Vortex).
- **Persistent detection-snapshot links**: ingest deletes old stored frames. Nearest mode uses verified
  public camera thumbnails (labeled as potentially lagging) and live-camera links instead.
- Interactive Cards and the Payment Protocol (Fetch bonuses) are not built.
