import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["convex/occupancy.ts"], bundle: true,
  write: false, platform: "node", format: "esm" });
const { classifyStallFrame, nextStallState } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const stall = [[0.2, 0.7], [0.6, 0.7], [0.6, 1], [0.2, 1]];
const vehicle = (score, classId = 2, x1 = .25) => [x1, .4, x1 + .25, .95, score, classId];

test("weak vehicle candidates make a stall unknown instead of taken or open", () => {
  assert.equal(classifyStallFrame(stall, [vehicle(.4)]), "uncertain");
  assert.deepEqual(nextStallState([false, false, false], "uncertain"),
    { status: "unknown", history: [], confidence: 0 });
});

test("strong candidate needs three consistent frames before showing taken", () => {
  const evidence = classifyStallFrame(stall, [vehicle(.9)]);
  assert.equal(evidence, "occupied");
  const one = nextStallState([], evidence);
  const two = nextStallState(one.history, evidence);
  const three = nextStallState(two.history, evidence);
  assert.equal(one.status, "unknown");
  assert.equal(two.status, "unknown");
  assert.equal(three.status, "taken");
});

test("empty stall needs three clear frames before showing open", () => {
  let state = { history: [] };
  for (let i = 0; i < 2; i++) state = nextStallState(state.history, "clear");
  assert.equal(state.status, "unknown");
  state = nextStallState(state.history, "clear");
  assert.equal(state.status, "open");
});

test("people and distant boxes do not occupy a stall", () => {
  assert.equal(classifyStallFrame(stall, [vehicle(.99, 0)]), "clear");
  assert.equal(classifyStallFrame(stall, [vehicle(.99, 2, .75)]), "clear");
});

test("mixed recent evidence is not advertised as a parking result", () => {
  const state = nextStallState([true, true], "clear");
  assert.equal(state.status, "unknown");
  assert.equal(state.confidence, 0);
});
