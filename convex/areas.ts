import { inSfOrNyc } from "./geo";

export type ServiceArea = "nyc" | "sf";

export function serviceAreaFor(lat: number, lng: number): ServiceArea | null {
  return inSfOrNyc(lat, lng);
}
