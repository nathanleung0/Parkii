import { stallOccupancy, type Pt } from "./geometry";

export type StallEvidence = "occupied" | "clear" | "uncertain";
export type StallState = {
  status: "open" | "taken" | "unknown";
  history: boolean[];
  confidence: number;
};

// These are conservative operating thresholds, not a claim that the model's
// confidence is calibrated. Tune them on labeled frames from each camera.
export const MIN_VEHICLE_CONFIDENCE = 0.65;
export const MIN_FOOTPRINT_OVERLAP = 0.4;
const REQUIRED_CONSISTENT_FRAMES = 3;
const VEHICLE_CLASSES = new Set([2, 3, 5, 7]);

export function classifyStallFrame(poly: Pt[], vehicles: number[][]): StallEvidence {
  let weakCandidate = false;
  for (const vehicle of vehicles) {
    const classId = vehicle[5];
    if (classId !== undefined && !VEHICLE_CLASSES.has(classId)) continue;
    const overlap = stallOccupancy(poly, [vehicle]);
    if (overlap < MIN_FOOTPRINT_OVERLAP) continue;
    const confidence = vehicle[4];
    if (Number.isFinite(confidence) && confidence >= MIN_VEHICLE_CONFIDENCE) return "occupied";
    weakCandidate = true;
  }
  return weakCandidate ? "uncertain" : "clear";
}

export function nextStallState(history: boolean[], evidence: StallEvidence): StallState {
  if (evidence === "uncertain") return { status: "unknown", history: [], confidence: 0 };
  const next = [...history, evidence === "occupied"].slice(-REQUIRED_CONSISTENT_FRAMES);
  if (next.length < REQUIRED_CONSISTENT_FRAMES) return { status: "unknown", history: next, confidence: 0 };
  if (next.every(Boolean)) return { status: "taken", history: next, confidence: 1 };
  if (next.every((value) => !value)) return { status: "open", history: next, confidence: 1 };
  return { status: "unknown", history: next, confidence: 0 };
}
