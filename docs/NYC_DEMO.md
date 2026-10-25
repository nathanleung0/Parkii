# New York City camera demo

The default Find parking route (`#/`; `#/nyc` remains an alias) starts at 3rd Avenue and 76th Street. Moving the pin finds the eight closest online NYC DOT traffic cameras across the five boroughs. The selected view requests analysis; its processed image and moving dashed vehicle labels appear together. Find parking also queries the shared parking inventory near the pin. There are currently no calibrated NYC parking stalls, so it reports no monitored parking there. The SF parking pilot remains at `#/sf`. Internal parking polygons are displayed in SF calibration, not over the driver's footage.

NYC DOT describes these as traffic cameras, says they can be repositioned or go offline, and says developers should contact NYC DOT and sign a data-sharing agreement to access the camera feed. The operator must arrange the necessary access before enabling this integration on a deployment. See [NYC DOT data feeds](https://www.nyc.gov/html/dot/html/about/datafeeds.shtml) and [traffic camera information](https://www.nyc.gov/html/dot/html/motorist/atis.shtml).

## Enable the approved feed

On a deployment whose operator has arranged NYC DOT access:

```bash
npx convex env set NYC_DOT_FEED_ENABLED true
npx convex run nycCameras:refreshCatalog
```

`NYC_DOT_FEED_ENABLED` is an app switch controlling fetches and analysis. Setting it does not grant feed rights or parking permission. NYC DOT's published page says developers seeking the camera feed must contact the agency and sign a data-sharing agreement; the deployment operator is responsible for that arrangement.

The refresh action validates the public catalog, keeps only NYC coordinates and valid camera IDs, and retains the previous catalog if the fetch is bad or unexpectedly small. A Convex cron refreshes metadata every 12 hours while the flag is set. Without the flag, scheduled refreshes skip the feed. The catalog is stored in one Convex document; a pin query reads that document and returns eight camera records, not the full catalog.

Run `python worker/nyc_review.py` alongside the parking worker. The UI queues only recently selected cameras, and the server caps active analysis at four cameras. The worker checks for selections every five seconds, fetches each active image at most once every 30 seconds, runs YOLO on that image, and uploads the exact JPEG and normalized vehicle boxes together. Stale observations are hidden after 90 seconds. When no analysis is ready, the browser displays only the selected raw camera image. This avoids processing all ~973 NYC cameras and avoids drawing boxes on a different frame.

The catalog is separate from the parking camera registry. The NYC worker labels vehicles in a selected traffic image, but those labels are **not** parking occupancy and never go to `findSpot`. The Find parking button calls the existing parking selection path, which can return a NYC space only after a separate parking feed and stall are configured, calibrated, and observed recently. A NYC parking result therefore needs a view-by-view assessment of parking rules and camera stability, feed rights for that use, and fresh occupancy observations. The NYC interface points users to the SF pilot for current recommendations.

## Candidate review

The Calibrate navigation opens the NYC review at `#/calibrate` and preserves the camera selected on Find parking. SF pilot calibration remains at `#/calibrate/sf`. With the deployment's `CALIBRATION_SECRET` operator edit key, an operator can mark a possible NYC parking space on the image, locate it on the map, save it, and remove it after review. This key controls app edits; it is not a street parking permit. Orange shapes and map dots are **unverified notes**. The server checks the image coordinates and requires the map point to be within 250 m of the selected camera. Saved notes live in `nycReviewStalls`, separate from calibrated parking stalls, and are never shown as open parking or sent to `findSpot`.

Before turning a candidate into parking coverage, review posted regulations and the camera's stability across multiple times of day, confirm the feed can be processed for this purpose, then configure and calibrate a parking camera in the operator registry. See [coverage setup](COVERAGE.md) and [vision evaluation](VISION_EVALUATION.md).

If a selected image is unavailable, choose another nearby camera. If the catalog is missing, the page says so and keeps the map usable. The SF pilot shows the nearest configured SF camera when no camera is within the map radius, with its distance and a clear no-parking-coverage message.
