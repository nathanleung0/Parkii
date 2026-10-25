"""Compare YOLO models on the SAME saved frames without touching Convex.

python worker/benchmark.py --frames worker/recordings --models yolo11s.pt yolo26m.pt
"""
import argparse
from dataclasses import asdict
import json
from pathlib import Path
import statistics
import time

from evaluation import score_stalls, summarize
from vision import VehicleDetector, add_vision_args, config_from_args


def run(args):
    import cv2
    root = Path(args.frames).resolve()
    if not root.is_dir():
        raise ValueError(f"Frames directory does not exist: {root}")
    output = Path(args.output).resolve()
    if output == root or root in output.parents:
        raise ValueError("Output must be outside the frames directory (avoid benchmarking annotated output)")
    files = sorted(p for p in root.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    files = files[:args.limit] if args.limit else files
    if not files:
        raise ValueError(f"No JPEG/PNG frames found under {root}")
    cameras = {}
    if args.cameras:
        cameras = {c["camId"]: c for c in json.loads(Path(args.cameras).read_text())}
    labels = json.loads(Path(args.labels).read_text()) if args.labels else {}
    if labels and not cameras:
        raise ValueError("--labels requires --cameras (stall calibration)")
    if args.parking_roi and not cameras:
        raise ValueError("--parking-roi requires --cameras")
    output.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": 1, "frames": len(files), "models": [],
              "evaluation": "single-frame box-strip heuristic; no temporal smoothing",
              "accuracy_validated": False}
    for index, model in enumerate(args.models):
        config = config_from_args(args, model)
        detector = VehicleDetector(config)
        print(json.dumps(detector.describe()))
        timings, predictions, rows = [], [], []
        # Decode each frame immediately before use; do not retain a whole recording in RAM.
        for frame_index, path in enumerate(files):
            frame = cv2.imread(str(path))
            if frame is None:
                raise ValueError(f"Unreadable image: {path}")
            relative = path.relative_to(root).as_posix()
            cam_id = relative.split("/")[0] if "/" in relative else ""
            stalls = cameras.get(cam_id, {}).get("stalls", [])
            if frame_index == 0:
                for _ in range(args.warmup):
                    detector.detect(frame, stalls)
                detector.synchronize()
            detector.synchronize()
            start = time.perf_counter()
            boxes = detector.detect(frame, stalls)
            detector.synchronize()
            elapsed = (time.perf_counter() - start) * 1000
            timings.append(elapsed)
            scored = score_stalls(stalls, boxes, labels.get(relative, {}))
            rows.extend(scored)
            predictions.append({"frame": relative, "latency_ms": elapsed,
                                "vehicles": boxes, "stalls": scored})
            if args.annotate:
                h, w = frame.shape[:2]
                for x1, y1, x2, y2, confidence in boxes:
                    pt = (round(x1 * w), round(y1 * h))
                    cv2.rectangle(frame, pt, (round(x2 * w), round(y2 * h)), (0, 200, 255), 2)
                    cv2.putText(frame, f"{confidence:.2f}", pt, cv2.FONT_HERSHEY_SIMPLEX, .5, (0, 200, 255), 1)
                for stall in stalls:
                    import numpy as np
                    pts = np.array([[round(x * w), round(y * h)] for x, y in stall["polygon"]], np.int32)
                    cv2.polylines(frame, [pts], True, (80, 255, 80), 2)
                target = output / f"{index}-{Path(model).stem}" / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                if not cv2.imwrite(str(target), frame):
                    raise OSError(f"Could not write {target}")
        ordered = sorted(timings)
        import math
        entry = {"config": asdict(config), "runtime": detector.describe(),
                 "latency_ms": {"median": statistics.median(timings),
                                "p95": ordered[math.ceil(.95 * len(ordered)) - 1]},
                 "metrics": summarize(rows), "predictions": predictions}
        report["models"].append(entry)
        (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({k: entry[k] for k in ("config", "latency_ms", "metrics")}, indent=2))
        torch = detector.torch
        del detector
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    print(f"Saved {output / 'report.json'}")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", required=True, help="image folder, optionally containing camId subfolders")
    parser.add_argument("--models", nargs="+", default=["yolo11s.pt", "yolo26m.pt"])
    parser.add_argument("--cameras", help="saved JSON array from GET /cameras")
    parser.add_argument("--labels", help="JSON mapping relative image paths to {stallLabel: open|taken|unknown}")
    parser.add_argument("--output", default="worker/benchmarks/comparison")
    parser.add_argument("--annotate", action="store_true")
    parser.add_argument("--limit", type=int, help="first N sorted frames, identical for every model")
    parser.add_argument("--warmup", type=int, default=2)
    add_vision_args(parser, model=False)
    args = parser.parse_args()
    if (args.limit is not None and args.limit < 1) or args.warmup < 0:
        parser.error("limit must be positive and warmup must be nonnegative")
    try:
        run(args)
    except (ValueError, FileNotFoundError) as error:
        parser.exit(1, f"{error}\n")
