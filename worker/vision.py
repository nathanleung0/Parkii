"""Vehicle detection shared by the live worker and the offline comparison CLI.

The wire contract stays [x1, y1, x2, y2, confidence], normalized to the ORIGINAL
frame. No ML dependencies are imported until a detector is constructed.
"""
from dataclasses import dataclass
import hashlib
import math
import os
from pathlib import Path

from refinement import complete_tile_boxes, fuse_vehicle_boxes, tile_windows

ROOT = Path(__file__).resolve().parent
VEHICLE_CLASSES = [2, 3, 5, 7]  # COCO car, motorcycle, bus, truck
DEFAULT_MODEL = "yolo11s.pt"
DOWNLOADABLE_MODELS = {
    f"{family}{size}{task}.pt" for family in ("yolo11", "yolo26") for size in "nsmlx" for task in ("", "-seg")
}


@dataclass(frozen=True)
class VisionConfig:
    model: str = DEFAULT_MODEL
    imgsz: int = 1280
    conf: float = 0.25
    device: str = "auto"
    half: bool = False
    parking_roi: bool = False
    roi_margin: float = 0.15  # fraction of the FULL image on every side

    tile_size: int = 0
    tile_overlap: float = .25
    tile_limit: int = 16
    merge_iou: float = .55

    def __post_init__(self):
        if self.imgsz < 32 or self.imgsz % 32:
            raise ValueError("imgsz must be a positive multiple of 32")
        if not math.isfinite(self.conf) or not 0 < self.conf < 1:
            raise ValueError("conf must be between 0 and 1")
        if not math.isfinite(self.roi_margin) or not 0 <= self.roi_margin <= 1:
            raise ValueError("roi-margin must be between 0 and 1")
        if self.tile_size and (self.tile_size < 64 or self.tile_size % 32):
            raise ValueError("tile-size must be zero or a multiple of 32 at least 64")
        if not math.isfinite(self.tile_overlap) or not 0 <= self.tile_overlap < .9 or self.tile_limit < 1:
            raise ValueError("Invalid tile overlap or crop limit")
        if not math.isfinite(self.merge_iou) or not 0 < self.merge_iou < 1:
            raise ValueError("merge-iou must be between 0 and 1")
        if self.tile_size and self.parking_roi:
            raise ValueError("Use either parking-roi or tiled refinement, not both")
        if self.device not in ("auto", "cpu") and not self.device.isdigit():
            raise ValueError("device must be auto, cpu, or a CUDA index such as 0")


def parking_crop(shape, stalls, margin=0.15):
    """Union of marked stalls plus context; invalid/missing calibration uses full frame."""
    h, w = shape[:2]
    polygons = [s.get("polygon", []) for s in stalls]
    points = [p for poly in polygons for p in poly]
    valid = points and all(len(poly) >= 3 for poly in polygons) and all(
        len(p) == 2 and all(isinstance(v, (int, float)) and math.isfinite(v) and 0 <= v <= 1 for v in p)
        for p in points
    )
    if not valid:
        return 0, 0, w, h
    if any(abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1]))) < 1e-12 for poly in polygons):
        return 0, 0, w, h
    xs, ys = zip(*points)
    crop = (max(0, math.floor((min(xs) - margin) * w)),
            max(0, math.floor((min(ys) - margin) * h)),
            min(w, math.ceil((max(xs) + margin) * w)),
            min(h, math.ceil((max(ys) + margin) * h)))
    if crop[2] <= crop[0] or crop[3] <= crop[1]:
        return 0, 0, w, h
    return crop


def normalize_boxes(boxes, confidences, crop, shape):
    """Translate crop pixels to full-frame normalized boxes, clamp, drop invalid boxes."""
    h, w = shape[:2]
    left, top, right, bottom = crop
    out = []
    for box, confidence in zip(boxes, confidences):
        if len(box) != 4 or not all(math.isfinite(v) for v in (*box, confidence)):
            continue
        x1, y1, x2, y2 = box
        x1, x2 = (min(right, max(left, x + left)) / w for x in (x1, x2))
        y1, y2 = (min(bottom, max(top, y + top)) / h for y in (y1, y2))
        row = [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4), round(confidence, 3)]
        if row[2] > row[0] and row[3] > row[1] and 0 <= confidence <= 1:
            out.append(row)
    return out


def resolve_device(requested, torch):
    available = torch.cuda.is_available()
    if requested == "auto":
        return "0" if available else "cpu"
    if requested != "cpu" and (not available or int(requested) >= torch.cuda.device_count()):
        raise RuntimeError("Requested CUDA GPU is unavailable. Install CUDA PyTorch or explicitly use --device cpu.")
    return requested


