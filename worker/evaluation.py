"""Offline single-frame parking metrics, matching convex/geometry.ts.

This is the existing box-strip heuristic, NOT a trained empty-space classifier.
The backend's three-reading majority vote is intentionally not simulated here.
"""


def polygon_area(poly):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1]))) / 2


def clip_polygon(poly, box):
    result = list(poly)
    for axis, boundary, direction in ((0, box[0], 1), (0, box[2], -1),
                                       (1, box[1], 1), (1, box[3], -1)):
        source, result = result, []
        for i, current in enumerate(source):
            previous = source[i - 1]
            cur_in = (current[axis] - boundary) * direction >= 0
            prev_in = (previous[axis] - boundary) * direction >= 0
            if cur_in != prev_in:
                t = (boundary - previous[axis]) / (current[axis] - previous[axis])
                result.append([previous[j] + t * (current[j] - previous[j]) for j in (0, 1)])
            if cur_in:
                result.append(current)
    return result


def occupancy(poly, vehicles):
    best = 0.0
    for x1, y1, x2, y2, *_ in vehicles:
        fy1 = y2 - 0.35 * (y2 - y1)
        area = (x2 - x1) * (y2 - fy1)
        if area > 0:
            best = max(best, polygon_area(clip_polygon(poly, [x1, fy1, x2, y2])) / area)
    return best


def score_stalls(stalls, vehicles, labels):
    rows = []
    for stall in stalls:
        expected = labels.get(stall["label"])
        if expected not in ("open", "taken"):
            continue  # occluded/unknown/unlabeled are not ground truth
        overlap = occupancy(stall["polygon"], vehicles)
        rows.append({"stall": stall["label"], "expected": expected,
                     "predicted": "taken" if overlap >= 0.4 else "open", "overlap": overlap})
    return rows


def summarize(rows):
    offered = [r for r in rows if r["predicted"] == "open"]
    false_open = sum(r["expected"] == "taken" for r in offered)
    return {"labeled_stall_frames": len(rows), "predicted_open": len(offered),
            "false_open": false_open,
            "false_open_rate_among_predicted_open": false_open / len(offered) if offered else None,
            "accuracy": sum(r["expected"] == r["predicted"] for r in rows) / len(rows) if rows else None}
