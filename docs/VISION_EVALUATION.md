# How to improve parking occupancy accuracy

Parkii's parking decision has two different parts:

1. **Where parking is possible.** An operator confirms the legal curb space and records its image region and map position. A generic vehicle model cannot determine parking rules, hydrants, driveways, or camera movement from a single frame. NYC camera annotations start as unverified review notes and cannot produce parking recommendations.
2. **Whether that space looks occupied now.** The parking worker detects vehicle candidates. Convex checks their ground footprints against a calibrated region. Weak or contradictory evidence returns `unknown`, which is excluded from search. Dashed object labels can be displayed for inspection; the calibrated stall outlines stay in the operator view.

## Current conservative rule

`worker/poll.py` uses YOLO11s on configured parking cameras. The worker sends vehicle class and model score with each box. `convex/occupancy.ts` requires at least 0.65 model score and 40% footprint overlap to count occupied evidence; a weaker overlapping candidate makes the result unknown. A space needs three consistent observations before becoming open or taken. These are initial operating thresholds, **not measured accuracy guarantees**. They trade some availability and about two additional polling intervals of decision latency for fewer premature open/taken claims.

## Evaluate before replacing the detector

1. Record real frames with `python worker/poll.py --record recordings --dry-run` across the configured cameras, day and night, and different weather and traffic conditions. Keep recorded frames out of Git and follow the feed operator's retention rules.
2. For each sampled frame, label every calibrated stall `open`, `occupied`, or `uncertain/occluded`. Keep camera and time together so repeated near-identical frames do not inflate the test set.
3. Replay the same frames through the current `yolo11s.pt` baseline and a candidate segmentation model such as `yolo26s-seg.pt` using `--model` and `--debug`. The current worker reads only the candidate model's bounding boxes; using segmentation masks for occupancy requires an additional code change. Compare final **per-stall** decisions, not just how many cars each model draws. Measure false-open rate first, then false-taken rate, unknown rate, and end-to-end CPU/GPU latency per camera. Evaluate a held-out day or camera separately.
4. Consider masks or tracked detections only if they improve those stall-level metrics. Segmentation can describe the vehicle footprint more precisely than a rectangle, but it still cannot infer that a curb is legal parking. Tracking can help reject passing cars, but only after it is tested on these fixed views.

Training a custom model is **not required to get started**. Fixed-view calibrated spaces plus a pretrained detector and an `unknown` state are a practical first pass. Fine-tune only after labeled Parkii frames show recurring errors that threshold, overlap, camera selection, or a better pretrained model cannot solve. Public parking datasets such as [CNRPark+EXT](https://cnrpark.it/) and [PKLot](https://www.sciencedirect.com/science/article/pii/S0957417415001086) are useful for methods and pretraining, but they do not validate Parkii's camera angles or parking rules. The [Ultralytics segmentation guide](https://docs.ultralytics.com/tasks/segment) documents the candidate model and generic benchmarks; its COCO numbers are not Parkii occupancy accuracy. Check the [Ultralytics license](https://www.ultralytics.com/license) before commercial use.
