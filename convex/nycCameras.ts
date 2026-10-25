import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { distanceMeters, polygonArea, type Pt } from "./geometry";
import { serviceAreaFor } from "./areas";

const PROVIDER = "nyc-dot";
const CATALOG_URL = "https://webcams.nyctmc.org/api/cameras";
const IMAGE_ORIGIN = "https://webcams.nyctmc.org/api/cameras/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NEARBY = 8;
const MAX_REVIEW_DISTANCE_M = 250;
const ANALYSIS_REQUEST_TTL_MS = 2 * 60_000;
const MAX_ACTIVE_ANALYSES = 4;

const catalogCamera = v.object({
  id: v.string(),
  name: v.string(),
  lat: v.number(),
  lng: v.number(),
  area: v.string(),
  online: v.boolean(),
});

// One catalog read per pin move. Images are loaded only for the selected camera
// in the browser, and these traffic cameras never enter the parking worker.
export const nearby = query({
  args: { lat: v.number(), lng: v.number() },
  handler: async (ctx, { lat, lng }) => {
    const catalog = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    if (!catalog) return { fetchedAt: null, total: 0, cameras: [] };
    if (serviceAreaFor(lat, lng) !== "nyc") {
      return { fetchedAt: catalog.fetchedAt, total: catalog.cameras.length, cameras: [] };
    }
    const cameras = catalog.cameras
      .filter((camera) => camera.online)
      .map((camera) => ({
        ...camera,
        distanceM: Math.round(distanceMeters(lat, lng, camera.lat, camera.lng)),
        imageUrl: `${IMAGE_ORIGIN}${camera.id}/image`,
      }))
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, MAX_NEARBY);
    return { fetchedAt: catalog.fetchedAt, total: catalog.cameras.length, cameras };
  },
});

function requireReviewSecret(provided: string) {
  const expected = process.env.CALIBRATION_SECRET;
  if (!expected || provided !== expected) throw new Error("Calibration access denied");
}

export const listReviewStalls = query({
  args: { cameraId: v.string() },
  handler: async (ctx, { cameraId }) => {
    if (!UUID.test(cameraId)) return [];
    return ctx.db.query("nycReviewStalls")
      .withIndex("by_camera", (q) => q.eq("cameraId", cameraId.toLowerCase()))
      .collect();
  },
});

// The browser only asks for analysis of the camera the user selected. This
// bounds inference and image bandwidth independently of the 973-camera catalog.
export const requestAnalysis = mutation({
  args: { cameraId: v.string() },
  handler: async (ctx, { cameraId }) => {
    const id = cameraId.toLowerCase();
    if (!UUID.test(id) || process.env.NYC_DOT_FEED_ENABLED !== "true") return false;
    const catalog = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    if (!catalog?.cameras.some((camera) => camera.id === id && camera.online)) return false;
    const now = Date.now();
    const requests = await ctx.db.query("nycAnalysisRequests").collect();
    for (const request of requests) {
      if (now - request.requestedAt > ANALYSIS_REQUEST_TTL_MS) await ctx.db.delete(request._id);
    }
    const active = requests.filter((request) => now - request.requestedAt <= ANALYSIS_REQUEST_TTL_MS);
    const existing = active.find((request) => request.cameraId === id);
    if (existing) {
      if (now - existing.requestedAt > 30_000) await ctx.db.patch(existing._id, { requestedAt: now });
      return true;
    }
    if (active.length >= MAX_ACTIVE_ANALYSES) {
      const oldest = active.reduce((a, b) => a.requestedAt < b.requestedAt ? a : b);
      await ctx.db.delete(oldest._id);
    }
    await ctx.db.insert("nycAnalysisRequests", { cameraId: id, requestedAt: now });
    return true;
  },
});

export const analysisQueue = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (process.env.NYC_DOT_FEED_ENABLED !== "true") return [];
    const now = Date.now();
    const catalog = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    if (!catalog) return [];
    const active = (await ctx.db.query("nycAnalysisRequests").collect())
      .filter((request) => now - request.requestedAt <= ANALYSIS_REQUEST_TTL_MS)
      .slice(0, MAX_ACTIVE_ANALYSES);
    return active.flatMap((request) => {
      const camera = catalog.cameras.find((entry) => entry.id === request.cameraId && entry.online);
      return camera ? [{ cameraId: camera.id, imageUrl: `${IMAGE_ORIGIN}${camera.id}/image` }] : [];
    });
  },
});

export const observation = query({
  args: { cameraId: v.string() },
  handler: async (ctx, { cameraId }) => {
    if (!UUID.test(cameraId)) return null;
    const latest = await ctx.db.query("nycObservations")
      .withIndex("by_camera", (q) => q.eq("cameraId", cameraId.toLowerCase())).unique();
    if (!latest) return null;
    return {
      observedAt: latest.observedAt,
      frameUrl: await ctx.storage.getUrl(latest.frame),
      vehicles: latest.vehicles,
    };
  },
});

