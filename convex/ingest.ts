import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Pt } from "./geometry";
import { classifyStallFrame, nextStallState } from "./occupancy";

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
      if (cam.lastFrame) await ctx.storage.delete(cam.lastFrame);
      await ctx.db.patch(cam._id, { lastFrame: undefined, lastSeen: ts, vehicles });
    } else {
      if (frame && cam.lastFrame) await ctx.storage.delete(cam.lastFrame);
      await ctx.db.patch(cam._id, { ...(frame ? { lastFrame: frame } : {}), lastSeen: ts, vehicles });
    }

    const stalls = await ctx.db
      .query("stalls")
      .withIndex("by_camera", (q) => q.eq("cameraId", cam._id))
      .collect();
    for (const s of stalls) {
      const evidence = classifyStallFrame(s.polygon as Pt[], vehicles);
      const { history, status, confidence } = nextStallState(s.history, evidence);
      // Keep the search fresh without broadcasting every unchanged stall on every frame.
      if (s.status !== status || s.confidence !== confidence || ts - s.updatedAt >= 30_000) {
        await ctx.db.patch(s._id, { history, status, confidence, updatedAt: ts });
      } else if (history.length !== s.history.length || history.some((value, index) => value !== s.history[index])) {
        await ctx.db.patch(s._id, { history });
      }
    }
    return { stalls: stalls.length };
  },
});
