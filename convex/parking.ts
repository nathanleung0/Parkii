import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { distanceMeters } from "./geometry";
import { cellFor, cellsAround, inSfOrNyc, MAP_RADIUS_M, SEARCH_RADIUS_M, withinRadius } from "./geo";
import type { Doc } from "./_generated/dataModel";

const HOLD_MS = 3 * 60 * 1000;
const FRESH_MS = 90 * 1000;

async function publicCamera(ctx: QueryCtx, camera: Doc<"cameras">) {
  return {
    _id: camera._id,
    camId: camera.camId,
    name: camera.name,
    lat: camera.lat,
    lng: camera.lng,
    heading: camera.heading,
    lastSeen: camera.lastSeen,
    vehicles: camera.vehicles,
    sourceAttribution: camera.sourceAttribution,
    storeFrames: camera.storeFrames !== false,
    frameUrl: camera.storeFrames !== false && camera.lastFrame ? await ctx.storage.getUrl(camera.lastFrame) : null,
  };
}

export const listCameras = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    return Promise.all(cams.map((camera) => publicCamera(ctx, camera)));
  },
});

// Unplaced stalls (placed === false) are excluded unless asked for: they must not appear in search or coverage.
async function nearbyStalls(ctx: QueryCtx, lat: number, lng: number, radiusM: number, includeUnplaced = false): Promise<Doc<"stalls">[]> {
  const batches = await Promise.all(
    cellsAround(lat, lng, radiusM).map((cell) =>
      ctx.db.query("stalls").withIndex("by_cell", (q) => q.eq("cell", cell)).collect(),
    ),
  );
  // Existing deployments can serve searches while the one-time backfill runs.
  const legacy = await ctx.db.query("stalls").withIndex("by_cell", (q) => q.eq("cell", undefined)).collect();
  return [...batches.flat(), ...legacy]
    .filter((s) => includeUnplaced || s.placed !== false)
    .filter((s) => withinRadius(lat, lng, s.lat, s.lng, radiusM));
}

async function activeNearbyStalls(ctx: QueryCtx, lat: number, lng: number, radiusM: number, includeUnplaced = false) {
  const stalls = await nearbyStalls(ctx, lat, lng, radiusM, includeUnplaced);
  const cameraIds = [...new Set(stalls.map((s) => s.cameraId))];
  const cameras = new Map(
    (await Promise.all(cameraIds.map((id) => ctx.db.get(id))))
      .filter((camera): camera is NonNullable<typeof camera> => camera !== null && camera.enabled !== false)
      .map((camera) => [camera._id, camera]),
  );
  return stalls.flatMap((stall) => {
    const camera = cameras.get(stall.cameraId);
    return camera ? [{ stall, camera }] : [];
  });
}

export const listCamerasNear = query({
  args: { lat: v.number(), lng: v.number() },
  handler: async (ctx, { lat, lng }) => {
    const pairs = await activeNearbyStalls(ctx, lat, lng, MAP_RADIUS_M);
    const cameras = new Map(pairs.map(({ camera }) => [camera._id, camera]));
    // Also list nearby cameras with no calibrated stalls yet, so their live view shows,
    // after the ones with stalls. The camera table is small enough to scan.
    const uncalibrated = (await ctx.db.query("cameras").collect())
      .filter((c) => c.enabled !== false && !cameras.has(c._id) && withinRadius(lat, lng, c.lat, c.lng, MAP_RADIUS_M))
      .sort((a, b) => distanceMeters(lat, lng, a.lat, a.lng) - distanceMeters(lat, lng, b.lat, b.lng));
    return Promise.all([...cameras.values(), ...uncalibrated].map((camera) => publicCamera(ctx, camera)));
  },
});

export const workerCameras = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cams = (await ctx.db.query("cameras").collect()).filter((c) => c.enabled !== false);
    return Promise.all(
      cams.map(async (c) => ({
        camId: c.camId,
        youtubeId: c.youtubeId,
        sourceType: c.sourceType ?? "youtube",
        sourceUrl: c.sourceUrl,
        storeFrames: c.storeFrames !== false,
        stalls: (
          await ctx.db
            .query("stalls")
            .withIndex("by_camera", (q) => q.eq("cameraId", c._id))
            .collect()
        ).map((s) => ({ label: s.label, polygon: s.polygon })),
      })),
    );
  },
});

