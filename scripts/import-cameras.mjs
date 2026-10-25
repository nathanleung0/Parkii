import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [manifestPath, ...flags] = process.argv.slice(2);
if (!manifestPath || flags.some((flag) => flag !== "--dry-run")) {
  console.error("Usage: npm run cameras:import -- <manifest.json> [--dry-run]");
  process.exit(2);
}

const cameras = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!Array.isArray(cameras) || cameras.length === 0) {
  throw new Error("Manifest must be a nonempty JSON array of cameras");
}

const ids = new Set();
for (const camera of cameras) {
  if (!camera.camId || ids.has(camera.camId)) throw new Error(`Missing or duplicate camId: ${camera.camId}`);
  ids.add(camera.camId);
  if (typeof camera.enabled !== "boolean" || !camera.sourceAttribution) {
    throw new Error(`${camera.camId}: enabled and sourceAttribution are required`);
  }
  if (!Number.isFinite(camera.lat) || !Number.isFinite(camera.lng) || !Number.isFinite(camera.heading)) {
    throw new Error(`${camera.camId}: lat, lng, and heading must be numbers`);
  }
  if (camera.sourceType === "youtube") {
    if (!/^[A-Za-z0-9_-]{11}$/.test(camera.youtubeId ?? "")) {
      throw new Error(`${camera.camId}: invalid YouTube video ID`);
    }
  } else if (camera.sourceType === "jpeg" || camera.sourceType === "hls") {
    const url = new URL(camera.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error(`${camera.camId}: sourceUrl must be HTTPS without embedded credentials`);
    }
  } else {
    throw new Error(`${camera.camId}: sourceType must be youtube, jpeg, or hls`);
  }
}

console.log(`Validated ${cameras.length} camera${cameras.length === 1 ? "" : "s"} (${cameras.filter((camera) => camera.enabled).length} enabled).`);
if (flags.includes("--dry-run")) process.exit(0);

const convexCli = fileURLToPath(new URL("../node_modules/convex/bin/main.js", import.meta.url));
for (const camera of cameras) {
  const result = spawnSync(process.execPath, [convexCli, "run", "cameras:upsert", JSON.stringify(camera)], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(`Registered ${camera.camId}`);
}
