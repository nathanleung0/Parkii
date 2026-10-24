# ParkSight + Vortex: proposed integration

Prepared 25 October 2026. Documentation and preview only; this proposal introduces no application-code changes.

## Recommendation

Make **ParkSight the product** and keep Vortex's dashboard as a **Trip workspace**: a place to collect the destination, selected trip-related browser tabs, parking evidence, source-linked rules and the next step before leaving the laptop.

Pitch: **“Plan your outing on your laptop. Ask for camera-observed parking. Take the route and context to your phone.”**

The parking map remains the default driver screen. The trip dashboard supports planning before departure; it is not another dashboard to operate while driving. Keep the original Vortex desktop app available in its own repository, while ParkSight retains the voice and provider pieces already integrated and adds the trip workspace in small steps.

Keeping an unrelated general-purpose desktop manager in the main demo would weaken the story. Keeping trip-related tabs and continuity gives that work a clear purpose.

## What I actually inspected

- ParkSight main at `6fdbe176ae0855dc531f56a277b1734525ba551f`: React/Vite/Leaflet frontend, Convex parking state and assistant actions, Python camera/YOLO worker, calibration UI, and the existing merge plan.
- Vortex local main at `1478868af7f236db54ef07173a9d1e34922c67d4`: Electron dashboard, browser extension, local workspace/checkpoint services, Cartesia STT/TTS, intelligence/Fetch boundaries, and Elastic/Apify adapters.
- This review inspected source; it did not run ParkSight, connect its cameras, verify its cloud deployment, or establish sponsor eligibility.

Nathan's [existing merge plan](https://github.com/nathanleung0/parksight/blob/main/docs/MERGE_PLAN.md) already proposes ParkSight as the product and imports Cartesia STT, Fetch, Apify and Elastic. It drops the Electron app and tab dashboard. **My change to that proposal is to retain the dashboard's task/resource/checkpoint interaction as trip planning, while leaving OS window control off the critical path.**

## Publication update

Before publication, ParkSight main advanced to `1dc107928efdc64cb15662e8f3266cce00ce5540`. Its source now includes MediaRecorder, a Cartesia transcribe action, the agent endpoint and agent/provider code. The current merge-status document reports cloud deployment, real-key/microphone STT validation and ASI:One verification as outstanding. The remaining port tasks below should therefore be read as **verify and harden the existing implementation**, not build duplicate components. The new proposal remains the trip dashboard and explicit phone continuity.

An accompanying [ML occupancy assessment](ML_OCCUPANCY_RECOMMENDATION.md) covers the detector/geometry failure modes and a fixed-space classifier pilot. No trained model or measured improvement is claimed.

## The user journey

1. On the laptop, create **Castro evening** with a destination and selected resources: the venue page, directions, an official parking-rule source and any relevant planning tab.
2. Ask, “Find parking near my destination.” Resolve the destination to confirmed coordinates, then use ParkSight's existing candidate-selection service. Its initial coverage remains the calibrated, camera-visible Castro stalls.
3. Show the chosen camera observation, its source and freshness, and any cited rule information. Missing or stale evidence is explicit.
4. Save a checkpoint: “Next: recheck availability and read the signs when I arrive.”
5. Preview a phone brief containing the destination, route, selected links, note and dated observation; explicitly hand it to a paired phone.
6. On the phone, reopen the trip and refresh availability before using the suggestion. Saved evidence is not a current parking guarantee.

No unrelated tabs, native document contents or full desktop inventory are uploaded.

## What to keep, adapt and defer

| Component | Proposed treatment | Why |
|---|---|---|
| ParkSight camera worker, geometry and occupancy pipeline | Keep | This is the pivot's core capability. Preserve its current flow before adding UI. |
| ParkSight map, driver screen and calibration screen | Keep | The driver needs parking evidence and directions first. |
| ParkSight Convex backend | Keep as the shared parking/trip backend for the first merge | Avoid replacing working persistence or introducing two authorities for stall state. |
| Vortex resource cards, explicit selection, workspace goal and checkpoints | Adapt into a React Trip workspace screen | Gives selected tabs a concrete parking/travel purpose. |
| Vortex Cartesia speech-to-text | Verify and harden the existing ParkSight transcribe action and MediaRecorder flow | This port has now landed; real-key/microphone verification is still reported pending. |
| ParkSight assistant and existing TTS | Keep the service path; add bounded requests, cancellation and sanitized errors from Vortex | Avoid competing assistants or an unnecessary model migration during integration. |
| Vortex browser extension / Electron dashboard | Preserve separately; optional selected-tab importer after the web trip flow works | Real browser tracking remains a local capability. A saved-link list is not automatically a live tab tracker. |
| Vortex Apify / Elastic | Adapt for a small set of official parking-rule sources | Return citations and retrieval dates; never infer exact curb legality from generic text. |
| Vortex Fetch boundary | Reuse its verified identity, scope and safe-reply patterns | The running ACP host, registration and ASI:One journey still need implementation and evidence. |
| Generic native-window focus, OS control and automatic tab cleanup | Defer from the parking demo | They do not improve the parking decision; the reported ChatGPT-switching issue is not a pivot dependency. |
| Original Vortex repository and history | Preserve | Port selected modules through small PRs; do not replace either repository wholesale. |

