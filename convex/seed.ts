import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// Castro Street Cams (SF Bay Times, YouTube Live). Lat/lng and stall
// geo-positions are approximate — refine them in the Calibrate view.
// Stall polygons are in 1280x720 pixel space here and normalized on insert.
const W = 1280;
const H = 720;

const CAMERAS = [
  {
    camId: "castro-cam1",
    name: "Castro St (Cam 1)",
    youtubeId: "ypeBQhmJREM",
    lat: 37.7612,
    lng: -122.43492,
    heading: 0,
    stalls: [
      { label: "C1-1", lat: 37.76128, lng: -122.43508, polygon: [[255, 655], [408, 620], [422, 698], [268, 716]] },
      { label: "C1-2", lat: 37.76134, lng: -122.43509, polygon: [[410, 612], [508, 588], [520, 658], [424, 676]] },
      { label: "C1-3", lat: 37.7614, lng: -122.4351, polygon: [[505, 572], [596, 550], [606, 612], [515, 630]] },
      { label: "C1-4", lat: 37.76146, lng: -122.43511, polygon: [[595, 540], [668, 522], [676, 574], [603, 590]] },
    ],
  },
  {
    camId: "castro-cam2",
    name: "Castro & 18th (Cam 2)",
    youtubeId: "wFESUxAE-S8",
    lat: 37.76092,
    lng: -122.43485,
    heading: 225,
    stalls: [
      { label: "C2-1", lat: 37.76082, lng: -122.43470, polygon: [[1170, 600], [1280, 600], [1280, 675], [1170, 675]] },
      { label: "C2-2", lat: 37.76097, lng: -122.43532, polygon: [[448, 600], [552, 600], [552, 685], [448, 685]] },
    ],
  },
  {
    camId: "castro-cam5",
    name: "Castro Theatre (Cam 5)",
    youtubeId: "tSZaTvW7LDA",
    lat: 37.76205,
    lng: -122.43468,
    heading: 270,
    stalls: [
      { label: "C5-1", lat: 37.76215, lng: -122.43482, polygon: [[1088, 640], [1188, 640], [1188, 694], [1088, 694]] },
      { label: "C5-2", lat: 37.76208, lng: -122.43483, polygon: [[966, 688], [1088, 688], [1088, 720], [966, 720]] },
    ],
  },
];

// npx convex run seed:castro            (adds missing cameras/stalls)
// npx convex run seed:castro '{"reset":true}'  (wipes and reseeds)
export const castro = internalMutation({
  args: { reset: v.optional(v.boolean()) },
  handler: async (ctx, { reset }) => {
    if (reset) {
      for (const t of ["holds", "stalls", "cameras"] as const) {
        for (const doc of await ctx.db.query(t).collect()) {
          if (t === "cameras" && "lastFrame" in doc && doc.lastFrame) await ctx.storage.delete(doc.lastFrame);
          await ctx.db.delete(doc._id);
        }
      }
    }
    let added = 0;
    for (const { stalls, ...cam } of CAMERAS) {
      const existing = await ctx.db
        .query("cameras")
        .withIndex("by_camId", (q) => q.eq("camId", cam.camId))
        .unique();
      if (existing) continue;
      const cameraId = await ctx.db.insert("cameras", cam);
      for (const s of stalls) {
        await ctx.db.insert("stalls", {
          cameraId,
          label: s.label,
          lat: s.lat,
          lng: s.lng,
          polygon: s.polygon.map(([x, y]) => [x / W, y / H]),
          status: "unknown",
          confidence: 0,
          history: [],
          updatedAt: 0,
        });
      }
      added++;
    }
    return { added };
  },
});
