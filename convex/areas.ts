export type ServiceArea = "nyc" | "sf";

export function serviceAreaFor(lat: number, lng: number): ServiceArea | null {
  if (lat >= 40.47 && lat <= 40.93 && lng >= -74.27 && lng <= -73.68) return "nyc";
  if (lat >= 37.6 && lat <= 37.84 && lng >= -122.53 && lng <= -122.34) return "sf";
  return null;
}