The dashboard can retain the familiar resource-selection layout. Its labels become **Trips**, **Resources**, **Checkpoint** and **Phone brief**. The initial web version can accept explicitly pasted URLs; a later importer must genuinely transfer selected browser tabs before we claim live tab integration.

## Implementation shape

Use `nathanleung0/parksight` as the destination repository, on a proposed branch such as `feat/trip-workspace`. Keep its lockfile and existing folders. Do not perform an unrelated-history Git merge or copy Vortex's root package files over ParkSight.

```text
src/
  DriverView.tsx             existing parking experience
  VoiceAsk.tsx               bounded recording -> STT -> existing ask -> TTS
  trips/
    TripDashboard.tsx         trip goal, selected links, checkpoint
    TripResourceCard.tsx      adapted Vortex interaction
    PhoneBriefPreview.tsx    explicit share-content preview
    PhoneTripView.tsx         responsive reader + refresh availability
convex/
  parking.ts                 single authority for candidates/app-only holds
  assistant.ts               existing ask/speak + proposed transcribe action
  trips.ts                   proposed owner-scoped trip operations
  tripBriefs.ts               proposed immutable brief + pairing/redemption
  schema.ts                  additive trip/resource/checkpoint/brief records
worker/                      existing capture and detection worker
agents/                      provider/Fetch work described in Nathan's plan
```

Port recording/type/size checks and timeouts from Vortex; do not copy Electron IPC or trusted-frame assumptions into a public web endpoint. React components should call the same parking service path used by the driver screen and agent entrypoint.

### Proposed data and authority contract

These are new ParkSight records, not changes to Vortex's canonical wire-1.0 types.

- **Trip:** Convex ID, server-derived owner identity, name, confirmed destination label/coordinates, revision, selected resource IDs and latest checkpoint ID.
- **TripResource:** trip ID, title, HTTP(S) URL, kind (`destination`, `route`, `rule`, `web_link`) and provenance (`user_added`, `user_selected_tab`, `official_rule`). Imported browser identities remain local. Phone inclusion requires an explicit selection/preview.
- **TripCheckpoint:** trip ID/revision, explicit user note and selected resource references. Saving does not read native documents, close tabs or mutate parking state.
- **ParkingObservation:** stall/camera references, observation timestamp, ingestion timestamp, live/replay mode and observed status. Preserve provenance. An occupancy-vote agreement score must not be presented as a calibrated probability of parking success.
- **TripBrief:** immutable snapshot of the confirmed destination, selected resources, checkpoint and dated observation, with owner, creation time and expiry. Live availability is refreshed separately.
- **Pairing:** expiring, single-use redemption tied to a trip and authenticated owner. The phone receives read access to that trip brief, not desktop-control credentials or the whole account.

Minimal operations:

| Proposed operation | Required behavior |
|---|---|
| Create/update trip | Derive identity on the server; validate coordinates and membership; reject stale revisions. |
| Add selected resources | Validate bounded HTTP(S) metadata; require explicit selection; do not upload browsing inventory. |
| Preview parking | Reuse current candidates; require a resolved destination; return freshness and uncertainty. |
| Save checkpoint | Persist the exact note and selected references without claiming inferred app progress. |
| Preview/create phone brief | Show the exact content first; create an immutable, owner-scoped snapshot. |
| Redeem paired brief | Enforce expiry, single use and revocation; never treat a browser-supplied session string as authentication. |

ParkSight currently accepts caller-supplied session IDs and returns hold-session data in public stall queries. That is not sufficient authorization for private trip URLs or phone sharing. Add identity and ownership checks before private trip persistence. Protect calibration mutations with an admin role before public deployment. Keep worker ingestion authenticated and separate from user actions.

## Product corrections before the demo

