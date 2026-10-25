import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

// Worker posts detections every poll; a preview JPEG is optional and sent less often.
http.route({
  path: "/ingest",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    const body = await req.json();
    if (
      !body || typeof body.camId !== "string" || !Number.isFinite(body.ts) ||
      !Array.isArray(body.vehicles) ||
      (body.frame !== undefined && typeof body.frame !== "string")
    ) {
      return new Response("bad request", { status: 400 });
    }
    const frame = body.frame
      ? await ctx.storage.store(new Blob([Uint8Array.from(atob(body.frame), (c) => c.charCodeAt(0))], { type: "image/jpeg" }))
      : undefined;
    const result = await ctx.runMutation(internal.ingest.apply, {
      camId: body.camId,
      frame,
      vehicles: body.vehicles,
      ts: body.ts,
    });
    return Response.json(result);
  }),
});

// Fetch.ai Parkii Agent: { text, lat, lng, sessionId } -> held spot + spoken-style reply + frame URL.
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
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    const cams = await ctx.runQuery(internal.parking.workerCameras, {});
    return Response.json(cams);
  }),
});

// Only recently selected NYC camera previews enter this bounded analysis queue.
http.route({
  path: "/nyc-analysis-queue",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json(await ctx.runQuery(internal.nycCameras.analysisQueue, {}));
  }),
});

http.route({
  path: "/nyc-observation",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.INGEST_SECRET;
    if (!secret || req.headers.get("x-ingest-secret") !== secret) {
      return new Response("unauthorized", { status: 401 });
    }
    if (Number(req.headers.get("content-length") ?? 0) > 1_500_000) {
      return new Response("payload too large", { status: 413 });
    }
    const body = await req.json().catch(() => null);
    const validBox = (box: unknown) => Array.isArray(box) && box.length === 6 &&
      box.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      box.slice(0, 4).every((n) => n >= 0 && n <= 1) &&
      box[0] < box[2] && box[1] < box[3] &&
      box[4] >= 0 && box[4] <= 1 && [2, 3, 5, 7].includes(box[5]);
    if (!body || typeof body.cameraId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(body.cameraId) ||
        typeof body.frame !== "string" || body.frame.length > 1_000_000 ||
        !Number.isFinite(body.observedAt) ||
        Math.abs(Date.now() - body.observedAt) > 90_000 ||
        !Array.isArray(body.vehicles) || body.vehicles.length > 100 ||
        !body.vehicles.every(validBox)) {
      return new Response("bad request", { status: 400 });
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(body.frame), (c) => c.charCodeAt(0));
    } catch {
      return new Response("invalid image", { status: 400 });
    }
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
        bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
      return new Response("invalid image", { status: 400 });
    }
    const imageBuffer = new ArrayBuffer(bytes.length);
    new Uint8Array(imageBuffer).set(bytes);
    const frame = await ctx.storage.store(new Blob([imageBuffer], { type: "image/jpeg" }));
    return Response.json(await ctx.runMutation(internal.nycCameras.saveObservation, {
      cameraId: body.cameraId, observedAt: body.observedAt,
      frame, vehicles: body.vehicles,
    }));
  }),
});

export default http;
