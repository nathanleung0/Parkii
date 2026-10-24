# Merge status (update as work lands)

| Item | State |
|---|---|
| 0. Cloud Convex deployment | **Not done**: needs `npx convex login` by a team member. Until then the backend is local, so camera-frame links in agent replies are not reachable from ASI:One. |
| 1. `POST /agent/find` in Convex | Done and tested (401 / 400 / held spot + frame URL). |
| 2. ParkSight Agent (Agent Chat Protocol) | Built; chat handler tested end to end against the live backend; boots and publishes its manifest. **Not yet tried inside ASI:One** (needs the Agentverse mailbox step). Interactive Cards and Payment Protocol not built. |
| 3. Cartesia speech-to-text in the web app | Built (`transcribe` action + MediaRecorder UI). Error path tested; **not tested with a real key or a real microphone**. |
| 4. Rules Agent | Built. DataSF street cleaning verified live. Apify + Elastic path built and unit-tested with fake transports only; not run against real services. uAgent-to-uAgent delivery not verified (fallback runs in-process). |
| 5. Calibration, demo recording, submission | Not started (Cams 2 and 5 still need calibrating; README badges and Devpost opt-ins pending). |

---

# Merge plan: ParkSight absorbs the useful parts of Vortex

## Context
The team is merging its two Cal Hacks ideas.
- **ParkSight** (`D:\Cal Hacks 2026\parking finder`) works end to end: public Castro Street YouTube cams → YOLO → Convex → React/Leaflet map, with spot holds and a Claude/Cartesia voice assistant.
- **Vortex** (`D:\Cal Hacks 2026\vortex`, GitHub `JoshSunJ/vortex`) is a Windows voice workspace manager. It shares no maps, location, CV or Convex with ParkSight, but it has built pieces that fit a driver: Cartesia speech-to-text, a Fetch.ai agent boundary, and Nathan's Apify and Elastic adapters.

**Decisions made:**
- ParkSight is the product. Only Vortex parts that serve a driver come over; the desktop workspace manager (Electron app, extension, Windows helper) is set aside.
- Backend stays split: ParkSight keeps **Convex**. Vortex's Python providers run in their own process and talk to Convex over HTTP. No SpacetimeDB.

**Merged pitch:** "Ask for parking out loud, or ask an agent in ASI:One. ParkSight finds a spot that public cameras see open right now, holds it for you, and warns you about street cleaning or time limits before you park."

## What comes over from Vortex
| Vortex piece | Source (on `origin/main`) | Becomes in ParkSight |
|---|---|---|
| Cartesia speech-to-text (`ink-whisper`): request, audio magic-byte checks, error mapping | `apps/desktop/electron/voice.mjs` (`CartesiaVoice.transcribe`, `validateAudio`) | Convex action `assistant.transcribe`. Replaces the browser's speech recognition, so Cartesia covers both speech-to-text and text-to-speech. |
| Fetch.ai agent design (verified sender, per-session ID, safe reply formatting) | `services/fetch-agent/` (design only; it has no running uAgent) | A new Python uAgent, **ParkSight Agent**, with the Agent Chat Protocol, registered on Agentverse. |
| Apify extractor + URL guard | `services/intelligence/extract/{apify.py,url_guard.py}` | A **Rules Agent** feature: crawl public SFMTA parking-rule pages. |
| Elastic indexing and search | `services/intelligence/retrieval/elastic.py` (`ensure_setup`, `index_source`, `search_sources`) | A **Rules Agent** feature: semantic search over crawled rules. |
| Shared HTTP and error helpers | `services/intelligence/provider_common/` | Copied as-is; the adapters depend on them. |

Not carried over: the Electron desktop app, browser extension, Windows helper, Zod workspace contracts, Hono API, Gemini drafts and SpacetimeDB plans.

