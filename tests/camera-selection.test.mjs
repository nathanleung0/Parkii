import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["convex/cameraSelection.ts"], bundle: true,
  write: false, platform: "node", format: "esm" });
const { selectCameraViews } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const castro = { lat: 37.7612, lng: -122.43492, name: "Castro" };
const midtown = { lat: 40.7558, lng: -73.9864, name: "Midtown" };

test("a pin outside the camera radius gets the nearest configured view, marked distant", () => {
  const result = selectCameraViews([castro], 37.77, -122.48);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "Castro");
  assert.equal(result[0].nearby, false);
  assert.ok(result[0].distanceM > 1600);
});

test("camera suggestions never jump across cities or include disabled cameras", () => {
  assert.deepEqual(selectCameraViews([castro], midtown.lat, midtown.lng), []);
  assert.deepEqual(selectCameraViews([{ ...midtown, enabled: false }], midtown.lat, midtown.lng), []);
});

test("nearby views are ordered by distance and marked nearby", () => {
  const result = selectCameraViews([castro, { ...castro, name: "closer", lat: 37.7615 }], 37.7615, -122.43492);
  assert.deepEqual(result.map((camera) => camera.name), ["closer", "Castro"]);
  assert.ok(result.every((camera) => camera.nearby));
});
