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
    frame: v.id("_storage"),
    vehicles: v.array(v.array(v.number())),
    ts: v.number(),
  },
  handler: async (ctx, { camId, frame, vehicles, ts }) => {
    const cam = await ctx.db
      .query("cameras")
      .withIndex("by_camId", (q) => q.eq("camId", camId))
      .unique();
    if (!cam) {
      await ctx.storage.delete(frame);
      throw new Error(`unknown camera ${camId}`);
    }
    if (cam.lastFrame) await ctx.storage.delete(cam.lastFrame);
    await ctx.db.patch(cam._id, { lastFrame: frame, lastSeen: ts, vehicles });

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
      await ctx.db.patch(s._id, {
        history,
        status: taken ? "taken" : "open",
        confidence: agree / history.length,
        updatedAt: ts,
      });
    }
    return { stalls: stalls.length };
  },
});
