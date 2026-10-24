# ParkSight: camera occupancy and model recommendation

Prepared 25 October 2026. Source review and research, not a measured model benchmark.

User-confirmed constraints: manually mark a few spaces in fixed camera views; an NVIDIA GPU is available. Exact GPU model/VRAM and representative labeled footage are not yet available.

## Recommendation in plain language

Do not train a new vision model from scratch. For the next demo, compare a stronger pretrained vehicle detector against the current baseline, improve the space calibration and uncertainty handling, and collect a small labeled sample from the actual cameras.

For the longer-lived occupancy model, my recommended first training experiment is a pretrained **MobileNetV3-Large** fine-tuned on crops of the marked spaces. It answers “is this particular space occupied?” directly. Keep the detector for drawing/counting cars. A simple visibility/quality gate plus an uncertainty threshold should allow an **unknown** result; a hidden or unreadable space must not be advertised as empty.

This is an engineering recommendation for these fixed-space constraints. No candidate has yet demonstrated better accuracy on your cameras.

## What the source currently does

Reviewed `worker/poll.py`, `worker/sources.py`, `convex/geometry.ts`, `convex/ingest.ts`, `convex/seed.ts` and `worker/requirements.txt` on the public ParkSight main branch.

- The worker defaults to **yolo11s.pt**, a generic COCO vehicle detector. It filters car/motorcycle/bus/truck classes and uses image size 1280.
- The stream selection normally caps the source at 720p and falls back to a YouTube thumbnail.
- Parking spaces are manually drawn image-space polygons; Cam 2 and Cam 5 starter polygons are explicitly approximate in the seed.
- A car's “ground footprint” is approximated as the bottom **35% of its bounding box**. This is a heuristic, not a measured ground-plane footprint.
- A space becomes occupied when the maximum footprint-in-space overlap reaches **0.4**.
- The backend takes a majority vote over up to **3** readings and displays the fraction agreeing as `confidence`.

### The most consequential failure

A missed car detection is not evidence that the space is empty. Currently, if no vehicle overlaps a space, the reading becomes “not occupied.” A single first missed reading can yield `open` with `confidence=1`; repeated misses can also produce unanimous “open” votes.

That score describes agreement between recent heuristic decisions, not a calibrated probability that the parking space is free. A stronger detector alone will not repair this inference failure.

Other plausible failure sources include inaccurate polygons, small/distant vehicles, oblique viewing angles, shadows/night lighting, occlusions, passing traffic and stale/thumbnail frames. Their actual contribution needs to be measured on recorded examples.

## Candidate model experiments

| Candidate | Why test it | Training needed first? | Main limit |
|---|---|---|---|
| Current YOLO11s | Establish a repeatable baseline | No | Generic vehicle detection is only one stage of the occupancy decision. |
| **YOLO11m** | Low-disruption stronger-detector comparison in the current YOLO family | No | More compute; no guarantee of better space occupancy. |
| **YOLO26m** | Additional modern pretrained detector candidate if supported by the pinned test environment | No | Benchmark on the same frames; do not upgrade the live environment blindly. |
| YOLO11m-seg / YOLO26m-seg | Compare car masks with boxes for crowded/oblique scenes | No for pretrained inference | Requires a new output/association path. A visible-car mask is still not its true road footprint. |
| **MobileNetV3-Large occupancy classifier** | Directly classify each known parking-space crop | Yes: fine-tune a pretrained model on labeled crops | Needs representative local examples and explicit handling of occlusion/domain shift. |
| Meta SAM 3 | Optional mask-labeling assistance or comparison on difficult frames | Not necessarily for prompted inference | Official setup needs a compatible CUDA GPU and checkpoint access; it does not automatically infer parking legality or see hidden pavement. |

For a short deadline, test YOLO11m before taking on a new model family. For a trained parking-space model, start with MobileNetV3-Large; EfficientNet-B0 is another reasonable lightweight classifier candidate, not a proven winner here.

## What to change before spending time training

1. **Use a few genuinely visible, calibrated spaces.** Start with Cam 1 and redraw all tested polygons against a current frame. Exclude spaces where a human cannot reliably tell occupancy.
2. **Keep evidence distinct from decisions.** Store observed time, ingestion time, source kind, live/replay mode, image quality/visibility flags and model identity with each decision.
3. **Allow unknown after initialization.** Stale frames, obscured spaces, camera movement or low-quality images must not become empty merely because no box was found.
4. **Use asymmetric temporal confirmation.** Confirm empty conservatively across clean observations, while checking the trade-off against delay. Pick actual thresholds from validation data; an arbitrary vote count is not a probability.
5. **Test curb-region crops or sliced inference if cars are too small.** Map crop detections back to full-frame coordinates before occupancy matching. Slicing can make small objects larger at network input but cannot restore detail absent from the source image.
6. **Separate moving vehicles from space occupancy.** A sequence-aware model or tracking may help, but the current roughly five-second snapshots do not justify dropping in a tracker and assuming reliable trajectories.

