"""Optional official RF-DETR Small adapter; emits the existing normalized box wire format."""
import hashlib
import os
from pathlib import Path

from vision import ROOT, normalize_boxes, resolve_device


class RFDETRDetector:
    def __init__(self, config):
        if config.imgsz != 512 or config.half or config.tile_size or config.parking_roi:
            raise ValueError("RF-DETR Small currently requires imgsz=512, FP32, and no ROI/tiles")
        os.environ.setdefault("RF_HOME", str(ROOT / "models"))
        os.environ.setdefault("HF_HOME", str(ROOT / ".cache" / "huggingface"))
        os.environ.setdefault("TORCH_HOME", str(ROOT / ".cache" / "torch"))
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        import torch
        from rfdetr import RFDETRSmall
        from importlib.metadata import version
        self.torch = torch
        self.config = config
        self.version = version("rfdetr")
        self.device = resolve_device(config.device, torch)
        device = "cpu" if self.device == "cpu" else "cuda:" + self.device
        self.model = RFDETRSmall(device=device)
        self.path = Path(os.environ["RF_HOME"]) / "rf-detr-small.pth"
        raw = self.path.read_bytes()
        if hashlib.md5(raw).hexdigest() != "fb37061c1af7bace359c91b723a8d5c1":
            raise ValueError("RF-DETR Small checkpoint does not match the official SDK registry")
        self.digest = hashlib.sha256(raw).hexdigest()
        if self.model.model.args.num_classes <= len(self.model.class_names):
            raise ValueError("Expected the official sparse-category COCO-pretrained detector")

    def detect(self, frame, stalls=()):
        from PIL import Image
        image = Image.fromarray(frame[:, :, ::-1])
        result = self.model.predict(image, threshold=self.config.conf, include_source_image=False)
        # The official COCO-pretrained checkpoint returns sparse category IDs 1..90.
        keep = [i for i, class_id in enumerate(result.class_id) if int(class_id) in (3, 4, 6, 8)]
        h, w = frame.shape[:2]
        return normalize_boxes(result.xyxy[keep].tolist(), result.confidence[keep].tolist(),
                               (0, 0, w, h), frame.shape)

    def synchronize(self):
        if self.device != "cpu":
            self.torch.cuda.synchronize(int(self.device))

    def describe(self):
        return {"framework": "rfdetr", "version": self.version, "weights": self.path.name,
                "weights_sha256": self.digest, "device": self.device,
                "official_registry_md5_verified": True,
                "torch": self.torch.__version__, "cpu_threads": self.torch.get_num_threads()}
