# YOLO26 vehicle detection

This feature replaces the worker's default YOLO11s weights with **pretrained
YOLO26m** and adds an offline comparison tool. It detects vehicles; Convex still
uses its existing bottom-of-box overlap and three-reading vote to estimate stall
occupancy. No frontend or Convex schema deployment is required.

**A missed car can still produce a false open stall. Newer weights alone do not
prove a space is empty.** Do not describe this as a trained parking classifier or
claim improved parking accuracy until measured against labeled camera footage.

## Install (Python 3.11–3.14, tested on 3.12)

From the repository root, on Windows with an NVIDIA GPU:

```powershell
python -m venv worker/.venv
worker/.venv/Scripts/python -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
worker/.venv/Scripts/python -m pip install -r worker/requirements.txt
worker/.venv/Scripts/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

The official CUDA 12.8 wheels need a compatible NVIDIA driver. This pins the
torch/torchvision pair and Ultralytics release; it is not a complete dependency
lock. On Linux use `worker/.venv/bin/python`. For CPU, use the official PyTorch
CPU index instead of `cu128`, then run with `--device cpu`. On macOS install the
same torch/torchvision versions from PyPI and use `--device cpu`; MPS is not
supported by this worker's device selector yet.

Weights download on first use into ignored `worker/models/`. Ultralytics settings
are local to ignored `worker/.cache/`. These commands run pretrained inference;
they do not train anything. Only load custom `.pt` weights from a trusted source.
Review the Ultralytics license before commercial distribution.

## Live worker

Keep the existing private worker `.env` / repository `.env.local` settings for
`CONVEX_SITE_URL` and `INGEST_SECRET`. Only one worker should write to a deployment.

```powershell
# Inspect one camera without writing to Convex (GET /cameras still required).
worker/.venv/Scripts/python worker/poll.py --device 0 --only castro-cam1 --once --debug --dry-run
# Live processing after checking the debug image:
worker/.venv/Scripts/python worker/poll.py --device 0 --only castro-cam1 --debug
# Explicit rollback to Nathan's previous detector:
worker/.venv/Scripts/python worker/poll.py --model yolo11s.pt --device 0
```

Defaults: `yolo26m.pt`, image size 1280, confidence threshold 0.25, FP32,
full-frame inference. `--device auto` chooses CUDA 0 if available, otherwise CPU,
and startup logs the actual device. An explicit `--device 0` fails if unavailable;
it never silently switches to CPU. `--half` opts into CUDA FP16 and fails on CPU.
For memory pressure, try `--imgsz 960` or `--model yolo26s.pt` and recompare results.
Inference errors do not send an empty detection to Convex.

`--parking-roi --roi-margin 0.15` crops to the union of calibrated stall polygons
plus context (15% of the original image on each side). This can give small cars
more input pixels, but can also truncate tall vehicles or lose context. It is
experimental and off by default. Missing/invalid calibration uses the whole
frame. Box coordinates always map back to the original frame, preserving the
existing `[x1, y1, x2, y2, confidence]` normalized ingest contract. Calibration
changes are used on the next camera cycle.

## Compare models on identical recordings

Record using the existing worker `--record worker/recordings`, or put saved
JPEG/PNG frames into `worker/recordings/<camId>/`. Then:

```powershell
worker/.venv/Scripts/python worker/benchmark.py --frames worker/recordings --models yolo11s.pt yolo11m.pt yolo26m.pt --device 0 --annotate
```

This command requires no backend or keys and never calls `/ingest`. It writes
ignored `worker/benchmarks/comparison/report.json` and optional annotated images.
Each model sees the same sorted files and settings; compare ROI/FP16/image-size
changes in separate output folders. Timing includes preprocessing, prediction
and conversion to normalized boxes, synchronizes CUDA, excludes file decoding
and annotation, and excludes two warm-up runs. It reports median/p95 latency,
model/device/settings, raw vehicle boxes and optional stall metrics. A small
sample is a smoke test, not a reliable latency benchmark. Exceptions fail the
comparison rather than recording failed inference as empty parking.

For stall metrics, save the JSON array from your deployment's `GET /cameras` to
an ignored local file such as `worker/recordings/cameras.json`. It contains
`camId` and `stalls: [{label, polygon}]` with normalized coordinates. Add a labels
file outside the image tree, e.g. `worker/benchmarks/labels.json`:

```json
{
  "castro-cam1/1700000000.jpg": {"C1-1": "taken", "C1-2": "open", "C1-3": "unknown"}
}
```

```powershell
worker/.venv/Scripts/python worker/benchmark.py --frames worker/recordings --cameras worker/recordings/cameras.json --labels worker/benchmarks/labels.json --device 0 --annotate --output worker/benchmarks/labeled
```

Only explicitly labeled `open`/`taken` stall-frames are scored; unknown/occluded
and unlabeled stalls are excluded. Metrics use the same 35% box-strip / 40%
overlap rule as `convex/geometry.ts`, **without** its temporal majority vote.
`false_open_rate_among_predicted_open` = occupied stall-frames predicted open /
all labeled stall-frames predicted open. No predicted-open samples means `null`,
not 0%. The report's `accuracy_validated: false` is deliberate: an automatic
report does not establish label quality, coverage, or held-out generalization.

Before promoting a model, label complete time blocks from each calibrated camera
(day/night, small/far vehicles, passing traffic and occlusion). Hold out different
time blocks rather than adjacent random frames. Compare false-open rate, misses
and latency on that held-out set. This tool does not introduce an unknown-state
gate; backend vote confidence remains agreement, not a calibrated probability.
It also does not fix thumbnail/replay freshness semantics. Those need a separate
review with Nathan before changing shared occupancy behavior.

## Checks and references

```powershell
python -m unittest discover -s worker -p test_vision.py -v
```

Fast tests need only Python and cover coordinate mapping, vehicle filtering,
GPU selection, configuration and parking metrics. GPU inference and a labeled
camera evaluation are separate checks; their measured status belongs in the PR.

- [Official YOLO26 models](https://docs.ultralytics.com/models/yolo26/)
- [Official PyTorch wheel/version pairs](https://pytorch.org/get-started/previous-versions/)
