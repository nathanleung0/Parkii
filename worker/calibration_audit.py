"""Flag calibration geometry needing human review; never infer vacancy or mutate Convex."""
import argparse
import json
import math
from pathlib import Path


def audit(cameras):
    results = []
    for camera in cameras:
        for stall in camera.get("stalls", []):
            polygon = stall.get("polygon", [])
            valid = isinstance(polygon, list) and len(polygon) >= 3 and all(
                isinstance(p, (list, tuple)) and len(p) == 2 and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool)
                    and math.isfinite(v) and 0 <= v <= 1 for v in p) for p in polygon)
            warnings = []
            if not valid:
                warnings.append("invalid_polygon")
            else:
                area = abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(polygon, polygon[1:]+polygon[:1]))) / 2
                if area <= 1e-12:
                    warnings.append("degenerate_polygon")
                if any(x <= .001 or y <= .001 or x >= .999 or y >= .999 for x,y in polygon):
                    warnings.append("touches_frame_edge")
            results.append({"camera_id": camera["camId"], "stall": stall.get("label"),
                            "warnings": warnings, "visual_review_required": True})
    return {"scope": "geometry diagnostics only; no automatic parking labels or safety certification",
            "stalls": results, "total": len(results),
            "with_geometry_warnings": sum(bool(row["warnings"]) for row in results)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cameras", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = audit(json.loads(Path(args.cameras).read_text(encoding="utf-8")))
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(result, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("total", "with_geometry_warnings")}))
