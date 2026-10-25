import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// All image-space coordinates (stall polygons, vehicle boxes) are normalized
// to 0..1 so they work for any frame resolution.
export default defineSchema({
  cameras: defineTable({
    camId: v.string(),
    name: v.string(),
    youtubeId: v.optional(v.string()), // existing Castro rows
    sourceType: v.optional(v.union(v.literal("youtube"), v.literal("jpeg"), v.literal("hls"))),
    sourceUrl: v.optional(v.string()),
    sourceAttribution: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    // false = never store or show this camera's pictures (an operator may require this). Missing means store.
    storeFrames: v.optional(v.boolean()),
    lat: v.number(),
    lng: v.number(),
    heading: v.number(), // degrees, 0 = north
    lastFrame: v.optional(v.id("_storage")),
    lastSeen: v.optional(v.number()),
    // [x1, y1, x2, y2, confidence] per detected vehicle
    vehicles: v.optional(v.array(v.array(v.number()))),
  }).index("by_camId", ["camId"]),

  stalls: defineTable({
    cameraId: v.id("cameras"),
    label: v.string(),
    polygon: v.array(v.array(v.number())), // [[x, y], ...]
    lat: v.number(),
    lng: v.number(),
    status: v.union(v.literal("open"), v.literal("taken"), v.literal("unknown")),
    confidence: v.number(),
    history: v.array(v.boolean()), // last N raw readings, true = occupied
    updatedAt: v.number(),
    cell: v.optional(v.string()), // optional until seed:migrateSpatialIndex backfills existing rows
    // false = drawn in the camera frame but not yet pinned on the map (lat/lng are just the camera position).
    // Unplaced stalls never appear on the map, in search, or in coverage. Missing means placed (older rows).
    placed: v.optional(v.boolean()),
  })
    .index("by_camera", ["cameraId"])
    .index("by_cell", ["cell"]),

  holds: defineTable({
    stallId: v.id("stalls"),
    sessionId: v.string(),
    expiresAt: v.number(),
  })
    .index("by_stall", ["stallId"])
    .index("by_session", ["sessionId"]),
});
