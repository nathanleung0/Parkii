# Nova's ParkSight demo host

Nova hosts the demo ParkSight Agent on the configured Windows computer. Keep that computer awake
and connected during the demonstration. Run only one process for this agent identity.

## Stable public identity

`agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq`

This is the demo address, distinct from Nathan's development address in the agents README.
The private seed is saved in gitignored `agents/.env`. Never regenerate it during routine setup,
copy it into this document, or run the same identity concurrently on another host.

The demo backend is `https://mellow-sandpiper-36.convex.site`. Its matching `AGENT_SECRET` is also
stored only in `agents/.env`; it must not be copied into chat, logs, screenshots, or Git.

## Verification on the demo host (24 October 2026)

Verified:
- Offline readiness checks pass for Python, pinned SDK, timezone package, cloud URL and private settings.
- Cloud `POST /agent/find` returns 401 without the secret and 400 with the correct secret and an
  invalid body. This verifies authentication without calling the model or creating a hold.
- Cloud `GET /cameras` responds with configured camera/stall data. Frame freshness is not verified.
- The running agent responds to local `GET /agent_info` with the demo address and port 8001.
- AgentChatProtocol manifest publication and Almanac API registration succeed.
- Nova confirmed that Chrome detects the local agent and enables the Inspector Connect button.

Not verified:
- Agentverse mailbox association and inbound chat delivery.
- The full parking workflow inside ASI:One, including a held spot and live camera-frame link.
- Remote Rules Agent delivery. An unset `RULES_AGENT_ADDRESS` uses the in-process fallback.
- Available Claude credits or the cost of a real parking request.

The SDK's optional on-chain Almanac registration can print a wallet-funds warning even after API
registration succeeds. No wallet funding, payment protocol, or token purchase was performed for this setup.

## Connect the mailbox

On the actual demo host, open:

[Local Agent Inspector](https://agentverse.ai/inspect/?uri=http%3A//127.0.0.1%3A8001&address=agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq)

Sign into Agentverse, then select **Connect -> Mailbox** when the inspector resolves the local agent.
The in-app browser could open `/agent_info` directly but its Inspector reported that it could not find
the agent. Chrome on the host detects the agent and enables Connect; use Chrome for the mailbox step.
Do not disable browser security, expose the local server through a public tunnel, or upload `.env`.

After mailbox association and the backend owner's free-credit confirmation, test in ASI:One:
*find me parking near the Castro Theatre*. Save the actual response and trace before marking the
integration verified. The application hold does not physically reserve a public parking space.

## Restart safely

First stop the existing demo process; do not start a duplicate. From the repository root, use the
virtual environment and an ignored working directory so SDK data files do not enter the source tree:

```powershell
$demoRoot = (Get-Location).Path
$demoPython = Join-Path $demoRoot 'agents/.venv/Scripts/python.exe'
& $demoPython -m agents.preflight
if ($LASTEXITCODE -ne 0) { throw 'Complete the missing local settings first.' }
$env:PYTHONPATH = $demoRoot
$env:PYTHONUNBUFFERED = '1'
New-Item -ItemType Directory -Force -Path 'agents/.uagents' | Out-Null
Push-Location 'agents/.uagents'
try { & $demoPython -m agents.parksight_agent }
finally { Pop-Location }
```

This reuses the existing seed; it does not generate a new identity. Runtime data and the current
background process's logs/PID are in ignored `agents/.uagents/`.
