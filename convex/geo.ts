import { distanceMeters } from "./geometry";

// A coarse grid keeps live queries local without requiring a citywide table scan.
// Exact distance is always checked after the indexed lookup.
const CELL_DEGREES = 0.01;
export const SEARCH_RADIUS_M = 600;
export const MAP_RADIUS_M = 1600;

export function cellFor(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL_DEGREES)}:${Math.floor(lng / CELL_DEGREES)}`;
}

export function cellsAround(lat: number, lng: number, radiusM: number): string[] {
  const latDelta = radiusM / 111_320;
  const lngDelta = radiusM / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const cells: string[] = [];
  for (let y = Math.floor((lat - latDelta) / CELL_DEGREES); y <= Math.floor((lat + latDelta) / CELL_DEGREES); y++) {
    for (let x = Math.floor((lng - lngDelta) / CELL_DEGREES); x <= Math.floor((lng + lngDelta) / CELL_DEGREES); x++) {
      cells.push(`${y}:${x}`);
    }
  }
  return cells;
}

export function withinRadius(lat: number, lng: number, pointLat: number, pointLng: number, radiusM: number): boolean {
  return distanceMeters(lat, lng, pointLat, pointLng) <= radiusM;
}
