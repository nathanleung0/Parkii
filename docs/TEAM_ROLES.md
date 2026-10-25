# Team roles: who owns what

Status is as of commit `0bdc3d8` (Sat 3:39 PM). Most features are **built**; what's left is mainly getting them **working live** and ready for the demo. For build status details, see [MERGE_PLAN.md](MERGE_PLAN.md#merge-status-update-as-work-lands) and [agents/README.md](../agents/README.md).

## How we split work

- **By feature, not by layer.** Each person owns one feature from start to finish (UI, Convex, Python, provider), so nobody waits on a "backend person."
- **Nathan reviews shared Convex code.** Changes to `convex/schema.ts` and shared functions (`findSpot`, `holdStall`, `askCore`) go through him. Everyone else adds new functions or files rather than rewriting his.
- **Be honest about what works.** A fallback, a fixture or a fake-transport test is not live sponsor evidence. Mark each feature "verified live" or "not verified" in the README.
- **No secrets in Git.** Keys go in Convex env (`npx convex env set`) or gitignored `.env` files.

## Overview

| Person | Owns | First thing to do |
|---|---|---|
| **Andrew** | Cloud deployment + integration + submission | Deploy Convex to the cloud so everyone (and ASI:One) can reach it |
| **Nova** | ASI:One / Fetch.ai agent, live | Connect the Parkii Agent's mailbox on Agentverse and chat with it in ASI:One |
| **Josh** | Voice, live | Test speech-to-text with a real Cartesia key and a real microphone |
| **Nathan** | Cameras, coverage, demo footage + Convex reviewer | Recalibrate Cams 2 and 5 by hand, then record demo footage |

## Andrew: cloud deployment, integration, submission

**Why it matters:** the backend currently runs on one laptop, so phones, teammates and ASI:One can't reach it, and camera-frame links in agent replies are dead. Everything below depends on the cloud deployment.

1. **Cloud Convex (first, ~30 min).**
   - Confirm with Nathan whether a cloud deployment exists; if not, create the team's.
   - `npx convex login`, then deploy.
   - Move `INGEST_SECRET`, `AGENT_SECRET`, `ANTHROPIC_API_KEY` and `CARTESIA_API_KEY` into the deployment with `npx convex env set`.
   - Point the camera worker at it (`CONVEX_SITE_URL`). Only one worker should run.
   - Share the client URL with the team privately.
2. **End-to-end check.** On a phone, against the cloud URL: map loads, spots update, "Find me a spot" holds one, and a second phone gets a different spot.
3. **Submission.**
   - README: architecture diagram including the agents, agent names and addresses, the `innovationlab` and `hackathon` badges, and a "verified live vs not" line per sponsor.
   - Devpost track opt-ins: Fetch.ai, Convex, Cartesia, Anthropic, and Apify/Elastic only if verified live. Also Most Technically Complex and Planet-First.
   - Register through the CalHacks ASI:One Submission Agent.
4. **Demo lead.** Run the pitch rehearsals and keep the backup recording.

**Done when:** the cloud URL works on a phone, the README and Devpost are submitted, and every sponsor claim matches what was verified.

## Nova: ASI:One / Fetch.ai agent, live

**State (Nova host, 24 October 2026):** the agent is connected to Agentverse and
verified live inside ASI:One. The current demo uses explicit nearest-spot mode
without an LLM. The full historical held-spot/rules/directions reply and the latest
no-availability check are documented in [the demo runbook](../agents/DEMO_RUNBOOK.md).

1. Cloud configuration, stable seed, one demo host, mailbox connection and ACP
   registration are complete on Nova's computer.
2. ASI:One help and real Convex parking requests are verified. A held-spot reply
   was observed earlier; availability depends on the current calibrated camera data.
3. Andrew can use the stable public agent address in the runbook and root README.
4. A [3:40 captioned ASI walkthrough draft](demo/parksight-asi-one.mp4) is prepared
   under the former ParkSight name. It includes a genuine successful response and
   a later no-availability request; it is a sampled, silent review draft. Andrew
   coordinates final review, any continuous successful-flow retake, and submission.
   Do not force occupied stalls open or present old replies as current readings.
5. Remote Rules-Agent messaging, Claude-in-ASI, Elastic and Apify are not marked
   verified by the nearest-mode evidence. Interactive Cards and payment remain stretch.

**Done when:** a stranger can reach the stable agent in ASI:One and the submitted
video shows the primary parking workflow with honest data/source limitations.

## Josh: voice, live

**State:** the `transcribe` action and MediaRecorder UI (`src/VoiceAsk.tsx`, `convex/assistant.ts`) are built. They haven't been tested with a real Cartesia key or a real microphone.

1. Test with a real `CARTESIA_API_KEY`: hold to talk → transcript shown → spot held → reply spoken by Cartesia.
2. Test on a **real phone** against the cloud URL. Phones only allow the mic over HTTPS, which the cloud URL provides.
3. Make sure failure cases fall back cleanly: no key, mic denied, and a recording that's too long or silent should all fall back to typed input.
4. Polish the voice UI for a noisy expo table: clear recording state and a stop button.

**Done when:** voice works start to finish on a phone, and Cartesia handles both speech-to-text and text-to-speech.

## Nathan: cameras, coverage, demo footage, Convex reviewer

**State:** Cam 1 has 4 stalls. Cam 2 has 1 stall (left curb, east side of Castro St; legality unverified) and Cam 5 has none. Those two are a first pass from a 13-minute recording, which can only reveal spots where a car was parked, so they miss empty legal spots. Map positions are approximate (about 20-30 m). Only DataSF is verified live in the Rules Agent.

1. **Recalibrate Cams 2 and 5 by hand** at `#/calibrate` (add the missing spots, check the Cam 1 and Cam 2 stalls are legal, nudge map positions), then copy the final stalls into `convex/seed.ts` so everyone gets them. More verified spots make the demo stronger.
2. **Record demo footage** with `worker/poll.py --record` during a busy daytime hour, so the demo can run in replay mode at night.
3. **Review shared Convex changes** (schema, `findSpot`, `holdStall`, `askCore`).
4. **Stretch, cut first if short on time:** run the Apify crawl and Elastic search for real (`python -m agents.seed_rules`) so the Rules Agent can cite SFMTA rules. DataSF street cleaning already works without them.

**Done when:** at least two cameras have calibrated stalls that read correctly, and replay footage is saved.

## Order and dependencies

1. **Andrew's cloud deployment comes first.** Nova's ASI:One test and Josh's phone test need it.
2. **Nathan** (calibration, footage) can start immediately, since it doesn't need the cloud.
3. **Josh** can test with a real key locally while the cloud is set up, then test on a phone.
4. **Record footage before dark.** Night frames are darker.

## Cut list (if time gets short)

1. Apify + Elastic rule search (keep DataSF street cleaning)
2. Payment Protocol
3. Interactive Cards
4. Extra cameras beyond 1, 2 and 5
