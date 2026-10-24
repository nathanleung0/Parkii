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

const HOLD_MS = 3 * 60 * 1000;
const FRESH_MS = 90 * 1000;

export const listCameras = query({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    return Promise.all(
      cams.map(async (c) => ({
        ...c,
        frameUrl: c.lastFrame ? await ctx.storage.getUrl(c.lastFrame) : null,
      })),
    );
  },
});

export const workerCameras = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cams = await ctx.db.query("cameras").collect();
    return Promise.all(
      cams.map(async (c) => ({
        camId: c.camId,
        youtubeId: c.youtubeId,
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
        holds: h.map(({ sessionId, expiresAt }) => ({ sessionId, expiresAt })),
      };
    });
  },
});

// Fresh open stalls nobody else is holding, nearest first.
async function openCandidates(ctx: QueryCtx, lat: number, lng: number, sessionId: string) {
  const now = Date.now();
  const holds = await ctx.db.query("holds").collect();
  const heldByOthers = new Set(
    holds.filter((h) => h.expiresAt > now && h.sessionId !== sessionId).map((h) => h.stallId),
  );
  const cams = new Map((await ctx.db.query("cameras").collect()).map((c) => [c._id, c.name]));
  return (await ctx.db.query("stalls").collect())
    .filter((s) => s.status === "open" && now - s.updatedAt < FRESH_MS)
    .filter((s) => !heldByOthers.has(s._id))
    .map((s) => ({
      stallId: s._id,
      label: s.label,
      lat: s.lat,
      lng: s.lng,
      camera: cams.get(s.cameraId) ?? "",
      distanceM: Math.round(distanceMeters(lat, lng, s.lat, s.lng)),
      confidence: s.confidence,
      ageS: Math.round((now - s.updatedAt) / 1000),
    }))
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
  },
  handler: async (ctx, { id, ...fields }) => {
    if (id) {
      await ctx.db.patch(id, { ...fields, history: [] });
      return id;
    }
    return ctx.db.insert("stalls", {
      ...fields,
      status: "unknown",
      confidence: 0,
      history: [],
      updatedAt: 0,
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
