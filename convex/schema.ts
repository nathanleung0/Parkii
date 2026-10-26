import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// All image-space coordinates (stall polygons, vehicle boxes) are normalized
// to 0..1 so they work for any frame resolution.
export default defineSchema({
  cameraCatalogs: defineTable({
    provider: v.string(),
    fetchedAt: v.number(),
    cameras: v.array(v.object({
      id: v.string(),
      name: v.string(),
      lat: v.number(),
      lng: v.number(),
      area: v.string(),
      online: v.boolean(),
      imageUrl: v.optional(v.string()), // Caltrans snapshots; NYC URLs derive from the camera ID
    })),
  }).index("by_provider", ["provider"]),

  // Operator-drawn NYC candidates are review notes, never parking inventory.
  nycReviewStalls: defineTable({
    cameraId: v.string(),
    label: v.string(),
    polygon: v.array(v.array(v.number())),
    lat: v.number(),
    lng: v.number(),
    reviewedAt: v.number(),
  }).index("by_camera", ["cameraId"]),

  // At most a few recently selected NYC views are sent to the detector.
  nycAnalysisRequests: defineTable({
    cameraId: v.string(),
    requestedAt: v.number(),
  }).index("by_camera", ["cameraId"]),

  nycObservations: defineTable({
    cameraId: v.string(),
    observedAt: v.number(),
    frame: v.id("_storage"),
    vehicles: v.array(v.array(v.number())),
  }).index("by_camera", ["cameraId"]),

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
    // [x1, y1, x2, y2, confidence, COCO class] per candidate vehicle.
    // Older five-number rows are also accepted while workers roll forward.
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