export const listStalls = query({
  args: {},
  handler: async (ctx) => {
    const [stalls, holds] = await Promise.all([
      ctx.db.query("stalls").collect(),
      ctx.db.query("holds").collect(),
    ]);
    // Clients compare expiresAt against their own clock.
    return stalls.map((s) => {
      const h = holds.filter((h) => h.stallId === s._id);
      return {
        ...s,
        holds: h.map(({ expiresAt }) => ({ sessionId: "other", expiresAt })),
      };
    });
  },
});

export const listStallsNear = query({
  args: { lat: v.number(), lng: v.number(), sessionId: v.string() },
  handler: async (ctx, { lat, lng, sessionId }) => {
    // Includes unplaced stalls so the camera view can still outline them; the map only plots pinned ones.
    const pairs = await activeNearbyStalls(ctx, lat, lng, MAP_RADIUS_M, true);
    return Promise.all(pairs.map(async ({ stall }) => {
      const holds = await ctx.db.query("holds").withIndex("by_stall", (q) => q.eq("stallId", stall._id)).collect();
      return {
        ...stall,
        holds: holds.map((hold) => ({ sessionId: hold.sessionId === sessionId ? sessionId : "other", expiresAt: hold.expiresAt })),
      };
    }));
  },
});

async function coverageAt(ctx: QueryCtx, lat: number, lng: number) {
  const pairs = await activeNearbyStalls(ctx, lat, lng, SEARCH_RADIUS_M);
  const now = Date.now();
  return {
    observedStalls: pairs.length,
    freshStalls: pairs.filter(({ stall }) => stall.updatedAt > 0 && now - stall.updatedAt < FRESH_MS).length,
    radiusM: SEARCH_RADIUS_M,
  };
}

export const coverage = query({
  args: { lat: v.number(), lng: v.number() },
  handler: (ctx, { lat, lng }) => coverageAt(ctx, lat, lng),
});

export const agentCoverage = internalQuery({
  args: { lat: v.number(), lng: v.number() },
  handler: (ctx, { lat, lng }) => coverageAt(ctx, lat, lng),
});

// Fresh open stalls nobody else is holding, nearest first.
async function openCandidates(ctx: QueryCtx, lat: number, lng: number, sessionId: string) {
  const now = Date.now();
  const pairs = (await activeNearbyStalls(ctx, lat, lng, SEARCH_RADIUS_M))
    .filter(({ stall }) => stall.status === "open" && stall.updatedAt > 0 && now - stall.updatedAt < FRESH_MS);
  const available = await Promise.all(pairs.map(async ({ stall, camera }) => {
    const holds = await ctx.db.query("holds").withIndex("by_stall", (q) => q.eq("stallId", stall._id)).collect();
    if (holds.some((h) => h.expiresAt > now && h.sessionId !== sessionId)) return null;
    return {
      stallId: stall._id,
      label: stall.label,
      lat: stall.lat,
      lng: stall.lng,
      camera: camera.name,
      distanceM: Math.round(distanceMeters(lat, lng, stall.lat, stall.lng)),
      confidence: stall.confidence,
      ageS: Math.round((now - stall.updatedAt) / 1000),
    };
  }));
  return available.filter((candidate) => candidate !== null)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export type Candidate = Awaited<ReturnType<typeof openCandidates>>[number];

// Replace this session's hold with one on `c`.
async function hold(ctx: MutationCtx, c: Candidate, sessionId: string) {
  const mine = await ctx.db
    .query("holds")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const h of mine) await ctx.db.delete(h._id);
  const expiresAt = Date.now() + HOLD_MS;
  await ctx.db.insert("holds", { stallId: c.stallId, sessionId, expiresAt });
  return { ...c, expiresAt };
}

// Pick the nearest fresh open stall that nobody else is holding, and hold it.
export const findSpot = mutation({
  args: { lat: v.number(), lng: v.number(), sessionId: v.string() },
  handler: async (ctx, { lat, lng, sessionId }) => {
    const [best] = await openCandidates(ctx, lat, lng, sessionId);
    if (!best) {
      await releaseAll(ctx, sessionId);
      return null;
    }
    return hold(ctx, best, sessionId);
  },
});