1. **An app hold is not a reservation of public street parking.** The current hold table coordinates ParkSight users only. Change “Held for you” to an explicitly app-only recommendation window, and never sell an extension as control of a public curb space.
2. **Freshness is evidence, not certainty.** Ingest time and source-frame time are different when a live stream is delayed. Replay must stay visibly labeled and must not enter live navigation recommendations.
3. **Rules need evidence.** Cite the exact official page/dataset and its date. Camera occupancy alone does not establish that a space is legal for this driver at arrival.
4. **Place names need resolution.** The current assistant ranks supplied coordinates and candidates; add confirmed destination coordinates rather than pretending that every spoken landmark has already been geocoded.
5. **Preserve provider truth.** Browser speech recognition and speech synthesis fallbacks need visible labels. Vortex's successful Cartesia tests do not establish that ParkSight's deployed voice path is integrated.

## Integration milestones and suggested owners

Use relative timeboxes; this does not change the team's previously supplied deadline.

| Milestone | Suggested owner | Concrete gate |
|---|---|---|
| Baseline, first 30-45 minutes | Nathan + Andrew | Run one calibrated camera through Convex to the map. Establish which feed is live; preserve a labeled replay backup. |
| Voice verification/hardening, next 60-90 minutes | Josh | Phone/browser recording -> real Cartesia transcript -> existing parking action -> bounded spoken response. Cancellation produces no late selection. |
| Trip dashboard | Josh + Andrew | Save destination, selected links and checkpoint; reload and recover the same owner-scoped trip. No Electron requirement. |
| Phone continuity | Andrew | Explicitly paired phone opens the previewed brief; another identity cannot read it; stale observations cannot masquerade as current availability. |
| Rules and agent evidence | Nova + Nathan | One cited rule lookup and one authenticated agent request use the same parking path. Sponsor claims require actual live runs. |
| Optional browser importer | Josh | User-selected tabs appear as trip resources with real provenance; unrelated tabs stay local. Native focus stays optional. |

If time is short, complete the camera -> voice -> suggestion journey, then add the trip dashboard. Do not block that journey on desktop installation, general OS control or every sponsor integration.

## Sponsor implications
 
The original selected sponsors were Meta, Elastic, Spacetime, Cartesia, Apify and Fetch.ai. ParkSight currently uses Convex and an Anthropic assistant, so the pivot changes the integration plan.

- Cartesia: verify the STT port already present in ParkSight; preserve/verify TTS.
- Elastic/Apify: cited rule retrieval/extraction is a plausible implementation role, pending live evidence.
- Fetch.ai: implement the actual verified ACP/ASI:One journey; existing boundary code is not a completed agent deployment.
- Meta: the existing Claude/Gemini code does not constitute a Meta integration. If Meta remains mandatory, add a real Llama role such as a grounded trip/rules briefing after agreeing provider consent and available access.
- SpacetimeDB: Convex is not a Spacetime integration. If Spacetime remains mandatory, a narrowly scoped phone-delivery/read-progress channel is a possible role, while Convex alone remains authoritative for parking state. This adds integration cost and should be a deliberate later milestone.

Recommendation: first deliver one coherent parking product. Preserve the original sponsor requirements as outstanding work until the team explicitly changes them; do not silently mark all six tracks as covered. Eligibility/rules were not verified in this source review.

## Proposed demo

“I was planning an evening out across several tabs. I save a trip, ask for parking, see the camera evidence and its age, and take the selected route, rules and next step to my phone.”

This preserves Vortex's continuity idea and gives it a specific user need. My judgment: that is a more coherent pivot than presenting a parking finder and a generic tab manager as separate main features. Its strongest proof is a real, correctly labeled parking observation and a real phone handoff; the dashboard alone will not supply that proof.

## Source references

- [ParkSight README](https://github.com/nathanleung0/parksight/blob/main/README.md)
- [Existing merge plan](https://github.com/nathanleung0/parksight/blob/main/docs/MERGE_PLAN.md)
- [Driver screen](https://github.com/nathanleung0/parksight/blob/main/src/DriverView.tsx)
- [Current voice UI](https://github.com/nathanleung0/parksight/blob/main/src/VoiceAsk.tsx)
- [Assistant and TTS](https://github.com/nathanleung0/parksight/blob/main/convex/assistant.ts)
- [Parking candidate/hold logic](https://github.com/nathanleung0/parksight/blob/main/convex/parking.ts)
- [Occupancy voting](https://github.com/nathanleung0/parksight/blob/main/convex/ingest.ts)
- [Schema](https://github.com/nathanleung0/parksight/blob/main/convex/schema.ts)
- [Vortex desktop and voice status](https://github.com/JoshSunJ/vortex/blob/main/apps/desktop/README.md)
