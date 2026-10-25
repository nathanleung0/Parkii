import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { inSfOrNyc } from "./geo";

// Operator-only camera registry. Add a feed only after confirming that its
// operator permits this use and that it actually sees legal curb spaces.
export const upsert = internalMutation({
  args: {
    camId: v.string(),
    name: v.string(),
    lat: v.number(),
    lng: v.number(),
    heading: v.number(),
    sourceType: v.union(v.literal("youtube"), v.literal("jpeg"), v.literal("hls")),
    youtubeId: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    sourceAttribution: v.string(),
    enabled: v.boolean(),
    storeFrames: v.optional(v.boolean()),
  },
  handler: async (ctx, camera) => {
    if (!camera.camId.trim() || !camera.name.trim() || !camera.sourceAttribution.trim()) {
      throw new Error("Camera ID, name, and attribution are required");
    }
    const area = inSfOrNyc(camera.lat, camera.lng);
    if (!area) throw new Error("Camera must be in San Francisco or New York City");
    if (camera.sourceType === "youtube") {
      if (!camera.youtubeId || !/^[A-Za-z0-9_-]{11}$/.test(camera.youtubeId)) {
        throw new Error("A valid YouTube video ID is required");
      }
    } else if (!camera.sourceUrl || !camera.sourceUrl.startsWith("https://")) {
      throw new Error("An HTTPS feed URL is required");
    }
    const old = await ctx.db.query("cameras").withIndex("by_camId", (q) => q.eq("camId", camera.camId)).unique();
    if (!old) return ctx.db.insert("cameras", camera);
    const sourceChanged =
      (old.sourceType ?? "youtube") !== camera.sourceType || old.sourceUrl !== camera.sourceUrl || old.youtubeId !== camera.youtubeId;
    if (sourceChanged && old.lastFrame) await ctx.storage.delete(old.lastFrame);
    await ctx.db.patch(old._id, {
      ...camera,
      ...(sourceChanged ? { lastFrame: undefined, lastSeen: undefined, vehicles: undefined } : {}),
    });
    if (sourceChanged || !camera.enabled) {
      const stalls = await ctx.db.query("stalls").withIndex("by_camera", (q) => q.eq("cameraId", old._id)).collect();
      for (const stall of stalls) {
        await ctx.db.patch(stall._id, { status: "unknown", history: [], confidence: 0, updatedAt: 0 });
      }
    }
    return old._id;
  },
});
