import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { serviceAreaFor } from "./areas";

const PROVIDER = "caltrans-d4-sf";
const SOURCE = "https://caltrans-gis.dot.ca.gov/arcgis/rest/services/chhighway/CCTV/MapServer/0/query";
const IMAGE_PATH = /^\/data\/d4\/cctv\/image\/([a-z0-9_-]+)\/\1\.jpg$/i;

const catalogCamera = v.object({
  id: v.string(),
  name: v.string(),
  lat: v.number(),
  lng: v.number(),
  area: v.string(),
  online: v.boolean(),
  imageUrl: v.string(),
});

// The SF catalog is small: one subscription supplies every marker, while the
// browser fetches only the selected JPEG. These highway views are never put in
// the curb-space inventory or sent to the parking detector.
export const catalog = query({
  args: {},
  handler: async (ctx) => {
    const record = await ctx.db.query("cameraCatalogs")
      .withIndex("by_provider", (q) => q.eq("provider", PROVIDER)).unique();
    return {
      fetchedAt: record?.fetchedAt ?? null,
      cameras: record?.cameras.flatMap((camera) => camera.online && camera.imageUrl
        ? [{ ...camera, imageUrl: camera.imageUrl }] : []) ?? [],
    };
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

// Refresh metadata every six hours, not images. Reject unexpected/partial
// responses so a temporary upstream error cannot erase the last good map.
export const refreshCatalog = internalAction({
  args: {},
  handler: async (ctx): Promise<{ count: number }> => {
    const url = new URL(SOURCE);
    url.search = new URLSearchParams({
      where: "1=1",
      geometry: "-122.53,37.60,-122.34,37.84",
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "locationName,latitude,longitude,currentImageURL,inService,county",
      returnGeometry: "false",
      f: "json",
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Caltrans catalog returned HTTP ${response.status}`);
    const raw: unknown = await response.json();
    if (!raw || typeof raw !== "object") throw new Error("Invalid Caltrans catalog");
    const result = raw as Record<string, unknown>;
    if (result.exceededTransferLimit === true || !Array.isArray(result.features)) {
      throw new Error("Incomplete Caltrans catalog");
    }
    const seen = new Set<string>();
    const cameras = result.features.flatMap((feature: unknown) => {
      if (!feature || typeof feature !== "object") return [];
      const attributes = (feature as Record<string, unknown>).attributes;
      if (!attributes || typeof attributes !== "object") return [];
      const item = attributes as Record<string, unknown>;
      const lat = Number(item.latitude);
      const lng = Number(item.longitude);
      if (item.county !== "San Francisco" ||
          !(item.inService === true ||
            (typeof item.inService === "string" && item.inService.toLowerCase() === "true")) ||
          !Number.isFinite(lat) || !Number.isFinite(lng) ||
          serviceAreaFor(lat, lng) !== "sf" ||
          typeof item.locationName !== "string" || !item.locationName.trim() ||
          typeof item.currentImageURL !== "string") return [];
      let imageUrl: URL;
      try { imageUrl = new URL(item.currentImageURL); }
      catch { return []; }
      if (imageUrl.origin !== "https://cwwp2.dot.ca.gov" || imageUrl.search || imageUrl.hash) return [];
      const match = IMAGE_PATH.exec(imageUrl.pathname);
      if (!match || seen.has(match[1])) return [];
      seen.add(match[1]);
      return [{
        id: match[1],
        name: item.locationName.trim().replace(/\s+/g, " ").slice(0, 100),
        lat,
        lng,
        area: "San Francisco",
        online: true,
        imageUrl: imageUrl.toString(),
      }];
    });
    if (cameras.length < 20 || cameras.length > 100) {
      throw new Error(`Unexpected SF camera count: ${cameras.length}`);
    }
    return await ctx.runMutation(internal.sfCameras.replaceCatalog, { fetchedAt: Date.now(), cameras });
  },
});
