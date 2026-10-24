import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Worker posts: { camId, ts, vehicles: [[x1,y1,x2,y2,conf]...], frame: base64 JPEG }
http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await req.json();
    const bytes = Uint8Array.from(atob(body.frame), (c) => c.charCodeAt(0));
    const frame = await ctx.storage.store(new Blob([bytes], { type: "image/jpeg" }));
    const result = await ctx.runMutation(internal.ingest.apply, {
      camId: body.camId,
      frame,
      vehicles: body.vehicles,
      ts: body.ts ?? Date.now(),
    });
    return Response.json(result);
  }),
});

// Fetch.ai ParkSight Agent: { text, lat, lng, sessionId } -> held spot + spoken-style reply + frame URL.
// sessionId is the ASI:One sender, so each chat user holds at most one spot.
http.route({
  path: "/agent/find",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.AGENT_SECRET;
    if (!secret || req.headers.get("x-agent-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await req.json().catch(() => null);
    const ok =
      body &&
      typeof body.text === "string" &&
      body.text.length > 0 &&
      body.text.length <= 2000 &&
      Number.isFinite(body.lat) &&
      Number.isFinite(body.lng) &&
      typeof body.sessionId === "string" &&
      body.sessionId.length > 0 &&
      body.sessionId.length <= 256;
    if (!ok) return new Response("bad request", { status: 400 });

    const result = await ctx.runAction(internal.assistant.askCore, {
      text: body.text,
      lat: body.lat,
      lng: body.lng,
      sessionId: `agent:${body.sessionId}`,
    });
    const frameUrl = result.spot
      ? await ctx.runQuery(internal.parking.stallFrameUrl, { stallId: result.spot.stallId })
      : null;
    return Response.json({ ...result, frameUrl });
  }),
});

// Worker reads its camera list (and stall polygons for debug overlays) here.
http.route({
  path: "/cameras",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const cams = await ctx.runQuery(internal.parking.workerCameras, {});
    return Response.json(cams);
  }),
});

export default http;
