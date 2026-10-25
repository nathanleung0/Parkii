import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { stallOccupancy, type Pt } from "./geometry";

// Fraction of a vehicle's ground footprint inside the stall. Tuned on Castro Cam 1:
// parked cars score 0.6–0.8, passing traffic in the adjacent lane 0–0.1.
const OCCUPIED_THRESHOLD = 0.4;
const HISTORY = 3; // readings used for majority vote

// Called by the /ingest HTTP action after the frame is in storage.
export const apply = internalMutation({
  args: {
    camId: v.string(),
    frame: v.optional(v.id("_storage")),
    vehicles: v.array(v.array(v.number())),
    ts: v.number(),
  },
  handler: async (ctx, { camId, vehicles, ts, ...rest }) => {
    let frame = rest.frame;
    const cam = await ctx.db
      .query("cameras")
      .withIndex("by_camId", (q) => q.eq("camId", camId))
      .unique();
    if (!cam) {
      if (frame) await ctx.storage.delete(frame);
      throw new Error(`unknown camera ${camId}`);
    }
    if (cam.enabled === false || (cam.lastSeen && ts <= cam.lastSeen)) {
      if (frame) await ctx.storage.delete(frame);
      return { stalls: 0, skipped: true };
    }
    if (cam.storeFrames === false) {
      // Operator terms forbid keeping pictures for this camera: never store, always clear.
      if (frame) await ctx.storage.delete(frame);
      frame = undefined;
      if (cam.lastFrame) await ctx.storage.delete(cam.lastFrame);
      await ctx.db.patch(cam._id, { lastFrame: undefined, lastSeen: ts, vehicles });
    }
    if (frame && cam.lastFrame) await ctx.storage.delete(cam.lastFrame);
    await ctx.db.patch(cam._id, { ...(frame ? { lastFrame: frame } : {}), lastSeen: ts, vehicles });

    const stalls = await ctx.db
      .query("stalls")
      .withIndex("by_camera", (q) => q.eq("cameraId", cam._id))
      .collect();
    for (const s of stalls) {
      const occupied = stallOccupancy(s.polygon as Pt[], vehicles) >= OCCUPIED_THRESHOLD;
      const history = [...s.history, occupied].slice(-HISTORY);
      const takenVotes = history.filter(Boolean).length;
      const taken = takenVotes * 2 > history.length;
      const agree = taken ? takenVotes : history.length - takenVotes;
      const status = taken ? "taken" : "open";
      const confidence = agree / history.length;
      // Keep the search fresh without broadcasting every unchanged stall on every frame.
      if (s.status !== status || s.confidence !== confidence || ts - s.updatedAt >= 30_000) {
        await ctx.db.patch(s._id, { history, status, confidence, updatedAt: ts });
      } else if (history.some((value, index) => value !== s.history[index])) {
        await ctx.db.patch(s._id, { history });
      }
    }
    return { stalls: stalls.length };
  },
});
