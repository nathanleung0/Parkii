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
import { cellFor, cellsAround, MAP_RADIUS_M, SEARCH_RADIUS_M, withinRadius } from "./geo";
import type { Doc } from "./_generated/dataModel";

const HOLD_MS = 3 * 60 * 1000;
const FRESH_MS = 90 * 1000;

function requireCalibrationSecret(provided: string) {
  const expected = process.env.CALIBRATION_SECRET;
  if (!expected || provided !== expected) throw new Error("Calibration access denied");
}

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
    frameUrl: camera.lastFrame ? await ctx.storage.getUrl(camera.lastFrame) : null,
  };
}

export const listCameras = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    return Promise.all(cams.map((camera) => publicCamera(ctx, camera)));
  },
});

async function nearbyStalls(ctx: QueryCtx, lat: number, lng: number, radiusM: number): Promise<Doc<"stalls">[]> {
  const batches = await Promise.all(
    cellsAround(lat, lng, radiusM).map((cell) =>
      ctx.db.query("stalls").withIndex("by_cell", (q) => q.eq("cell", cell)).collect(),
    ),
  );
  // Existing deployments can serve searches while the one-time backfill runs.
  const legacy = await ctx.db.query("stalls").withIndex("by_cell", (q) => q.eq("cell", undefined)).collect();
  return [...batches.flat(), ...legacy].filter((s) => withinRadius(lat, lng, s.lat, s.lng, radiusM));
}

async function activeNearbyStalls(ctx: QueryCtx, lat: number, lng: number, radiusM: number) {
  const stalls = await nearbyStalls(ctx, lat, lng, radiusM);
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
    const cameras = [...new Map(pairs.map(({ camera }) => [camera._id, camera])).values()];
    return Promise.all(cameras.map((camera) => publicCamera(ctx, camera)));
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
    const pairs = await activeNearbyStalls(ctx, lat, lng, MAP_RADIUS_M);
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
    return cam?.lastFrame ? await ctx.storage.getUrl(cam.lastFrame) : null;
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
    adminSecret: v.string(),
    id: v.optional(v.id("stalls")),
    cameraId: v.id("cameras"),
    label: v.string(),
    polygon: v.array(v.array(v.number())),
    lat: v.number(),
    lng: v.number(),
  },
  handler: async (ctx, { adminSecret, id, ...fields }) => {
    requireCalibrationSecret(adminSecret);
    if (!fields.label.trim() || fields.polygon.length !== 4 ||
        fields.polygon.some((point) => point.length !== 2 || point.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) ||
        fields.lat < 37.6 || fields.lat > 37.84 || fields.lng < -122.53 || fields.lng > -122.34) {
      throw new Error("Invalid stall location or polygon");
    }
    const cell = cellFor(fields.lat, fields.lng);
    if (id) {
      await ctx.db.patch(id, { ...fields, cell, history: [], status: "unknown", updatedAt: 0, confidence: 0 });
      return id;
    }
    return ctx.db.insert("stalls", {
      ...fields,
      status: "unknown",
      confidence: 0,
      history: [],
      updatedAt: 0,
      cell,
    });
  },
});

export const deleteStall = mutation({
  args: { id: v.id("stalls"), adminSecret: v.string() },
  handler: async (ctx, { id, adminSecret }) => {
    requireCalibrationSecret(adminSecret);
    const holds = await ctx.db
      .query("holds")
      .withIndex("by_stall", (q) => q.eq("stallId", id))
      .collect();
    for (const h of holds) await ctx.db.delete(h._id);
    await ctx.db.delete(id);
  },
});
