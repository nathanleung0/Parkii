"""Choose on validation images, then compare baseline/winner on held-out human COCO labels."""
import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import gc
import hashlib
import json
from pathlib import Path
import statistics
import time

from detection_metrics import aggregate, image_counts, paired_f1_interval
from vision import VehicleDetector, VisionConfig

PROFILES = {
    "baseline-yolo11s": dict(model="yolo11s.pt",imgsz=1280),
    "yolo26m": dict(model="yolo26m.pt",imgsz=1280),
    "yolo26s-tiled": dict(model="yolo26s.pt",imgsz=1280,tile_size=320),
    "yolo26m-seg": dict(model="yolo26m-seg.pt",imgsz=1280),
    "rfdetr-small": dict(model="rfdetr-small",imgsz=512),
}


def detector_for(config):
    if config.model == "rfdetr-small":
        from rf_detector import RFDETRDetector
        return RFDETRDetector(config)
    return VehicleDetector(config)


def run_profile(name,split,manifest,root,output):
    import cv2
    rows=[row for row in manifest["images"] if row["split"]==split]
    if not rows:
        raise ValueError("Requested split has no images")
    config=VisionConfig(**{"device":"cpu","conf":.25,**PROFILES[name]})
    detector=detector_for(config)
    first=cv2.imread(str(root/"frames"/rows[0]["frame"]))
    for _ in range(2):
        detector.detect(first)
    detector.torch.set_num_threads(4)
    detector.detect(first)
    detector.synchronize()
    predictions=[]
    target=output/(split+"-"+name+".json")
    for index,row in enumerate(rows):
        path=root/"frames"/row["frame"]
        if hashlib.sha256(path.read_bytes()).hexdigest()!=row["sha256"]:
            raise ValueError("Evaluation image changed after dataset preparation")
        image=cv2.imread(str(path))
        if image is None:
            raise ValueError("Unreadable evaluation image")
        detector.synchronize()
        start=time.perf_counter()
        boxes=detector.detect(image)
        detector.synchronize()
        elapsed=1000*(time.perf_counter()-start)
        counts=image_counts(boxes,row["boxes"],row.get("crowd",[]))
        predictions.append({"frame":row["frame"],"boxes":boxes,"latency_ms":elapsed,**counts})
        target.write_text(json.dumps(predictions,indent=2)+"\n")
        if (index+1)%4==0 or index+1==len(rows):
            print(f"{split} {name}: {index+1}/{len(rows)}",flush=True)
    latency=sorted(p["latency_ms"] for p in predictions)
    runtime=detector.describe()
    result={"profile":name,"split":split,"config":asdict(config),"runtime":runtime,
            "metrics":aggregate(predictions),"latency_ms":{"median":statistics.median(latency),
            "p95":latency[__import__('math').ceil(.95*len(latency))-1]},"predictions_file":target.name}
    print(json.dumps({k:result[k] for k in ('profile','split','metrics','latency_ms')}),flush=True)
    del detector
    gc.collect()
    return result,predictions


def select_winner(results):
    usable=[r for r in results if r["metrics"]["f1"] is not None]
    if not usable:
        raise ValueError("No scored validation results")
    return max(usable,key=lambda r:(r["metrics"]["f1"],-r["latency_ms"]["median"]))["profile"]


def main(args):
    root=Path(args.dataset).resolve()
    manifest_path=root/"manifest.json"
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    seen=set()
    for row in manifest["images"]:
        path=(root/"frames"/row["frame"]).resolve()
        if root/"frames" not in path.parents or row["frame"] in seen:
            raise ValueError("Evaluation frames must be unique and stay inside frames/")
        if row["split"] not in ("validation","test"):
            raise ValueError("Unexpected evaluation split")
        seen.add(row["frame"])
    output=Path(args.output).resolve()
    if output==root or root in output.parents:
        raise ValueError("Keep outputs outside the frozen image dataset")
    output.mkdir(parents=True,exist_ok=True)
    report={"schema_version":1,"created_at":datetime.now(timezone.utc).isoformat(),
            "dataset_manifest_sha256":hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "dataset":manifest["dataset"],"label_source":manifest["label_source"],
            "task":"pooled vehicle-family detection at IoU >= 0.5, confidence >= 0.25",
            "scope":"not Castro parking-availability accuracy; pretrained models and COCO validation subset",
            "selection_rule":"highest validation F1, lower median latency for an exact tie",
            "validation":[],"test":[]}
    for name in args.profiles:
        entry,_=run_profile(name,"validation",manifest,root,output)
        report["validation"].append(entry)
        (output/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    selected=select_winner(report["validation"])
    report["selected_profile"]=selected
    report["selection_frozen_before_test_at"]=datetime.now(timezone.utc).isoformat()
    (output/"selection.json").write_text(json.dumps({k:report[k] for k in ("selected_profile","selection_rule","selection_frozen_before_test_at","validation")},indent=2)+"\n")
    results={}
    for name in dict.fromkeys(["baseline-yolo11s",selected]):
        entry,rows=run_profile(name,"test",manifest,root,output)
        report["test"].append(entry)
        results[name]=rows
        (output/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    baseline=report["test"][0]["metrics"]
    candidate=report["test"][-1]["metrics"]
    report["improvement"]={"f1_pp":100*(candidate["f1"]-baseline["f1"]),
                            "recall_pp":100*(candidate["recall"]-baseline["recall"]),
                            "miss_reduction_fraction":(baseline["fn"]-candidate["fn"])/baseline["fn"] if baseline["fn"] else None,
                            "f1_difference_interval":paired_f1_interval(results["baseline-yolo11s"],results[selected])}
    (output/"report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps({"selected":selected,"improvement":report["improvement"]}),flush=True)
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset",default="worker/recordings/coco-vehicles")
    parser.add_argument("--output",default="worker/benchmarks/vehicle-evaluation")
    parser.add_argument("--profiles",nargs="+",choices=tuple(PROFILES),default=list(PROFILES))
    main(parser.parse_args())
