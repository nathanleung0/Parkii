# ParkSight

**Live street-parking availability from public cameras.** ParkSight watches public neighborhood cameras, detects parked cars with computer vision, and shows drivers which curb spots are open *right now*. It then holds a spot for them and routes them there. You can ask for a spot by voice.

Proof of concept: **Castro Street, San Francisco**, using the public [Castro Street Cams](https://sfbaytimes.com/castro-street-cam/) (SF Bay Times, YouTube Live).

```
YouTube Live (HLS) ──► Python worker ──► Convex ──► React app (map + live frames)
   3 Castro cams        YOLO vehicle      /ingest     Find-a-spot, 3-min holds,
                        detection         occupancy   voice (Claude + Cartesia)
```

## How it works

1. **Frames:** `worker/sources.py` resolves each camera's YouTube Live HLS stream with `yt-dlp` and keeps it open in a background thread, so it always has the newest 720p frame. The fallback is the YouTube live thumbnail.
2. **Detection:** `worker/poll.py` runs YOLO11s (cars, trucks, buses, motorcycles) on each frame every ~5 s. It POSTs the normalized vehicle boxes and a downscaled JPEG to Convex `/ingest`.
3. **Occupancy (in Convex):** `convex/ingest.ts` takes each vehicle's **ground footprint** (bottom 35% of its box) and checks how much falls inside each stall polygon (≥ 40% means occupied). Majority vote over the last 3 readings gives the status and a confidence score.
   - Why footprints: on an oblique camera, cars driving in the next lane overlap the curb stalls in image space. Tuned on Cam 1, parked cars score 0.6–0.8 and passing traffic scores 0–0.1. Whole-box overlap scored passing traffic at 0.24–0.38, causing false "taken" readings.
4. **Real-time state:** Convex pushes stall changes to every open client. `findSpot` picks the nearest fresh, open stall that isn't held by another driver, and holds it for 3 minutes, all in one transaction. So two drivers never get sent to the same spot.
5. **Voice:** `convex/assistant.ts`
   - `transcribe`: the browser records with `MediaRecorder` and Cartesia `ink-whisper` turns it into text (ported from Vortex's `CartesiaVoice`: same endpoint, size/format checks, no provider error text echoed to the user).
   - `ask`: Claude (`claude-opus-5-5`, structured output) reads the request, e.g. "near the theater", and the live candidate list. It picks a stall and writes a one-sentence reply that mentions how fresh the data is. Without `ANTHROPIC_API_KEY` it falls back to the nearest spot.
   - `speak`: Cartesia `sonic-3.6` reads the reply aloud. Without `CARTESIA_API_KEY` the browser's built-in voice is used and typed input still works.
   - **Voice agent** (`convex/agent.ts`, what the web app's mic and Ask button use now): Claude runs a tool loop instead of making one pick. It can `look_at_camera` (the camera's latest frame is sent to Claude as an image, so it checks the curb itself), `list_open_spots`, `hold_spot` / `release_spot`, and drive the app with `show_camera`, `set_my_location` (a fixed list of Castro landmarks) and `start_navigation`. One request like "find parking near the Castro Theatre and give me directions" runs several of these tools, and the panel lists each step it took. It only acts through these ParkSight tools; it can't click or type on the page. Without `ANTHROPIC_API_KEY` it falls back to the nearest-spot pick above.
   - **Streaming voice** (`src/cartesiaStream.ts`): the browser gets a 5-minute Cartesia access token from `assistant.voiceToken` (the API key stays on Convex). It streams `sonic-3.6` over WebSocket and plays each PCM chunk as it arrives. It says "On it." right away while the agent works. Fallbacks: the WAV from `speak`, then the browser voice.
6. **Calibrate view** (`#/calibrate`): click 4 corners on a live frame to draw a stall, then click the map to place it. Changes apply immediately; there's no worker restart.
7. **ASI:One agents** (`agents/`, merged in from the Vortex project): the **ParkSight Agent** answers "find me parking near the Castro Theatre" inside ASI:One chat via Convex `POST /agent/find` (same Claude spot-picker and 3-minute holds as the web app). It asks the **Rules Agent** for street cleaning (DataSF) and SFMTA rules text (Apify + Elastic, adapters copied from Vortex). See [agents/README.md](agents/README.md) for setup and exactly what is verified.

## Run it

Prereqs: Node 20+, Python 3.11+.

```bash
npm install
npx convex dev                     # terminal 1 (local backend; or `npx convex login` for cloud)
npx convex env set INGEST_SECRET <same value as INGEST_SECRET in .env.local>
npx convex env set AGENT_SECRET <any random string; same value goes in agents/.env>
npx convex run seed:castro         # once: cameras + starter stalls

python -m venv worker/.venv
worker/.venv/Scripts/pip install -r worker/requirements.txt     # (bin/ on mac/linux)
worker/.venv/Scripts/python worker/poll.py                      # terminal 2

npm run dev                        # terminal 3 -> http://localhost:5173
```

Optional keys (set on the Convex deployment, never in the repo):
```bash
npx convex env set ANTHROPIC_API_KEY sk-ant-...
npx convex env set CARTESIA_API_KEY sk_car_...
npx convex env set CARTESIA_VOICE_ID <voice id>   # optional
```

Worker flags: `--once`, `--debug` (writes annotated frames to `worker/debug/`), `--record DIR` / `--replay DIR` (record live frames, replay them later, e.g. for a demo at night), `--only castro-cam1`, `--interval 5`.

`yt-dlp` needs a JavaScript runtime for YouTube; it uses Node, which `sources.py` finds automatically.

## Files

| Path | What |
|---|---|
| `worker/poll.py` | Main loop: frame, then YOLO, then POST `/ingest`; debug, record and replay |
| `worker/sources.py` | YouTube Live HLS reader threads + thumbnail fallback |
| `convex/schema.ts` | `cameras`, `stalls`, `holds` |
| `convex/http.ts` | `POST /ingest` (worker → Convex), `GET /cameras` (worker reads its camera list), `POST /agent/find` (Fetch.ai agent → Convex) |
| `convex/ingest.ts` | Footprint-in-stall occupancy + smoothing |
| `convex/parking.ts` | Queries, `findSpot` / holds, calibration mutations |
| `convex/assistant.ts` | Claude spot-picker, Cartesia speech-to-text and text-to-speech |
| `convex/seed.ts` | Castro cameras + starter stall polygons |
| `agents/` | Fetch.ai uAgents (ParkSight Agent, Rules Agent), street-cleaning lookup, Vortex provider adapters in `agents/providers/` |
| `docs/MERGE_PLAN.md` | How ParkSight and Vortex are merged, and what's done |
| `src/` | React app: `DriverView`, `Calibrate`, `CameraFrame` (SVG overlay), `VoiceAsk` |

## Known limitations (be upfront with judges)

- Coverage is limited to the stalls each camera can see: about 4 on Cam 1, plus rough starter stalls on Cams 2 and 5 that **need calibrating** in the UI. Stall lat/lng values are approximate.
- YouTube live adds ~10–20 s of delay. Night frames are darker but Cam 1 still detects well.
- Frames come from public YouTube streams. Fine for a hackathon proof of concept, but a real deployment would need a data agreement with the camera owner or a city DOT feed.
- Detection can't tell legal from illegal spots (hydrants, driveways, loading zones, time limits). Calibrate only legal stalls.

## Ideas for the team

- **More coverage:** add cameras (any public cam or city DOT feed works the same way). NYC DOT has ~900 JPEG cams with no API key at `webcams.nyctmc.org/api/cameras`, a strong second-city demo.
- **Turnover prediction:** log stall status history and predict "likely to open in N minutes". Pairs well with Claude's spot choice.
- **Planet-First metric:** estimate circling time and CO₂ avoided per routed driver (needs a sourced baseline for search time in SF).
- **Rules layer:** SFMTA meter and parking-regulation open data, to label stalls metered, time-limited or tow-away.
- **Sponsor fit:** Convex (core real-time state), Anthropic (Claude spot-picker, honest about data freshness), Cartesia (speech-to-text and text-to-speech), Fetch.ai (ASI:One agent), Apify and Elastic (rules search, once verified live), Most Technically Complex.
