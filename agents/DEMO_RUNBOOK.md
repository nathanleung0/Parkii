# Nova's live Parkii ASI:One demo

## Identity and host

- Agent: `parkii-agent`
- Stable public address: `agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq`
- Demo backend: `https://mellow-sandpiper-36.convex.site`
- One running process on Nova's Windows demo host, port 8001.
- Keep the existing private seed in ignored `agents/.env`; do not regenerate it,
  publish it, or run this identity on two hosts.

The live configuration uses `PARKII_CHAT_ONLY=0` and
`PARKII_PARKING_MODE=nearest`. This reuses shared Convex freshness, selection
and application holds without calling Claude. `assistant` remains an explicit
alternative; do not silently change modes during a demo.

## Actual evidence — 24 October 2026, America/Los_Angeles

Verified live:
- Agent health responds at `http://127.0.0.1:8001/agent_info` with the address above.
- Agentverse mailbox registration and the ACP manifest succeeded.
- Real ASI:One messages reached the hosted agent and received help and parking replies.
- At 6:51 PM, a real nearest-mode reply selected C5-1 and included a three-minute
  application hold, processed age, DataSF cleaning text, camera links and directions.
  This is historical evidence; those old camera-5 stalls are not current calibration.
- At 9:27–9:30 PM, new ASI:One parking/help requests succeeded. The parking reply
  reported no fresh open spots. Independent public camera/stall queries showed
  five recent camera feeds and five registered stalls all marked taken at that time.
- The backend `/agent/find` authentication was checked with rejected unauthorized
  and malformed requests. Those checks do not verify its Claude workflow.

Not yet verified/completed:
- A fresh successful held-spot recording after the team's latest calibration changes.
- A submitted 3–5 minute video and final Devpost/ASI submission (Andrew coordinates).
- Claude-backed parking inside ASI:One, remote Rules-Agent delivery, Apify or Elastic.
- Interactive Cards and payments; these are stretch items and no payment was made.

The team confirmed hackathon Claude credits. This does not independently verify
billing settings; the current nearest-mode demo makes no Claude call.

## Current camera contract

The public `parking:listCameras` response may omit `youtubeId`. The agent returns
the fixed [official Castro camera page](https://sfbaytimes.com/castro-street-cam/)
for known Castro cameras, labeled Camera feeds. If a validated video ID is
provided, the existing live-video and potentially lagging thumbnail links remain.
Ephemeral Convex storage URLs are not presented as durable detection snapshots.
Operator `GET /cameras` requires its own ingest secret; agents use public queries.

## Recording outline (3–5 minutes; no recording has been fabricated)

1. Explain that the agent turns a location request into a shared parking lookup,
   application hold, rules check and directions inside ASI:One.
2. Open this exact agent, send `help`, then the Castro Theatre parking request.
3. If a real eligible spot exists, show its label, processed age, agreement,
   application hold, DataSF warning, camera link and directions.
4. Explain that the hold only coordinates Parkii users; public curb access
   cannot be reserved. Camera lag and calibration can still cause errors.
5. If no spot exists, show the honest reply. A successful-flow recording needs a
   genuinely available calibrated stall or a visibly labeled replay from Nathan.
   Do not force occupied stalls open to manufacture evidence.

## Setup and safe restart

Install `agents/requirements.txt` in a virtual environment and configure ignored
`agents/.env`. Run `python -m agents.preflight` first. Its offline output hides
all configuration values; nearest mode accepts an HTTPS Convex cloud/site origin
without requiring the assistant-only secret. Keep the existing stable seed.

Stop only the existing Parkii demo process before restarting. From repo root:

```powershell
$demoRoot = (Get-Location).Path
$demoPython = Join-Path $demoRoot 'agents/.venv/Scripts/python.exe'
& $demoPython -m agents.preflight
if ($LASTEXITCODE -ne 0) { throw 'Complete local setup first.' }
$env:PYTHONPATH = $demoRoot
$env:PYTHONUNBUFFERED = '1'
New-Item -ItemType Directory -Force -Path 'agents/.uagents' | Out-Null
Push-Location 'agents/.uagents'
try { & $demoPython -m agents.parkii_agent }
finally { Pop-Location }
```

If reconnecting, open the host's Agentverse Inspector and select Connect → Mailbox.
Do not expose port 8001 publicly or put secrets in links. Runtime logs/PID remain
in ignored `agents/.uagents/`. No account, wallet or billing change is required.

## Handoff for Andrew

The stable address is above. Agent code, readiness checks and live evidence are
consolidated on the integration branch. Final submission and recording links must
be added after they actually exist. Follow the official
[Fetch CalHacks instructions](https://www.fetch.ai/events/hackathons/calhacks-13-0/hackpack)
for public code, agent categorization, video and submission registration.
