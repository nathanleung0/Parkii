import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Bundle only the pure TS helper in memory; Node never executes the UI or makes
// backend requests, and extensionless production imports remain unchanged.
const bundle = await build({ entryPoints: ["src/coverageFreshness.ts"], bundle: true,
  write: false, platform: "node", format: "esm" });
const { deriveCoverageFreshness } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const maxAge = 90_000;
const origin = [0, 0];
const observedAt = 1_000_000;
const coverage = { observedStalls: 1, freshStalls: 1, radiusM: 600 };
const stall = (extra = {}) => ({ lat: 0, lng: 0, updatedAt: observedAt, status: "open", ...extra });
const derive = (stalls, now, bounds = coverage) =>
  deriveCoverageFreshness(bounds, stalls, origin, now, maxAge);

test("the same observations become stale as time passes without a data mutation", () => {
  const rows = [stall()];
  assert.equal(derive(rows, observedAt + 1_000).tone, "fresh");
  const stale = derive(rows, observedAt + 120_000);
  assert.equal(stale.tone, "delayed");
  assert.equal(stale.freshStalls, 0);
  assert.match(stale.noResultMessage, /data is stale/);
  assert.equal(coverage.freshStalls, 1); // cached server count is deliberately unchanged
  assert.equal(rows[0].updatedAt, observedAt);
});

test("90 seconds is stale, matching the server's strict freshness threshold", () => {
  for (const [age, expected] of [[89_999, "fresh"], [90_000, "delayed"], [90_001, "delayed"]]) {
    assert.equal(derive([stall()], observedAt + age).tone, expected);
  }
});

test("fresh map stalls outside the 600 m search radius cannot mask stale coverage", () => {
  // Roughly 1.1 km: inside the 1.6 km map radius, outside the 600 m search radius.
  const far = stall({ lat: .01 });
  const nearStale = stall({ updatedAt: observedAt - 120_000 });
  assert.equal(derive([nearStale, far], observedAt).tone, "delayed");
  assert.equal(derive([nearStale, far], observedAt).freshStalls, 0);
  assert.equal(derive([stall(), far], observedAt).freshStalls, 1);
});

test("loading remains checking rather than showing empty or falsely fresh coverage", () => {
  assert.equal(derive(undefined, observedAt).tone, "checking");
  assert.equal(deriveCoverageFreshness(undefined, [], origin, observedAt, maxAge).tone, "checking");
  assert.equal(derive(undefined, observedAt, { observedStalls: 0, radiusM: 600 }).tone, "checking");
});

test("loaded empty coverage is distinct from monitored coverage with no fresh observations", () => {
  const none = derive([], observedAt, { observedStalls: 0, radiusM: 600 });
  assert.equal(none.tone, "none");
  assert.match(none.noResultMessage, /within 600 m/);
  assert.equal(derive([], observedAt).tone, "delayed");
});

test("unknown, unobserved and invalid timestamps never advertise recent coverage", () => {
  const rows = [stall({ status: "unknown" }), stall({ updatedAt: 0 }), stall({ updatedAt: Infinity })];
  assert.equal(derive(rows, observedAt).freshStalls, 0);
});
