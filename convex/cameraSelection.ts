import { serviceAreaFor } from "./areas";
import { distanceMeters } from "./geometry";
import { MAP_RADIUS_M } from "./geo";

export function selectCameraViews<T extends { lat: number; lng: number; enabled?: boolean }>(
  cameras: T[], lat: number, lng: number,
): Array<T & { distanceM: number; nearby: boolean }> {
  const area = serviceAreaFor(lat, lng);
  if (!area) return [];
  const ranked = cameras
    .filter((camera) => camera.enabled !== false && serviceAreaFor(camera.lat, camera.lng) === area)
    .map((camera) => ({
      ...camera,
      distanceM: Math.round(distanceMeters(lat, lng, camera.lat, camera.lng)),
      nearby: false,
    }))
    .sort((a, b) => a.distanceM - b.distanceM);
  const nearby = ranked.filter((camera) => camera.distanceM <= MAP_RADIUS_M);
  return (nearby.length ? nearby.slice(0, 8) : ranked.slice(0, 1))
    .map((camera) => ({ ...camera, nearby: camera.distanceM <= MAP_RADIUS_M }));
}
