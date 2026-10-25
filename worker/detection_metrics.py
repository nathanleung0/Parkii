"""Vehicle-family detection counts at fixed IoU; not a parking-availability metric."""
import math
import random
from refinement import iou


def image_counts(predictions, truth, crowd=(), threshold=.5):
    available = set(range(len(truth)))
    tp = fp = ignored = 0
    for prediction in sorted(predictions,key=lambda p:p[4],reverse=True):
        best = max(available,key=lambda i:iou(prediction,truth[i]),default=None)
        if best is not None and iou(prediction,truth[best]) >= threshold:
            available.remove(best)
            tp += 1
            continue
        area=max(0,prediction[2]-prediction[0])*max(0,prediction[3]-prediction[1])
        def crowd_overlap(region):
            intersection=max(0,min(prediction[2],region[2])-max(prediction[0],region[0]))*max(0,min(prediction[3],region[3])-max(prediction[1],region[1]))
            return intersection/area if area>0 else 0
        if any(crowd_overlap(region)>=threshold for region in crowd):
            ignored += 1
        else:
            fp += 1
    return {"tp":tp,"fp":fp,"fn":len(available),"ignored_crowd":ignored}


def aggregate(rows):
    totals={k:sum(row[k] for row in rows) for k in ("tp","fp","fn","ignored_crowd")}
    tp,fp,fn=(totals[k] for k in ("tp","fp","fn"))
    return {**totals,"images":len(rows),"precision":tp/(tp+fp) if tp+fp else None,
            "recall":tp/(tp+fn) if tp+fn else None,"f1":2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None,
            "false_positives_per_image":fp/len(rows) if rows else None}


def paired_f1_interval(baseline,candidate,iterations=2000,seed=20261024):
    if [r["frame"] for r in baseline] != [r["frame"] for r in candidate] or not baseline:
        raise ValueError("Paired comparison requires the identical ordered image list")
    rng=random.Random(seed)
    differences=[]
    for _ in range(iterations):
        indexes=[rng.randrange(len(baseline)) for _ in baseline]
        a=aggregate([baseline[i] for i in indexes])["f1"]
        b=aggregate([candidate[i] for i in indexes])["f1"]
        if a is not None and b is not None:
            differences.append(100*(b-a))
    differences.sort()
    if not differences:
        return None
    return {"low_pp":differences[math.floor(.025*(len(differences)-1))],
            "high_pp":differences[math.ceil(.975*(len(differences)-1))],
            "method":"paired image bootstrap, exploratory subset", "iterations":len(differences)}