## Training: what “fine-tune” means

A pretrained network has already learned useful visual features. We adapt its final classifier to your labels, then optionally update more layers. This is transfer learning, not learning vision from zero.

For the fixed-camera occupancy path:

```text
Frame -> calibrated space crop with appropriate context
      -> occupancy classifier
      -> visibility/uncertainty checks
      -> temporal decision: occupied / observed empty / unknown
```

Use the same crop geometry and preprocessing at training and inference. Do not crop away all the car context or include so much adjacent road that passing vehicles dominate the label.

### Data plan

- Start with a pilot annotation budget of **200-500 space crops** from the actual cameras. This is a starting experiment, not a promised sufficient dataset size.
- Include truly empty and occupied examples, different cars, nearby traffic, shadows, daytime/nighttime and occlusion. Label unreadable cases unknown or flag them for visibility evaluation.
- Do not collect only adjacent frames of the same parked car. Sample separated time blocks and varied conditions. Keep test frames out of annotation-assisted training loops.
- Split by time block/day, not random neighboring frames. If claiming generalization to new cameras, hold an entire camera out as a separate test.
- If this pilot fails on night or occlusion cases, gather more examples of those failures before switching architectures repeatedly.

Public parking datasets can help pretraining or initial experiments:

- **CNRPark+EXT:** labeled occupied/vacant parking-space patches, with roughly 150,000 examples according to its authors.
- **PKLot:** parking-lot images and labeled per-space examples from the dataset authors.

These are primarily parking-lot views. Do not assume that a model trained on them will transfer directly to Castro curbside views, stream compression or night conditions. Use actual camera examples for adaptation and evaluation. Verify dataset usage terms before incorporating downloads.

### Suggested order

1. Record a bounded representative clip using the existing `--record` option, with a verified worker environment and camera configuration.
2. Label a small evaluation set before any training. Show failures with their actual frames, polygons and predicted boxes.
3. Replay the identical frames through YOLO11s, YOLO11m and any additional candidate. Keep all other settings fixed for a fair detector comparison.
4. Compare region cropping/slicing separately, so an improvement is not incorrectly attributed to the model name.
5. Build/train the per-space classifier pilot from pretrained weights; test it against the same held-out occupancy labels.
6. Choose the measured winner. Keep the original baseline runnable and pin its environment, weights and settings.

## What to measure

The primary product error is **calling an occupied space empty**. Report it directly: among spaces offered as empty, how many were actually occupied?

Also report:

- Empty/occupied confusion matrix on held-out data.
- Coverage: how many usable spaces receive an answer versus unknown. An always-unknown system is not a useful success.
- Errors on passing-vehicle and occlusion examples.
- End-to-end update delay, including source age and temporal confirmation, rather than only GPU inference time.
- Median and slow-case inference latency and GPU memory on the actual hardware.

Do not select a winner solely from COCO mAP, a public parking-dataset headline accuracy, a few impressive frames or randomly split near-duplicate crops. No target accuracy or training duration is guaranteed by this plan.

## First implementation scope I recommend

One calibrated camera, a few visible marked spaces, a detector baseline plus one stronger detector comparison, an explicit unknown state and a labeled evaluation set. Then a fine-tuned occupancy classifier if the detector/geometry approach still makes too many false-empty suggestions.

Vehicle overlays and parking-space occupancy are related but separate tasks. No model here establishes legal parking, a guaranteed available spot or a physically reserved curb space.

## Sources

- [ParkSight worker](https://github.com/nathanleung0/parksight/blob/main/worker/poll.py)
- [Frame sources](https://github.com/nathanleung0/parksight/blob/main/worker/sources.py)
- [Footprint geometry](https://github.com/nathanleung0/parksight/blob/main/convex/geometry.ts)
- [Occupancy vote logic](https://github.com/nathanleung0/parksight/blob/main/convex/ingest.ts)
- [Ultralytics YOLO26 model documentation](https://docs.ultralytics.com/models/yolo26/)
- [SAHI sliced inference documentation](https://obss.github.io/sahi/guides/sliced-inference/)
- [Torchvision MobileNetV3](https://docs.pytorch.org/vision/stable/models/mobilenetv3.html)
- [PyTorch transfer-learning tutorial](https://docs.pytorch.org/tutorials/beginner/transfer_learning_tutorial.html)
- [CNRPark dataset and pretrained models](https://cnrpark.it/)
- [PKLot authors' dataset documentation](https://www.inf.ufpr.br/lesoliveira/download/pklot-readme.pdf)
- [Meta SAM 3 official repository and prerequisites](https://github.com/facebookresearch/sam3)
