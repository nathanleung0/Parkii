"""Render identical captured frames with baseline/selected boxes, without cloud access."""
import argparse
import hashlib
import json
from pathlib import Path


def render(args):
    import cv2
    from PIL import Image, ImageDraw, ImageFont
    from compare_detectors import PROFILES, detector_for
    from vision import VisionConfig
    root = Path(args.capture).resolve()
    output = Path(args.output).resolve()
    if output == root or root in output.parents:
        raise ValueError("Keep annotated output outside raw camera capture")
    output.mkdir(parents=True, exist_ok=True)
    cameras = json.loads((root / "cameras.json").read_text(encoding="utf-8"))
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    # Deterministic latest captured frame per camera; never select for model success.
    latest = {}
    for row in sorted(manifest, key=lambda row: row["captured_at"]):
        latest[row["camera_id"]] = row
    report = {"scope": "qualitative detector comparison, no audited parking labels", "frames": []}
    by_camera = {c["camId"]: c for c in cameras}
    profiles = list(dict.fromkeys(["baseline-yolo11s", args.profile]))
    for profile in profiles:
        detector = detector_for(VisionConfig(**PROFILES[profile], device="cpu", conf=.25 if profile=="baseline-yolo11s" else args.conf))
        detector.torch.set_num_threads(4)
        for cam_id, row in sorted(latest.items()):
            path = root / "frames" / row["frame"]
            if root not in path.resolve().parents or hashlib.sha256(path.read_bytes()).hexdigest() != row["sha256"]:
                raise ValueError("Captured image changed or escaped capture directory")
            frame = cv2.imread(str(path))
            if frame is None:
                raise ValueError("Unreadable camera image")
            boxes = detector.detect(frame, by_camera[cam_id].get("stalls", []))
            image = Image.fromarray(frame[:, :, ::-1])
            w,h = image.size
            canvas = Image.new("RGB", (w,h+66), "#101923")
            canvas.paste(image,(0,66))
            draw = ImageDraw.Draw(canvas)
            try:
                font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 17)
            except OSError:
                font = ImageFont.load_default()
            draw.text((12,8), f"{cam_id} | {profile} conf={detector.config.conf} | {len(boxes)} vehicle boxes",font=font,fill="white")
            draw.text((12,34), "Orange: vehicle boxes. Cyan: existing calibration. Vacancy is NOT verified.",font=font,fill="white")
            for x1,y1,x2,y2,score in boxes:
                draw.rectangle((x1*w,y1*h+66,x2*w,y2*h+66),outline="#ffad33",width=2)
                draw.text((x1*w,y1*h+66),f"{score:.2f}",fill="#ffad33",font=font)
            for stall in by_camera[cam_id].get("stalls", []):
                points=[(x*w,y*h+66) for x,y in stall["polygon"]]
                draw.line(points+points[:1],fill="#27eded",width=2)
                draw.text(points[0],stall["label"],fill="#27eded",font=font)
            name=cam_id+"-"+profile+".jpg"
            canvas.save(output/name,quality=92)
            report["frames"].append({"camera_id":cam_id,"frame":row["frame"],"sha256":row["sha256"],
                                     "profile":profile,"boxes":boxes,"image":name})
        del detector
    (output/"report.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"comparisons":len(latest),"profiles":profiles}))


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture",default="worker/recordings/evaluation")
    parser.add_argument("--output",default="worker/benchmarks/camera-review")
    parser.add_argument("--profile",required=True)
    parser.add_argument("--conf",type=float,default=.25)
    render(parser.parse_args())
