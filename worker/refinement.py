"""Bounded tiled refinement and vehicle-family NMS in full-frame coordinates."""
import math


def iou(a, b):
    width = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    intersection = width * height
    union = max(0.0, a[2]-a[0])*max(0.0,a[3]-a[1]) + max(0.0,b[2]-b[0])*max(0.0,b[3]-b[1]) - intersection
    return intersection / union if union > 0 else 0.0


def tile_windows(shape, roi, size, overlap=.25, limit=16):
    h, w = shape[:2]
    left, top, right, bottom = roi
    if size < 64 or not 0 <= overlap < .9 or limit < 1:
        raise ValueError("Invalid tiling configuration")
    step = max(1, round(size * (1-overlap)))
    def starts(low, high):
        if high-low <= size:
            return [low]
        values = list(range(low, high-size+1, step))
        if values[-1] != high-size:
            values.append(high-size)
        return values
    windows = [(x,y,min(right,x+size),min(bottom,y+size))
               for y in starts(top,bottom) for x in starts(left,right)]
    windows = [p for p in windows if p != (0,0,w,h)]
    if len(windows) > limit:
        raise ValueError(f"Tiling requires {len(windows)} crops, above the configured limit {limit}")
    return windows


def complete_tile_boxes(boxes, confidences, crop, shape, border=2):
    """Reject objects clipped by an artificial crop edge; full-frame detections remain available."""
    h,w = shape[:2]
    left,top,right,bottom = crop
    kept, scores = [], []
    for box, score in zip(boxes,confidences):
        if len(box)!=4 or not all(math.isfinite(v) for v in (*box,score)):
            continue
        x1,y1,x2,y2 = box
        if ((left>0 and x1<=border) or (top>0 and y1<=border)
                or (right<w and x2>=right-left-border) or (bottom<h and y2>=bottom-top-border)):
            continue
        kept.append(box)
        scores.append(score)
    return kept,scores


def fuse_vehicle_boxes(rows, threshold=.55, max_detections=300, preserve_first=0):
    """Class-agnostic vehicle-family NMS; no averaging of distinct neighboring vehicles."""
    selected = list(rows[:preserve_first])
    pending = sorted(rows[preserve_first:],key=lambda r:r[4],reverse=True)
    for row in pending:
        if not any(iou(row,other)>threshold for other in selected):
            selected.append(row)
        if len(selected)>=max_detections:
            break
    return selected