def add_vision_args(parser, *, model=True):
    if model:
        parser.add_argument("--model", default=DEFAULT_MODEL, help="official YOLO weights or rfdetr-small (requires --imgsz 512)")
    parser.add_argument("--imgsz", type=int, default=1280)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--device", default="auto", help="auto, cpu, or CUDA index (0)")
    parser.add_argument("--half", action="store_true", help="FP16 on CUDA only; opt in after comparison")
    parser.add_argument("--parking-roi", action="store_true", help="crop to marked stalls plus context (experimental)")
    parser.add_argument("--roi-margin", type=float, default=0.15)
    parser.add_argument("--tile-size", type=int, default=0, help="optional full-frame plus parking-region tile refinement")
    parser.add_argument("--tile-overlap", type=float, default=.25)
    parser.add_argument("--tile-limit", type=int, default=16, help="fail rather than exceed this crop budget")
    parser.add_argument("--merge-iou", type=float, default=.55)


def config_from_args(args, model=None):
    return VisionConfig(model=model or args.model, imgsz=args.imgsz, conf=args.conf,
                        device=args.device, half=args.half, parking_roi=args.parking_roi,
                        roi_margin=args.roi_margin, tile_size=getattr(args,"tile_size",0),
                        tile_overlap=getattr(args,"tile_overlap",.25), tile_limit=getattr(args,"tile_limit",16),
                        merge_iou=getattr(args,"merge_iou",.55))


class VehicleDetector:
    def __init__(self, config):
        self.config = config
        os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / ".cache" / "ultralytics"))
        os.environ.setdefault("YOLO_AUTOINSTALL", "false")
        import torch
        import torch._utils  # compatibility with checkpoint loading on newer torch releases
        from ultralytics import YOLO, __version__, settings
        settings.update({"sync": False})

        self.torch = torch
        self.ultralytics_version = __version__
        self.device = resolve_device(config.device, torch)
        if config.half and self.device == "cpu":
            raise ValueError("--half requires a CUDA GPU; remove --half for CPU inference")
        path = Path(config.model).expanduser()
        if not path.is_file():
            if path.name != config.model or config.model not in DOWNLOADABLE_MODELS:
                raise FileNotFoundError(f"Weights not found: {config.model}. Use official YOLO11/26 detection/segmentation weights or an existing trusted file.")
            path = ROOT / "models" / config.model
            path.parent.mkdir(parents=True, exist_ok=True)
        self.model = YOLO(str(path))
        with path.open("rb") as weights:
            self.weights_sha256 = hashlib.file_digest(weights, "sha256").hexdigest()

    def describe(self):
        return {"model": self.config.model, "device": self.device,
                "cpu_threads": self.torch.get_num_threads(),
                "gpu": None if self.device == "cpu" else self.torch.cuda.get_device_name(int(self.device)),
                "torch": self.torch.__version__, "half": self.config.half,
                "ultralytics": self.ultralytics_version, "weights_sha256": self.weights_sha256,
                "imgsz": self.config.imgsz, "conf": self.config.conf,
                "parking_roi": self.config.parking_roi, "roi_margin": self.config.roi_margin,
                "tile_size": self.config.tile_size, "tile_overlap": self.config.tile_overlap,
                "tile_limit": self.config.tile_limit, "merge_iou": self.config.merge_iou}

    def synchronize(self):
        if self.device != "cpu":
            self.torch.cuda.synchronize(int(self.device))

    def detect(self, frame, stalls=()):
        crop = parking_crop(frame.shape, stalls, self.config.roi_margin) if self.config.parking_roi else (0, 0, frame.shape[1], frame.shape[0])
        x1, y1, x2, y2 = crop
        result = self.model.predict(frame[y1:y2, x1:x2], classes=VEHICLE_CLASSES,
                                    conf=self.config.conf, imgsz=self.config.imgsz,
                                    device=self.device, half=self.config.half, verbose=False)[0]
        rows = normalize_boxes(result.boxes.xyxy.tolist(), result.boxes.conf.tolist(), crop, frame.shape)
        if not self.config.tile_size:
            return rows
        region = parking_crop(frame.shape, stalls, self.config.roi_margin) if stalls else (0,0,frame.shape[1],frame.shape[0])
        primary_count = len(rows)
        for tile in tile_windows(frame.shape, region, self.config.tile_size, self.config.tile_overlap, self.config.tile_limit):
            left,top,right,bottom = tile
            refined = self.model.predict(frame[top:bottom,left:right], classes=VEHICLE_CLASSES,
                                         conf=self.config.conf, imgsz=self.config.imgsz,
                                         device=self.device, half=self.config.half, verbose=False)[0]
            boxes, scores = complete_tile_boxes(refined.boxes.xyxy.tolist(), refined.boxes.conf.tolist(), tile, frame.shape)
            rows.extend(normalize_boxes(boxes,scores,tile,frame.shape))
        return fuse_vehicle_boxes(rows,self.config.merge_iou,preserve_first=primary_count)


def create_detector(config):
    """Select an explicit local adapter without changing the normalized ingest contract."""
    if config.model == "rfdetr-small":
        from rf_detector import RFDETRDetector
        return RFDETRDetector(config)
    return VehicleDetector(config)
