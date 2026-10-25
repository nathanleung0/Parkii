import { useEffect, useState } from "react";
import type { api } from "../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type Camera = FunctionReturnType<typeof api.parking.listCameras>[number];
export type Stall = FunctionReturnType<typeof api.parking.listStalls>[number];

export const CASTRO_CENTER: [number, number] = [37.7615, -122.435];
// Free OpenStreetMap vector basemap for MapLibre, no API key needed.
export const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
export const STALE_MS = 90_000;

// Re-render every `ms` so "updated Xs ago" and staleness stay current.
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function sessionId(): string {
  try {
    let id = sessionStorage.getItem("parksight-session");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("parksight-session", id);
    }
    return id;
  } catch {
    return "anon-" + Math.random().toString(36).slice(2);
  }
}

export type DisplayStatus = "open" | "taken" | "held" | "stale";

export function displayStatus(s: Stall, now: number, mySession: string): DisplayStatus {
  if (s.status === "unknown" || now - s.updatedAt > STALE_MS) return "stale";
  if (s.status === "taken") return "taken";
  const heldByOther = s.holds.some((h) => h.expiresAt > now && h.sessionId !== mySession);
  return heldByOther ? "held" : "open";
}

export const STATUS_COLOR: Record<DisplayStatus, string> = {
  open: "#16a34a",
  taken: "#dc2626",
  held: "#d97706",
  stale: "#9ca3af",
};

export function ago(ts: number | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}