export const saveObservation = internalMutation({
  args: {
    cameraId: v.string(),
    observedAt: v.number(),
    frame: v.id("_storage"),
    vehicles: v.array(v.array(v.number())),
  },
  handler: async (ctx, { cameraId, observedAt, frame, vehicles }) => {
    const request = await ctx.db.query("nycAnalysisRequests")
      .withIndex("by_camera", (q) => q.eq("cameraId", cameraId)).unique();
    if (!request || Date.now() - request.requestedAt > ANALYSIS_REQUEST_TTL_MS) {
      await ctx.storage.delete(frame);
      return { saved: false };
    }
    const old = await ctx.db.query("nycObservations")
      .withIndex("by_camera", (q) => q.eq("cameraId", cameraId)).unique();
    if (old && observedAt <= old.observedAt) {
      await ctx.storage.delete(frame);
      return { saved: false };
    }
    if (old) {
      await ctx.storage.delete(old.frame);
      await ctx.db.patch(old._id, { observedAt, frame, vehicles });
    } else {
      await ctx.db.insert("nycObservations", { cameraId, observedAt, frame, vehicles });
    }
    return { saved: true };
  },
});

export const saveReviewStall = mutation({
  args: {
    adminSecret: v.string(),
    cameraId: v.string(),
    label: v.string(),
    polygon: v.array(v.array(v.number())),
    lat: v.number(),
    lng: v.number(),
  },
  handler: async (ctx, { adminSecret, cameraId, label, polygon, lat, lng }) => {
    requireReviewSecret(adminSecret);
    const id = cameraId.toLowerCase();
    if (!UUID.test(id) || !label.trim() || label.length > 60 ||
        polygon.length !== 4 ||
        polygon.some((point) => point.length !== 2 || point.some((coordinate) =>
          !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) ||
        polygonArea(polygon as Pt[]) < 0.0001 ||
        serviceAreaFor(lat, lng) !== "nyc") {
      throw new Error("Invalid review candidate");
    }
    const catalog = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    const camera = catalog?.cameras.find((entry) => entry.id === id);
    if (!camera || distanceMeters(lat, lng, camera.lat, camera.lng) > MAX_REVIEW_DISTANCE_M) {
      throw new Error("Candidate must be close to its camera");
    }
    return ctx.db.insert("nycReviewStalls", {
      cameraId: id, label: label.trim(), polygon, lat, lng, reviewedAt: Date.now(),
    });
  },
});

export const deleteReviewStall = mutation({
  args: { adminSecret: v.string(), id: v.id("nycReviewStalls") },
  handler: async (ctx, { adminSecret, id }) => {
    requireReviewSecret(adminSecret);
    const candidate = await ctx.db.get(id);
    if (candidate) await ctx.db.delete(id);
  },
});

export const replaceCatalog = internalMutation({
  args: { fetchedAt: v.number(), cameras: v.array(catalogCamera) },
  handler: async (ctx, { fetchedAt, cameras }) => {
    const old = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    if (old) await ctx.db.patch(old._id, { fetchedAt, cameras });
    else await ctx.db.insert("cameraCatalogs", { provider: PROVIDER, fetchedAt, cameras });
    return { count: cameras.length };
  },
});

// Operator-approved NYC DOT catalog refresh. Bad or partial responses leave the
// previous catalog intact, so a temporary provider outage does not blank the map.
export const refreshCatalog = internalAction({
  args: {},
  handler: async (ctx): Promise<{ count: number; skipped?: boolean }> => {
    // Operational switch only; it is not proof of rights to use the feed.
    // Operators enable refreshes after arranging feed access with NYC DOT.
    if (process.env.NYC_DOT_FEED_ENABLED !== "true") return { count: 0, skipped: true };
    const response = await fetch(CATALOG_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`NYC DOT catalog returned HTTP ${response.status}`);
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) throw new Error("NYC DOT catalog is not an array");
    const seen = new Set<string>();
    const cameras = raw.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const id = typeof entry.id === "string" ? entry.id.toLowerCase() : "";
      const lat = Number(entry.latitude);
      const lng = Number(entry.longitude);
      if (!UUID.test(id) || seen.has(id) || !Number.isFinite(lat) || !Number.isFinite(lng) ||
          serviceAreaFor(lat, lng) !== "nyc" || typeof entry.name !== "string" || !entry.name.trim()) return [];
      seen.add(id);
      return [{
        id,
        name: entry.name.trim().slice(0, 120),
        lat,
        lng,
        area: typeof entry.area === "string" ? entry.area.slice(0, 40) : "New York City",
        online: entry.isOnline === true || entry.isOnline === "true",
      }];
    });
    if (cameras.length < 100 || cameras.length > 2_000) {
      throw new Error(`NYC DOT catalog size is unexpected: ${cameras.length}`);
    }
    return await ctx.runMutation(internal.nycCameras.replaceCatalog, { fetchedAt: Date.now(), cameras });
  },
});
