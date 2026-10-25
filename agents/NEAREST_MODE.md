# Nearest-spot parking mode (no language model)

Set these values in ignored `agents/.env`, then restart the existing demo host without changing its seed:

```dotenv
PARKSIGHT_CHAT_ONLY=0
PARKSIGHT_PARKING_MODE=nearest
```

The agent geocodes the request, calls the same public `parking:findSpot` mutation used by DriverView,
reads `parking:listCameras` for the selected public camera source, and then uses the existing rules/reply flow.
There is one Convex backend and one hold implementation. No Convex code or schema changes are required.
The reply visibly identifies **Nearest-spot mode (no language model)**. This path does not call
`assistant.askCore`, Claude, or the `/agent/find` action, and it never silently falls back to them.

The existing shared mutation enforces freshness, competing holds, one hold per session and the
three-minute expiration. Sessions keep the same `agent:` namespace used by `/agent/find`. These are
application-level coordination holds; they do not physically reserve a public parking space.

The client uses the deployment's public Functions API, documented in the
[Convex HTTP API](https://docs.convex.dev/http-api/). `CONVEX_URL` or `VITE_CONVEX_URL` can explicitly
select an HTTPS `.convex.cloud` deployment; otherwise the client derives the matching `.convex.cloud`
origin from `CONVEX_SITE_URL`. Private backend credentials and the user's message text are not forwarded
to the public mutation. Function names are fixed, redirects are rejected, responses are bounded and
validated, and mutations are never automatically retried.

The camera query is optional after a successful hold. If it fails or returns ambiguous camera names,
the agent still reports the held spot and directions; it does not create another hold.

During live verification, the original stored snapshot link returned 404 because `convex/ingest.ts`
deletes each previous frame when the next frame arrives. Nearest mode therefore generates fixed-host
YouTube camera and thumbnail links from a validated 11-character video ID, using the same thumbnail
source as `worker/sources.py`. The thumbnail is explicitly labeled **Camera thumbnail (may lag)**;
it is not claimed to be the exact frame used for occupancy detection. Backend retention or a stable
latest-frame HTTP endpoint would require the shared Convex owner's review and deployment.

`PARKSIGHT_PARKING_MODE=assistant` remains the default and retains the existing language-model-backed
route. Unknown mode values fail safely. `PARKSIGHT_CHAT_ONLY=1` still blocks all parking requests in
either mode. Convex and ASI:One plan/usage limits still apply; no subscription, billing setting or API
key has been changed. Optional Elastic or remote Rules providers may run if configured separately.
Nova's live test uses the local DataSF-only rules path, with remote/Elastic providers unconfigured.

## Verification

- All 77 offline tests pass on this branch, including eleven nearest-mode tests with a fake transport.
- Public cloud camera and stall queries respond with actual deployment data.
- A live direct diagnostic selected C5-2 and created an application hold. Only that temporary
  diagnostic session was released afterward.
- ASI:One returned a genuine no-available-spot response, then a live C5-2 reply with the three-minute
  application hold, distance, observed age/confidence, DataSF street-cleaning text and directions.
  A separate read confirmed one active C5-2 hold with 32 seconds remaining at that check.
- After replacing the perishable snapshot link, a second full ASI:One request selected C5-1 and
  returned the hold, distance, 4-second observed age, 67% confidence, DataSF cleaning text, directions,
  a clearly labeled camera thumbnail and the live-camera link.
- The Cam 5 thumbnail returned HTTP 200 with a JPEG signature and rendered the actual Castro Theatre
  street image in the browser. It may lag the detection frame; its label and this limitation are explicit.
- Claude, Cartesia, Apify and Elastic were not called by these nearest-mode selection tests.
  This is not evidence of an Anthropic integration or of remote Rules Agent delivery.

## Current public-camera API compatibility

When `youtubeId` is omitted from `parking:listCameras`, known Castro cameras use
the fixed official camera-directory link, labeled **Camera feeds**. The private
source URL is not requested. Unknown or ambiguous cameras omit optional links;
a link lookup never retries or replaces the successful hold.
