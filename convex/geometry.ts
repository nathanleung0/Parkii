// Pure geometry helpers shared by the occupancy logic.

export type Pt = [number, number];

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Sutherland–Hodgman clip of a polygon against an axis-aligned box.
export function clipToBox(poly: Pt[], x1: number, y1: number, x2: number, y2: number): Pt[] {
  const edges: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= x1, (a, b) => lerpX(a, b, x1)],
    [(p) => p[0] <= x2, (a, b) => lerpX(a, b, x2)],
    [(p) => p[1] >= y1, (a, b) => lerpY(a, b, y1)],
    [(p) => p[1] <= y2, (a, b) => lerpY(a, b, y2)],
  ];
  let out = poly;
  for (const [inside, intersect] of edges) {
    const input = out;
    out = [];
    if (input.length === 0) break;
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(intersect(prev, cur));
      }
    }
  }
  return out;
}

function lerpX(a: Pt, b: Pt, x: number): Pt {
  const t = (x - a[0]) / (b[0] - a[0]);
  return [x, a[1] + t * (b[1] - a[1])];
}

function lerpY(a: Pt, b: Pt, y: number): Pt {
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + t * (b[0] - a[0]), y];
}

// How much of a vehicle's ground footprint lies inside the stall (max over vehicles).
// The footprint is the bottom strip of the box, where the car touches the road.
// Using whole boxes misfires on oblique cameras: a car in the travel lane is
// tall in the image and its box overlaps curb stalls it isn't parked in.
export const FOOTPRINT_FRACTION = 0.35;

export function stallOccupancy(poly: Pt[], boxes: number[][]): number {
  let best = 0;
  for (const [x1, y1, x2, y2] of boxes) {
    const fy1 = y2 - FOOTPRINT_FRACTION * (y2 - y1);
    const fpArea = (x2 - x1) * (y2 - fy1);
    if (fpArea <= 0) continue;
    const inside = polygonArea(clipToBox(poly, x1, fy1, x2, y2)) / fpArea;
    if (inside > best) best = inside;
  }
  return best;
}

export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
