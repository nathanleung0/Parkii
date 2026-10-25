# Parkii agents (Fetch.ai)

For an initial ASI:One check without parking requests, see [connection-only chat testing](CHAT_TESTING.md).
For actual nearest-spot selection without a language model, see [nearest-spot mode](NEAREST_MODE.md).

Two uAgents that make Parkii usable from **ASI:One chat** with no custom frontend.

| Agent | File | What it does |
|---|---|---|
| **Parkii Agent** (`parkii-agent`) | `parkii_agent.py` | Agent Chat Protocol agent. Geocodes the destination, reuses Convex selection and three-minute application holds, obtains rules, and replies inside ASI:One. The live demo explicitly uses `nearest` mode without an LLM; `assistant` mode calls `/agent/find`. |
| **Rules Agent** (`parkii-rules-agent`) | `rules_agent.py` | Answers `RulesRequest(lat, lng, query)` with street-cleaning info (DataSF) and, when configured, a cited SFMTA rule excerpt (Elastic over Apify-crawled pages). |

Dev addresses (derived from the seeds in Nathan's local `agents/.env`; **seeds are not committed**):

- Parkii Agent: `agent1qw5tx396kdrv2e78hf5qu7a7et2afvwx7q2qgjl8v2v4dnra6d0fvqzf2uv`
- Rules Agent: `agent1qgjy6v57hkhydmnl2mxn684g0qkl3wvrwlavjv26sy2qz6m87dxpxya0glu`

An address is fixed by its seed. Whoever hosts the demo agent must keep one seed and put the resulting address in the
submission README. Fetch also asks for the `innovationlab` and `hackathon` badges (markdown on the
[Cal Hacks hackpack](https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack)); paste them at the top of the root README.

## Demo host

Nova hosts the demo agent at `agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq`. See [the demo runbook](DEMO_RUNBOOK.md) for its stable public address,
verified connection checks, live ASI:One evidence, limitations, and restart instructions. Nathan's addresses above
remain development identities; do not reuse their seeds on a second host.

## Run

```bash
python -m venv agents/.venv
agents/.venv/Scripts/pip install -r agents/requirements.txt        # bin/ instead of Scripts/ on mac/linux
cp agents/.env.example agents/.env                                 # fill in seeds, CONVEX_SITE_URL, AGENT_SECRET

# terminal 1 (optional, see "Rules Agent" below)
agents/.venv/Scripts/python -m agents.rules_agent                  # prints its address -> RULES_AGENT_ADDRESS
# terminal 2
agents/.venv/Scripts/python -m agents.parkii_agent
```

In assistant mode, `AGENT_SECRET` must equal the value set on Convex (`npx convex env set AGENT_SECRET <value>`).

**One-time Agentverse step (needs your Agentverse login):** each agent logs `Agent mailbox not found: create one using the
agent inspector`. Open the printed inspector link, click **Connect → Mailbox**, then use **Chat with Agent** from the
Agentverse profile to reach ASI:One. The Parkii Agent has already published its `AgentChatProtocol` manifest.

## First setup on a new teammate's computer

Before starting the public agent, run the offline readiness check from the repository root:

```powershell
agents/.venv/Scripts/python -m agents.preflight
```

It reports missing packages and settings without making network requests or printing their values.
A failed check means setup is incomplete, not that a sponsor integration has been tested.

- Ask Andrew for the cloud `CONVEX_SITE_URL` (HTTPS, ending in `.convex.site`).
- For assistant mode, receive the matching `AGENT_SECRET` privately and store it only in gitignored `agents/.env`.
  Nearest mode uses public Convex functions and does not require that assistant secret.
  Do not paste secrets into chat, screenshots, commits, or issue/PR text.
- Agree who hosts the demo agent before choosing `AGENT_SEED`. A different seed creates a different
  address from Nathan's development address above; two hosts must not run the same identity concurrently.
- Keep the same seed for subsequent runs. Do not regenerate it during routine setup.
- Connect the running agent to your Agentverse mailbox using the inspector link, then test through ASI:One.

The readiness check does not call `/agent/find`. A real parking request can call the team's configured
Claude model and create an application-level spot hold. Coordinate with the backend owner before live tests.
Local package installation and the offline check do not require a paid model API key.

## Rules Agent and the in-process fallback

The Parkii Agent contacts the Rules Agent over uAgent messaging (`send_and_receive`, 10 s timeout) when
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
- Both agents boot; the Parkii Agent publishes its `AgentChatProtocol` manifest.
- On Nova's demo host, an ASI:One message reached the local agent and returned the explicit
  connection-only reply without requesting parking. A subsequent @mention-prefixed help
  message returned the capability reply inside the same ASI:One conversation.
- Nearest-spot mode completed a real ASI:One parking request with C5-1, an application hold, DataSF
  street-cleaning text, working camera thumbnail, live-camera link and directions. No LLM was called.
- Convex `/agent/find`: 401 without secret, 400 on a bad body, two sessions get two different spots.

Not verified:
- **Language-model-backed parking workflow inside ASI:One**: nearest-spot mode is verified live;
  the team reports hackathon credits, but the Claude-in-ASI path has not been independently verified here.
- **uAgent-to-uAgent delivery** (Parkii Agent to Rules Agent): the local test timed out because Agentverse's registration API was timing out from this machine; the in-process fallback covers it.
- **Apify crawl and Elastic search against real services**: adapters pass fake-transport unit tests only (inherited from Vortex).
- **Persistent detection-snapshot links**: ingest deletes old stored frames. Nearest mode uses verified
  public camera thumbnails (labeled as potentially lagging) when a validated video ID exists. With the current public camera API, known Castro cameras use a fixed official camera-directory link instead.
- Interactive Cards and the Payment Protocol (Fetch bonuses) are not built.