## Target layout (`parking finder/`)
```
convex/            existing + http routes /agent/find, action assistant.transcribe
src/               existing React app (VoiceAsk switches to MediaRecorder + Cartesia)
worker/            existing camera worker (unchanged)
agents/            NEW, Python 3.13
  parksight_agent.py    uAgent + Agent Chat Protocol: geocode → Convex /agent/find → ask Rules Agent → reply
  rules_agent.py        uAgent: street-cleaning lookup (DataSF) + Elastic search over Apify-crawled SFMTA pages
  geocode.py            Castro landmark table + Nominatim fallback limited to SF
  providers/            copied from vortex: extract/, retrieval/, provider_common/ (+ their tests)
  requirements.txt      uagents (+ the agent chat protocol package), pinned after a smoke test
  README.md             agent names and addresses, innovationlab/hackathon badges (Fetch requirement)
```

## Work items (ordered; owner suggestions follow each team member's Vortex lane)

### 0. Shared Convex deployment (Andrew, first, about 30 min)
- `npx convex login` and deploy to a **cloud** deployment. Teammates, phones and Agentverse-connected agents can't reach the current local `127.0.0.1:3210` backend, and frame URLs must be public for ASI:One replies.
- Move secrets with `npx convex env set`: `INGEST_SECRET`, `AGENT_SECRET` (new), `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`.
- The worker keeps running on one laptop and points at the cloud site URL. `worker/poll.py` already reads `CONVEX_SITE_URL`.
- Push to a public GitHub repo (Fetch requires one). Either a new `parksight` repo or a new branch in the team repo; don't touch Vortex `main`. Team's call.

### 1. Agent HTTP endpoint in Convex (Andrew or Nathan, about 45 min)
- Refactor `convex/assistant.ts` `ask` into an `internalAction` core (`askCore`) shared by the public `ask` action and the HTTP route.
- New route in `convex/http.ts`: `POST /agent/find`.
  - Request `{text, lat, lng, sessionId}`, checked against header `x-agent-secret`.
  - Calls `askCore`, which reuses `parking.candidates` / `parking.holdStall`, so holds and one-spot-per-driver still apply.
  - Response adds `frameUrl`, the latest camera frame for the chosen stall from `ctx.storage.getUrl`.
- Use the ASI:One sender address as `sessionId`, so each chat user holds at most one spot.

### 2. ParkSight Agent: Fetch.ai, the main sponsor deliverable (Nova, about 3 h)
Fetch's mandatory list: agent registered on Agentverse, Agent Chat Protocol, discoverable and usable in ASI:One with the whole flow inside the chat, real tool execution, public repo with run instructions.
- Build on the official uAgents chat protocol (`ChatMessage`, `ChatAcknowledgement`): acknowledge every message. Connect through a mailbox to Agentverse and give it a clear, searchable description ("live street parking in San Francisco's Castro from public cameras").
- Flow per message:
  1. Pull the place from the text; `geocode.py` turns it into lat/lng (Castro landmarks first, then Nominatim limited to SF with a proper User-Agent, at most 1 request per second).
  2. POST `/agent/find`.
  3. Send the stall's lat/lng to the Rules Agent (step 4).
  4. Reply with the spot, distance, how many seconds ago it was seen open and the confidence, any rule warning, the camera frame link and a Google Maps directions link.
- Reuse Vortex's reply rules (`formatAgentReply`): never echo raw JSON or backend error text, and say how fresh the data is.
- Stretch, in order:
  - ASI:One Interactive Cards (recommended by Fetch): a "Hold / Find another / Navigate" card.
  - Payment Protocol bonus, with a credible model: e.g., pay to extend a hold from 3 to 10 minutes.

### 3. Cartesia speech-to-text in the web app (Josh, about 1.5 h)
- New `convex/assistant.ts` action `transcribe(audio: bytes, mimeType)`, ported from `CartesiaVoice.transcribe`:
  - Same `https://api.cartesia.ai/stt` multipart request: `model=ink-whisper`, `Cartesia-Version: 2026-08-14`.
  - Same limits: ≤ 1 MB, ≤ 15 s, webm/ogg/wav magic-byte check.
  - Same rule of never echoing provider error text.
