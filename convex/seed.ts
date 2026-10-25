import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { cellFor } from "./geo";

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
    sourceType: "youtube" as const,
    sourceAttribution: "SF Bay Times Castro Street Cams",
    enabled: true,
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
  // Cam 2 looks south along Castro St toward 18th (the Walgreens at 498 Castro is on the right/west side;
  // Twin Peaks and Sutro Tower are off to the right). C2-1 is the left (east) curb; C2-2..C2-5 were drawn by
  // hand along the right (west) curb, nearest to farthest. Map positions: C2-1 is an estimate from DataSF's
  // Castro St centerline; C2-2..C2-5 are NOT placed yet (they sit on the camera). Set them at #/calibrate.
  {
    camId: "castro-cam2",
    name: "Castro St looking south (Cam 2)",
    youtubeId: "wFESUxAE-S8",
    sourceType: "youtube" as const,
    sourceAttribution: "SF Bay Times Castro Street Cams",
    enabled: true,
    lat: 37.76185,
    lng: -122.4351,
    heading: 180,
    stalls: [
      { label: "C2-1", lat: 37.7616, lng: -122.43499, polygon: [[436, 596], [556, 586], [562, 696], [436, 704]] },
      { label: "C2-2", lat: 37.76185, lng: -122.4351, polygon: [[1085, 532], [1072, 559], [1179, 588], [1189, 560]] },
      { label: "C2-3", lat: 37.76185, lng: -122.4351, polygon: [[922, 486], [894, 501], [1048, 552], [1055, 530]] },
      { label: "C2-4", lat: 37.76185, lng: -122.4351, polygon: [[807, 450], [777, 470], [871, 498], [890, 477]] },
      { label: "C2-5", lat: 37.76185, lng: -122.4351, polygon: [[740, 455], [756, 442], [686, 421], [664, 432]] },
    ],
  },
  // Cam 5 shows the Castro Theatre front. C5-1..C5-3 were drawn by hand along the street-side curb at the
  // bottom right. Their map positions are NOT placed yet (they sit on the camera). Set them at #/calibrate.
  {
    camId: "castro-cam5",
    name: "Castro Theatre (Cam 5)",
    youtubeId: "tSZaTvW7LDA",
    sourceType: "youtube" as const,
    sourceAttribution: "SF Bay Times Castro Street Cams",
    enabled: true,
    lat: 37.76196,
    lng: -122.43528,
    heading: 90,
    stalls: [
      { label: "C5-1", lat: 37.76196, lng: -122.43528, polygon: [[903, 686], [946, 707], [1054, 676], [1001, 660]] },
      { label: "C5-2", lat: 37.76196, lng: -122.43528, polygon: [[1092, 618], [1124, 637], [1178, 610], [1141, 596]] },
      { label: "C5-3", lat: 37.76196, lng: -122.43528, polygon: [[1009, 653], [1057, 671], [1109, 639], [1080, 627]] },
    ],
  },
  // Cams 3 and 4 face the Market St plazas, with no curb parking in view, so they have no stalls and stay
  // out of driver search until some are drawn at #/calibrate. Positions and headings are rough estimates.
  {
    camId: "castro-cam3",
    name: "Castro & Market (Cam 3)",
    youtubeId: "2heiMNW-d7w",
    sourceType: "youtube" as const,
    sourceAttribution: "SF Bay Times Castro Street Cams",
    enabled: true,
    lat: 37.7624,
    lng: -122.4348,
    heading: 280,
    stalls: [],
  },
  {
    camId: "castro-cam4",
    name: "Jane Warner Plaza (Cam 4)",
    youtubeId: "gBeKCQmhY8I",
    sourceType: "youtube" as const,
    sourceAttribution: "SF Bay Times Castro Street Cams",
    enabled: true,
    lat: 37.7625,
    lng: -122.4351,
    heading: 15,
    stalls: [],
  },
];

// npx convex run seed:castro            (adds missing cameras/stalls)
// npx convex run seed:castro '{"reset":true}'  (wipes and reseeds)
export const castro = internalMutation({
  args: { reset: v.optional(v.boolean()) },
  handler: async (ctx, { reset }) => {
    if (reset) {
      for (const seeded of CAMERAS) {
        const camera = await ctx.db.query("cameras").withIndex("by_camId", (q) => q.eq("camId", seeded.camId)).unique();
        if (!camera) continue;
        const stalls = await ctx.db.query("stalls").withIndex("by_camera", (q) => q.eq("cameraId", camera._id)).collect();
        for (const stall of stalls) {
          const holds = await ctx.db.query("holds").withIndex("by_stall", (q) => q.eq("stallId", stall._id)).collect();
          for (const hold of holds) await ctx.db.delete(hold._id);
          await ctx.db.delete(stall._id);
        }
        if (camera.lastFrame) await ctx.storage.delete(camera.lastFrame);
        await ctx.db.delete(camera._id);
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
          // A stall still at its camera's position hasn't been pinned on the map yet.
          placed: s.lat !== cam.lat || s.lng !== cam.lng,
          polygon: s.polygon.map(([x, y]) => [x / W, y / H]),
          status: "unknown",
          confidence: 0,
          history: [],
          updatedAt: 0,
          cell: cellFor(s.lat, s.lng),
        });
      }
      added++;
    }
    return { added };
  },
});

// Run once after deploying the spatial index on an existing database.
export const migrateSpatialIndex = internalMutation({
  args: {},
  handler: async (ctx) => {
    const legacy = await ctx.db
      .query("stalls")
      .withIndex("by_cell", (q) => q.eq("cell", undefined))
      .take(500);
    for (const stall of legacy) {
      await ctx.db.patch(stall._id, { cell: cellFor(stall.lat, stall.lng) });
    }
    return { migrated: legacy.length, more: legacy.length === 500 };
  },
});

// Run once after deploying the `placed` flag: stalls still sitting on their camera's position are unplaced.
export const markUnplaced = internalMutation({
  args: {},
  handler: async (ctx) => {
    let unplaced = 0;
    for (const stall of await ctx.db.query("stalls").collect()) {
      const camera = await ctx.db.get(stall.cameraId);
      const atCamera = !camera || (Math.abs(stall.lat - camera.lat) < 1e-7 && Math.abs(stall.lng - camera.lng) < 1e-7);
      if (atCamera && stall.placed !== false) {
        await ctx.db.patch(stall._id, { placed: false });
        unplaced++;
      }
    }
    return { unplaced };
  },
});
