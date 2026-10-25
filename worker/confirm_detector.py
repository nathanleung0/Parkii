"""One fresh confirmation after a failed pilot, calibrated ONLY on pilot validation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from compare_detectors import PROFILES, run_profile
from detection_metrics import aggregate, image_counts, paired_f1_interval


def main(args):
    pilot=Path(args.pilot)
    old=json.loads((Path(args.validation)/"manifest.json").read_text(encoding="utf-8"))
    ground={row["frame"]:row for row in old["images"] if row["split"]=="validation"}
    predictions=json.loads((pilot/"validation-rfdetr-small.json").read_text(encoding="utf-8"))
    if set(ground)!={row["frame"] for row in predictions}:
        raise ValueError("Missing pilot validation predictions")
    sweep=[]
    for threshold in (.25,.35,.45,.55,.65,.75):
        counts=[image_counts([b for b in row["boxes"] if b[4]>=threshold],
                            ground[row["frame"]]["boxes"],ground[row["frame"]].get("crowd",[]))
                for row in predictions]
        sweep.append({"threshold":threshold,"metrics":aggregate(counts)})
    chosen=max(sweep,key=lambda row:(row["metrics"]["f1"],row["threshold"]))
    output=Path(args.output).resolve()
    for source in (Path(args.validation).resolve(),Path(args.dataset).resolve(),pilot.resolve()):
        if output==source or source in output.parents:
            raise ValueError("Confirmation output must be separate from frozen inputs and pilot")
    output.mkdir(parents=True,exist_ok=True)
    frozen={"created_at":datetime.now(timezone.utc).isoformat(),"threshold":chosen["threshold"],
            "rule":"six fixed thresholds; highest pilot validation F1, higher threshold for exact tie",
            "sweep":sweep,"pilot_validation_predictions_sha256":hashlib.sha256((pilot/"validation-rfdetr-small.json").read_bytes()).hexdigest(),
            "note":"Pilot test failed overall F1. Its images are excluded from confirmation; no test-based threshold tuning."}
    (output/"selection.json").write_text(json.dumps(frozen,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"frozen_threshold":chosen["threshold"]}),flush=True)
    root=Path(args.dataset).resolve()
    manifest_path=root/"manifest.json"
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    old_ids={row["image_id"] for row in old["images"]}
    new_ids=[row["image_id"] for row in manifest["images"]]
    if old_ids.intersection(new_ids) or len(set(new_ids))!=len(new_ids) or any(row["split"]!="test" for row in manifest["images"]):
        raise ValueError("Confirmation must use unique, entirely fresh test images")
    if not old_ids.issubset(set(manifest["excluded_image_ids"])):
        raise ValueError("Confirmation manifest must explicitly exclude all pilot images")
    for row in manifest["images"]:
        path=(root/"frames"/row["frame"]).resolve()
        if root/"frames" not in path.parents:
            raise ValueError("Image escaped frozen frame directory")
    PROFILES["rfdetr-small-calibrated"]={"model":"rfdetr-small","imgsz":512,"conf":chosen["threshold"]}
    report={"schema_version":1,"dataset":manifest["dataset"],"created_at":frozen["created_at"],
            "task":"pooled vehicle-family detection at IoU >= 0.5",
            "dataset_manifest_sha256":hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "scope":"one fresh confirmation, not Castro parking-availability accuracy",
            "pilot_report_sha256":hashlib.sha256((pilot/"report.json").read_bytes()).hexdigest(),
            "calibration":frozen,"test":[]}
    outputs={}
    for name in ("baseline-yolo11s","rfdetr-small-calibrated"):
        entry,rows=run_profile(name,"test",manifest,root,output)
        report["test"].append(entry)
        outputs[name]=rows
        (output/"report.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    baseline,candidate=[row["metrics"] for row in report["test"]]
    report["improvement"]={"f1_pp":100*(candidate["f1"]-baseline["f1"]),
        "recall_pp":100*(candidate["recall"]-baseline["recall"]),
        "precision_pp":100*(candidate["precision"]-baseline["precision"]),
        "miss_reduction_fraction":(baseline["fn"]-candidate["fn"])/baseline["fn"] if baseline["fn"] else None,
        "f1_difference_interval":paired_f1_interval(outputs["baseline-yolo11s"],outputs["rfdetr-small-calibrated"])}
    (output/"report.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report["improvement"]),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pilot",default="worker/benchmarks/vehicle-evaluation")
    parser.add_argument("--validation",default="worker/recordings/coco-vehicles")
    parser.add_argument("--dataset",default="worker/recordings/coco-confirmation")
    parser.add_argument("--output",default="worker/benchmarks/vehicle-confirmation")
    main(parser.parse_args())
