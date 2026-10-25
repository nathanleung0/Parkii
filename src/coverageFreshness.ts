import { withinRadius } from "../convex/geo";

type Coverage = { observedStalls: number; radiusM: number };
type StallObservation = { lat: number; lng: number; updatedAt: number; status: string };
type Tone = "checking" | "none" | "delayed" | "fresh";
type FreshCoverage = { tone: Tone; freshStalls: number; noResultMessage: string };

// Convex's cached query result does not advance with the browser clock. Recompute
// ages from existing observations on useNow ticks, without polling the backend.
export function deriveCoverageFreshness(
  coverage: Coverage | undefined,
  stalls: readonly StallObservation[] | undefined,
  location: readonly [number, number],
  now: number,
  staleMs: number,
): FreshCoverage {
  if (!coverage || !stalls) {
    return { tone: "checking", freshStalls: 0, noResultMessage: "Checking nearby camera coverage…" };
  }
  if (coverage.observedStalls === 0) {
    return {
      tone: "none", freshStalls: 0,
      noResultMessage: `No camera-observed parking within ${coverage.radiusM} m of this location yet.`,
    };
  }
  // listStallsNear covers the larger map radius and already excludes disabled
  // cameras. Only observations inside the actual search radius count here.
  const freshStalls = stalls.filter((stall) =>
    withinRadius(location[0], location[1], stall.lat, stall.lng, coverage.radiusM) &&
    stall.status !== "unknown" && Number.isFinite(stall.updatedAt) &&
    stall.updatedAt > 0 && now - stall.updatedAt < staleMs,
  ).length;
  return {
    tone: freshStalls > 0 ? "fresh" : "delayed",
    freshStalls,
    noResultMessage: freshStalls > 0
      ? "No nearby open spots with fresh camera data right now."
      : "Nearby camera data is stale. Try again later.",
  };
}