// Used by the voice assistant (convex/assistant.ts).
export const candidates = internalQuery({
  args: { lat: v.number(), lng: v.number(), sessionId: v.string() },
  handler: (ctx, { lat, lng, sessionId }) => openCandidates(ctx, lat, lng, sessionId),
});

// Latest camera frame for a stall (public URL), used in agent replies.
export const stallFrameUrl = internalQuery({
  args: { stallId: v.id("stalls") },
  handler: async (ctx, { stallId }) => {
    const stall = await ctx.db.get(stallId);
    const cam = stall && (await ctx.db.get(stall.cameraId));
    return cam && cam.storeFrames !== false && cam.lastFrame ? await ctx.storage.getUrl(cam.lastFrame) : null;
  },
});

// The voice agent's "screenshot": a camera's latest frame plus what we think each stall is.
// `camera` matches a camera name or camId, case-insensitively, partial match allowed ("cam 1").
export const cameraSnapshot = internalQuery({
  args: { camera: v.string() },
  handler: async (ctx, { camera }) => {
    const q = camera.trim().toLowerCase();
    const cams = await ctx.db.query("cameras").collect();
    const cam =
      cams.find((c) => c.name.toLowerCase() === q || c.camId.toLowerCase() === q || c._id === camera) ??
      cams.find((c) => c.name.toLowerCase().includes(q) || c.camId.toLowerCase().includes(q));
    if (!cam) return { cameras: cams.map((c) => c.name), found: null };
    const now = Date.now();
    const stalls = await ctx.db
      .query("stalls")
      .withIndex("by_camera", (q) => q.eq("cameraId", cam._id))
      .collect();
    return {
      cameras: cams.map((c) => c.name),
      found: {
        cameraId: cam._id,
        name: cam.name,
        frame: cam.lastFrame ?? null,
        ageS: cam.lastSeen ? Math.round((now - cam.lastSeen) / 1000) : null,
        vehicles: cam.vehicles?.length ?? 0,
        stalls: stalls.map((s) => ({
          label: s.label,
          status: s.status,
          confidence: s.confidence,
          ageS: Math.round((now - s.updatedAt) / 1000),
        })),
      },
    };
  },
});

export const holdStall = internalMutation({
  args: { stallId: v.id("stalls"), lat: v.number(), lng: v.number(), sessionId: v.string() },
  handler: async (ctx, { stallId, lat, lng, sessionId }) => {
    // Re-check inside the transaction: the stall may have filled or been held since the query.
    const c = (await openCandidates(ctx, lat, lng, sessionId)).find((c) => c.stallId === stallId);
    return c ? hold(ctx, c, sessionId) : null;
  },
});

async function releaseAll(ctx: MutationCtx, sessionId: string) {
  const mine = await ctx.db
    .query("holds")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const h of mine) await ctx.db.delete(h._id);
}

export const releaseHold = mutation({
  args: { sessionId: v.string() },
  handler: (ctx, { sessionId }) => releaseAll(ctx, sessionId),
});

// Calibration
export const upsertStall = mutation({
  args: {
    id: v.optional(v.id("stalls")),
    cameraId: v.id("cameras"),
    label: v.string(),
    polygon: v.array(v.array(v.number())),
    lat: v.number(),
    lng: v.number(),
    placed: v.optional(v.boolean()), // default false: a stall is only on the map once pinned
  },
  handler: async (ctx, { id, placed, ...fields }) => {
    if (!fields.label.trim() || fields.polygon.length !== 4 ||
        fields.polygon.some((point) => point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) ||
        !inSfOrNyc(fields.lat, fields.lng)) {
      throw new Error("Invalid stall location or polygon");
    }
    const cell = cellFor(fields.lat, fields.lng);
    if (id) {
      await ctx.db.patch(id, { ...fields, placed: placed === true, cell, history: [], status: "unknown", updatedAt: 0, confidence: 0 });
      return id;
    }
    return ctx.db.insert("stalls", {
      ...fields,
      placed: placed === true,
      status: "unknown",
      confidence: 0,
      history: [],
      updatedAt: 0,
      cell,
    });
  },
});

export const deleteStall = mutation({
  args: { id: v.id("stalls") },
  handler: async (ctx, { id }) => {
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_stall", (q) => q.eq("stallId", id))
      .collect();
    for (const h of holds) await ctx.db.delete(h._id);
    await ctx.db.delete(id);
  },
});