- `src/VoiceAsk.tsx`: hold-to-talk with `MediaRecorder` (webm/opus) → `transcribe` → existing `ask` → `speak`. Keep the typed input as the fallback when no key is set.
- Check the driver page works on a phone. The layout is already responsive; test it on the cloud URL.

### 4. Rules Agent: Apify + Elastic + DataSF (Nathan, about 3 h; also gives the Fetch multi-agent bonus)
- Copy `extract/`, `retrieval/` and `provider_common/` from `vortex` `origin/main` into `agents/providers/`, keeping their tests. Since they're standard-library only, the copy needs no changes beyond package paths.
- One-time setup command (`python -m agents.rules_agent seed`):
  - `ElasticRetrieval.ensure_setup()` with `ELASTIC_INDEX=parksight-rules`.
  - `extract_article` on a short list of public SFMTA pages (parking regulations, meters, time limits, residential permits).
  - `index_source(...)` with a fixed demo user and workspace scope `castro`.
- Each request from the ParkSight Agent:
  - **Street cleaning:** query the DataSF street-sweeping dataset (public Socrata API) for the block nearest the stall. Confirm the dataset ID and fields when implementing.
  - **Rules text:** `search_sources("parking rules near <street>", SearchScope(user_id=…, workspace_id="castro"))` for one cited excerpt.
- If Elastic or Apify isn't configured, reply with the street-cleaning info only. Say that plainly: per Vortex's own rule, a fallback doesn't count as sponsor evidence.

### 5. Integration, calibration, submission (Andrew, ongoing)
- Calibrate Cams 2 and 5 in `#/calibrate` and fix stall lat/lng on the map. Only Cam 1 is verified.
- Record a demo-safe frame set (`worker/poll.py --record`) during a busy hour for replay mode.
- README updates:
  - Architecture diagram with the agents.
  - Agent names and addresses, plus the two required badges.
  - Sponsor sections, each with a "verified live vs fallback" line.
- Devpost track opt-ins:
  - **Main targets:** Fetch.ai, Convex, Cartesia, Anthropic, Apify.
  - **Others:** Elastic (once its details are posted), Most Technically Complex, Planet-First.
  - Also register the submission through the CalHacks ASI:One Submission Agent, and record a 3–5 minute Fetch demo video showing the full flow inside ASI:One.

## Kept from Vortex's team rules
- One shared backend (Convex); providers stay behind HTTP.
- No secrets in source, logs or browser code. Keys live in Convex env and in the agents' `.env` (gitignored).
- Never present a fallback or planned feature as working sponsor evidence.
- Each change reports files changed, checks run and remaining limits.

## Verification
1. **Convex cloud:** worker running against the cloud deployment; the cloud driver page shows live frames and stall changes within ~20 s.
2. `curl -X POST <site>/agent/find -H "x-agent-secret: …" -d '{"text":"near Castro Theatre","lat":37.762,"lng":-122.4348,"sessionId":"test"}'` returns a held spot and a `frameUrl`. A second `sessionId` gets a different stall.
3. **ParkSight Agent:** starts locally and appears on Agentverse with an address. In **ASI:One**, "find me parking near the Castro Theatre" returns spot, freshness, rule warning, frame link and map link, all inside the chat.
4. **Rules Agent:**
   - `python -m agents.rules_agent seed` reports real Apify run IDs and indexed doc counts.
   - A search returns a cited excerpt.
   - The provider unit tests copied from Vortex pass (`python -m unittest discover agents/providers`).
5. **Voice:** on the phone, hold-to-talk → Cartesia transcript shown → spot held → Cartesia speech plays.
6. **Typecheck:** `npx tsc -p . --noEmit` is clean and Convex deploys without errors.
