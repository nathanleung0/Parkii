![tag:innovationlab](https://img.shields.io/badge/innovationlab-3D8BD3)
![tag:hackathon](https://img.shields.io/badge/hackathon-5F43F1)

# Parkii

**Camera-observed street-parking availability.** Parkii processes configured neighborhood cameras, detects parked cars with computer vision, and shows drivers which monitored curb spots appear open. Its app-level hold keeps Parkii from sending another user to the same spot; it cannot reserve a public street space. You can ask for a spot by voice.

The app opens on the **New York City search map** (`#/`). It shows nearby NYC DOT traffic views and checks whether any independently calibrated parking spaces have recent observations. The checked-in NYC camera catalog has no parking stalls, so it does not yet produce NYC spot recommendations. The **San Francisco parking pilot** at `#/sf` has the Castro Street spaces from [Castro Street Cams](https://sfbaytimes.com/castro-street-cam/) (SF Bay Times, YouTube Live) plus public Caltrans highway snapshots across SF. Traffic views in either city are not parking availability observations.

```
YouTube Live (HLS) ──► Python worker ──► Convex ──► React app (map + live frames)
   3 Castro cams        YOLO vehicle      /ingest     Find-a-spot, 3-min holds,
                        detection         occupancy   voice (Claude + Cartesia)
```

The NYC page refreshes camera metadata twice daily, stores it as one catalog document, and displays the eight closest online cameras. Only recently selected views enter a bounded analysis queue (at most four); a separate NYC worker fetches a selected image about every 30 seconds and returns that same frame with dashed, tentative vehicle labels. The parking worker never polls the NYC traffic catalog. See [NYC demo setup](docs/NYC_DEMO.md).

## How it works

1. **Frames:** `worker/sources.py` reads configured YouTube Live, direct HLS, or HTTPS image feeds. Castro uses YouTube HLS via `yt-dlp`, with its live thumbnail as a fallback. New feeds are imported through an operator-only registry and require manual stall calibration.
2. **Detection:** `worker/poll.py` runs YOLO11s (cars, trucks, buses, motorcycles) on each configured parking feed. It POSTs vehicle candidates to Convex `/ingest`; a downscaled preview JPEG is uploaded once per minute by default. The app can show moving dashed labels on the processed frame. `worker/nyc_review.py` analyzes only selected NYC traffic views and does not update parking occupancy.
3. **Occupancy (in Convex):** `convex/ingest.ts` takes each vehicle's **ground footprint** (bottom 35% of its box) and checks how much falls inside each calibrated stall polygon (≥ 40% overlap). Candidates below 0.65 model confidence make the stall *unknown*. Three consistent strong occupied or clear observations are required before a stall becomes taken or open. The agreement score is not a calibrated probability of availability.
   - Why footprints: on an oblique camera, cars driving in the next lane overlap the curb stalls in image space. Tuned on Cam 1, parked cars score 0.6–0.8 and passing traffic scores 0–0.1. Whole-box overlap scored passing traffic at 0.24–0.38, causing false "taken" readings.
4. **Real-time state:** Convex pushes stall changes to nearby clients. `findSpot` considers camera-observed stalls within 600 m of the selected location and picks the nearest fresh, open stall that isn't held by another Parkii user. A search outside camera coverage reports that no live data is available there.
5. **Voice:** `convex/assistant.ts`
   - `transcribe`: the browser records with `MediaRecorder` and Cartesia `ink-whisper` turns it into text (ported from Vortex's `CartesiaVoice`: same endpoint, size/format checks, no provider error text echoed to the user).
   - `ask`: Claude (`claude-opus-5-5`, structured output) reads the request, e.g. "near the theater", and the live candidate list. It picks a stall and writes a one-sentence reply that mentions how fresh the data is. Without `ANTHROPIC_API_KEY` it falls back to the nearest spot.
   - `speak`: Cartesia `sonic-3.6` reads the reply aloud. Without `CARTESIA_API_KEY` the browser's built-in voice is used and typed input still works.
   - **Voice agent** (`convex/agent.ts`, what the web app's mic and Ask button use now): Claude runs a tool loop instead of making one pick. It can `look_at_camera` (the camera's latest frame is sent to Claude as an image, so it checks the curb itself), `list_open_spots`, `hold_spot` / `release_spot`, and drive the app with `show_camera`, `set_my_location` (a fixed list of Castro landmarks) and `start_navigation`. One request like "find parking near the Castro Theatre and give me directions" runs several of these tools, and the panel lists each step it took. It only acts through these Parkii tools; it can't click or type on the page. Without `ANTHROPIC_API_KEY` it falls back to the nearest-spot pick above.
   - **Streaming voice** (`src/cartesiaStream.ts`): the browser gets a 5-minute Cartesia access token from `assistant.voiceToken` (the API key stays on Convex). It streams `sonic-3.6` over WebSocket and plays each PCM chunk as it arrives. It says "On it." right away while the agent works. Fallbacks: the WAV from `speak`, then the browser voice.
6. **Calibrate view** (`#/calibrate`): opens the NYC candidate review, preserving the selected NYC camera when switching from the camera page. These annotations never become parking inventory automatically. The SF pilot's legal-stall calibration is at `#/calibrate/sf`; an operator defines the image region and street location of a stall there. Internal stall regions support occupancy decisions but are not drawn over the driver view. Changes apply without a worker restart.
7. **ASI:One agents** (`agents/`, merged in from the Vortex project): the **Parkii Agent** answers "find me parking near the Castro Theatre" inside ASI:One chat. The live `nearest` mode calls the shared Convex selection/hold mutation without an LLM; `assistant` mode uses `POST /agent/find`. Rules run in-process on the current demo host; optional remote Rules-Agent messaging, Apify and Elastic are separately configured and not claimed as verified live. See [agents/README.md](agents/README.md) for setup and exactly what is verified.

## Live ASI:One demo agent

Nova hosts `parkii-agent` at `agent1q2v2f0qaxhy2lntqrm3lfxv98ulg2eludr3z839ff3c7pv0s3ua6q6j5ceq`.
Ask `find me parking near the Castro Theatre` in ASI:One. The verified nearest
mode reuses Convex selection/holds and DataSF rules without an LLM call.
See [demo evidence and restart instructions](agents/DEMO_RUNBOOK.md) and
[agent setup](agents/README.md). A [3:40 silent, captioned demo draft](docs/demo/parksight-asi-one.mp4) is available for review. It was recorded under the former ParkSight name and is not a submitted pitch. Availability depends on current calibrated camera
readings; a no-availability reply is not proof of a successful held-spot demo.

## Run it

Prereqs: Node 20+, Python 3.11+.

```bash
npm install
npx convex dev                     # terminal 1 (local backend; or `npx convex login` for cloud)
npx convex env set INGEST_SECRET <same value as INGEST_SECRET in .env.local>
npx convex env set AGENT_SECRET <any random string; same value goes in agents/.env>
npx convex env set CALIBRATION_SECRET <operator-only key entered in #/calibrate>
npx convex run seed:castro         # once: cameras + starter stalls
npx convex run sfCameras:refreshCatalog  # once: load public SF traffic views; then every 6 hours

# Only after arranging NYC DOT feed access for this deployment:
npx convex env set NYC_DOT_FEED_ENABLED true
npx convex run nycCameras:refreshCatalog

python -m venv worker/.venv
worker/.venv/Scripts/pip install -r worker/requirements.txt     # (bin/ on mac/linux)
worker/.venv/Scripts/python worker/poll.py                      # terminal 2
worker/.venv/Scripts/python worker/nyc_review.py                # terminal 3: selected NYC views only

npm run dev                        # terminal 4 -> http://localhost:5173
```

Optional keys (set on the Convex deployment, never in the repo):
```bash
npx convex env set ANTHROPIC_API_KEY sk-ant-...
npx convex env set CARTESIA_API_KEY sk_car_...
npx convex env set CARTESIA_VOICE_ID <voice id>   # optional
```

Worker flags: `--once`, `--debug` (writes annotated frames to `worker/debug/`), `--record DIR` / `--replay DIR` (record live frames, replay them later), `--only castro-cam1`, `--interval 5`, `--preview-interval 60`, and `--shard-count N --shard-index I` for multiple worker processes.

To add **parking** cameras in SF or NYC, follow [the coverage guide](docs/COVERAGE.md). The checked-in parking seed still contains only the Castro proof of concept. A new feed only becomes searchable for parking after its legal stalls have been calibrated and the feed is enabled. The NYC DOT and Caltrans catalogs are separate camera-preview layers.

`yt-dlp` needs a JavaScript runtime for YouTube; it uses Node, which `sources.py` finds automatically.

## Files

| Path | What |
|---|---|
| `worker/poll.py` | Main loop: frame, then YOLO, then POST `/ingest`; debug, record and replay |
| `worker/sources.py` | YouTube Live HLS reader threads + thumbnail fallback |
| `convex/schema.ts` | Parking cameras, stalls, holds, and traffic-camera catalogs |
| `convex/nycCameras.ts` | Approved NYC DOT catalog, selected-view analysis queue, observations, and unverified review notes |
| `convex/sfCameras.ts` | Caltrans SF camera catalog refresh and read-only traffic previews |
| `worker/nyc_review.py` | Bounded NYC selected-camera inference; matches labels to the uploaded frame |
| `convex/http.ts` | `POST /ingest` (worker → Convex), `GET /cameras` (worker reads its camera list), `POST /agent/find` (Fetch.ai agent → Convex) |
| `convex/ingest.ts` | Footprint-in-stall occupancy + smoothing |
| `convex/parking.ts` | Queries, `findSpot` / holds, calibration mutations |
| `convex/assistant.ts` | Claude spot-picker, Cartesia speech-to-text and text-to-speech |
| `convex/seed.ts` | Castro cameras + starter stall polygons |
| `agents/` | Fetch.ai uAgents (Parkii Agent, Rules Agent), street-cleaning lookup, Vortex provider adapters in `agents/providers/` |
| `docs/MERGE_PLAN.md` | How Parkii and Vortex are merged, and what's done |
| `src/` | React app: NYC-first parking search and camera view, SF pilot, operator calibration, `CameraFrame`, `VoiceAsk` |

## Known limitations (be upfront with judges)

- Parking coverage is limited to the stalls each calibrated camera can see. Cam 1 has 4 stalls; Cams 2 and 5 have first-pass calibrations that miss empty legal spots and are being recalibrated by hand. Whether a stall is legal parking is unverified. Stall lat/lng values are approximate (about 20-30 m). NYC DOT and Caltrans traffic cameras are not calibrated curb parking coverage; the SF Caltrans views are mostly along highways and can be far from a selected neighborhood.
- YouTube live adds ~10–20 s of delay. Night frames are darker but Cam 1 still detects well.
- Castro frames come from public YouTube streams. A production deployment needs direct feed rights from the operator or another authorized source.
- Detection can't tell legal from illegal spots (hydrants, driveways, loading zones, time limits). Calibrate only legal stalls.

## Ideas for the team

- **More parking coverage:** review individual curb-facing feeds, arrange feed rights, and calibrate legal stalls. Camera count alone does not create parking availability.
- **Turnover prediction:** log stall status history and predict "likely to open in N minutes". Pairs well with Claude's spot choice.
- **Planet-First metric:** estimate circling time and CO₂ avoided per routed driver (needs a sourced baseline for search time in SF).
- **Rules layer:** SFMTA meter and parking-regulation open data, to label stalls metered, time-limited or tow-away.
- **Sponsor fit:** Convex (core real-time state), Anthropic (Claude spot-picker, honest about data freshness), Cartesia (speech-to-text and text-to-speech), Fetch.ai (ASI:One agent), Apify and Elastic (rules search, once verified live), Most Technically Complex.
