# Expanding camera coverage

Parkii reports camera-observed curb stalls within 600 m of a search point. A camera without calibrated legal stalls does not count as coverage. Searches outside the observed area return no coverage instead of routing a driver to Castro.

## Add a feed

1. Confirm that the feed operator permits automated processing and that the view shows legal curb parking. Traffic and speed-enforcement cameras generally do not provide useful curb visibility. Record the operator, permission, URL, coordinates, and expected source delay.
2. Create a JSON manifest. Keep a candidate disabled while its feed and permission are being checked:

```json
[
  {
    "camId": "mission-example-1",
    "name": "Mission example camera",
    "lat": 37.76,
    "lng": -122.42,
    "heading": 90,
    "sourceType": "jpeg",
    "sourceUrl": "https://camera-operator.example/live.jpg",
    "sourceAttribution": "Camera operator name",
    "enabled": false
  }
]
```

`sourceType` can be `jpeg` (JPEG, PNG, or WebP snapshot), `hls` (direct HTTPS playlist), or `youtube` (`youtubeId` instead of `sourceUrl`). The example URL is not a working camera; do not enable it. Never add a source solely because its video is publicly viewable.

3. Validate and import from the project root:

```bash
npm run cameras:import -- path/to/cameras.json --dry-run
npm run cameras:import -- path/to/cameras.json
```

4. After validating the real feed, re-import its camera with `enabled: true` and start the parking worker. A camera without a placed, calibrated stall is absent from parking search. Open `#/calibrate/sf` for the SF pilot, draw each legally usable stall polygon on the preview, and place it accurately on the map. The registry updates without resetting existing stall data. `#/calibrate` is the separate NYC candidate-review screen.
5. On an existing deployment, run `npx convex run seed:migrateSpatialIndex` until it reports `more: false`. New stalls receive their grid cell automatically.

## Operate more than one worker

Each worker owns a stable subset of cameras. For example, run three processes with `--shard-count 3` and `--shard-index 0`, `1`, and `2`. Each process has its own model; add shards when a cycle exceeds its configured interval. `--preview-interval 60` uploads an image once per minute per camera while detections continue each poll. For paid deployments, benchmark the actual decoding and inference rate before choosing the interval and shard count.

The default poll target is 15 seconds. At 100 cameras that is up to 576,000 frame fetches and inference passes per day, before retries; a five-second target would triple that. The worker skips inference on unchanged frames, but still fetches them. A new occupied/open result needs three consistent changed observations, adding at least two polling intervals to a new decision. Track source delay, fetch time, inference time, ingest time, and the fraction of searches with fresh coverage before increasing the camera count. Lower the polling rate or add shards only after measuring the impact on freshness and cost.

## What the public data currently provides

- [Castro Street Cams](https://sfbaytimes.com/castro-street-cam/) power the original proof of concept. Direct-feed permission still needs to be settled for a production service.
- [NYC DOT traffic cameras](https://webcams.nyctmc.org/api/cameras) (JPEG snapshots, `storeFrames: true`). NYC DOT approved use of the footage by phone for this hackathon project only; record the approval contact and date in the team's permissions file, and revisit before any use outside the hackathon. All 853 online NYC cameras are registered. 102 are enabled: they were judged to show curb parking at night and have a medium- or high-confidence heading estimate. The other 751 are disabled. Every heading and curb judgment came from night snapshots and needs a daytime check. No NYC stalls are calibrated yet, so NYC cameras add no driver coverage until a person draws their stalls at #/calibrate. Enabled cameras are polled only once the worker runs.
- [511 SF Bay traffic open data](https://511.org/open-data/traffic) publishes events, tolls, and work zones; it does not offer a citywide curb-facing video API. Its map cameras predominantly monitor roads, and each candidate needs a curb-visibility and rights review.
- [Caltrans District 4 CCTV](https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm) publishes a free HTTPS camera catalog for application integration. Parkii refreshes its SF subset every six hours and currently finds roughly 32 highway cameras in San Francisco. The SF pilot shows the eight closest as traffic snapshots, refreshing only the selected image once a minute. These cameras **never** enter parking search, calibration, or vehicle inference: highway traffic does not demonstrate a legal open curb space. A selected point may be several kilometers from the closest camera, particularly in western SF. A catalog count does not equal citywide parking coverage.
- [SFMTA speed safety cameras](https://www.sfmta.com/projects/speed-safety-cameras) are enforcement systems, not a public occupancy feed.
- [SFpark on-street sensors](https://www.sfmta.com/sites/default/files/reports-and-documents/2018/08/sfpark_pilot_overview.pdf) stopped providing live on-street availability after the pilot sensors reached end of life. Historical meter and occupancy data can support a separately labeled estimate, not a live camera claim.

The camera registry accepts authorized feeds in San Francisco or New York City. The separately refreshed NYC DOT catalog powers map previews and bounded review analysis; catalog entries do not automatically become parking inventory. Registry entries can be polled by the parking worker once enabled, but search still requires reviewed, placed stalls and fresh occupancy. See [NYC demo setup](NYC_DEMO.md). Neither catalog size nor a nearby traffic view proves usable or legal curb parking.

## Place search

The chat agent geocodes named SF destinations and caches repeated lookups in each process. The default public Nominatim endpoint is suitable only for a small prototype: its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) limits the whole application to one request per second and requires caching and attribution. Before running multiple agent processes or serving significant traffic, set `GEOCODER_URL` to a dedicated compatible geocoding service and observe that provider's terms. The map remains usable by clicking a destination without a geocoder request.
