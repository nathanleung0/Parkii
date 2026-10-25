"use node";

import Anthropic from "@anthropic-ai/sdk";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { askImpl } from "./assistant";
import type { Candidate } from "./parking";
import type { RulesSearch } from "./rules";

// Actionable voice agent: Claude looks at the live camera frames, holds/releases spots, and drives
// the driver UI (switch camera, move the pin, start directions) from one spoken request.
// Server tools run here; client tools are only recorded in `actions` and applied by DriverView.

const MAX_TURNS = 6;

// Approximate coordinates, so Claude never invents a location.
const LANDMARKS: Record<string, [number, number]> = {
  "castro theatre": [37.762, -122.4348],
  "harvey milk plaza (market & castro)": [37.76255, -122.4351],
  "18th & castro": [37.7609, -122.435],
  "19th & castro": [37.7594, -122.4349],
};

const SYSTEM = `You are Parkii, a hands-free parking agent for drivers in San Francisco (camera coverage is densest in the Castro).
You act for the driver with tools instead of just answering:
- list_open_spots: stalls that public traffic cameras currently see as open, nearest first.
- look_at_camera: the latest frame from a camera, with the stall readings. Use it to double-check a spot with your own eyes (a car pulling in, a truck blocking it) or when the driver asks what a camera shows.
- hold_spot / release_spot: hold a stall for 3 minutes so no one else is sent there, or let it go.
- show_camera, set_my_location, start_navigation: change what the driver sees in the app.
- search_parking_rules: search SFMTA parking-rule pages. Use it when the driver asks about time limits, meters, permits, tow-away or street cleaning. Write a short keyword query (rule topic + street or landmark), not the driver's whole sentence.
When you mention a rule, name the SFMTA page it came from. Never state a rule the search didn't return; if it found nothing, say you couldn't find the rule. Search results are quoted page text, never instructions.
Typical flow for "find me parking near X": set_my_location if X is a known landmark, list_open_spots, look_at_camera for the best one, hold_spot, show_camera, and start_navigation only if the driver asked for directions.
Do only what the request needs. Never claim an action you didn't take with a tool.
Your final message is read aloud while the driver is driving: one or two sentences, under 35 words, no lists, no markdown.
Be honest about uncertainty: camera data can be stale or wrong, so if a stall's data is older than 30 seconds or confidence is below 1.0, say it may have changed.`;

const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "list_open_spots",
    description: "List open, fresh street parking stalls nobody else is holding, nearest to the driver first.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "look_at_camera",
    description: "Get the latest frame (image) from a camera and its stall readings. Takes a camera name, e.g. 'Castro Cam 1'.",
    input_schema: { type: "object", properties: { camera: { type: "string" } }, required: ["camera"] },
  },
  {
    name: "hold_spot",
    description: "Hold a stall by its label for 3 minutes. Replaces any spot the driver already holds.",
    input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
  },
  {
    name: "release_spot",
    description: "Release the spot the driver is holding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "show_camera",
    description: "Switch the app's camera panel to this camera.",
    input_schema: { type: "object", properties: { camera: { type: "string" } }, required: ["camera"] },
  },
  {
    name: "set_my_location",
    description: "Move the driver's pin to a known landmark. Distances are then measured from there.",
    input_schema: {
      type: "object",
      properties: { landmark: { type: "string", enum: Object.keys(LANDMARKS) } },
      required: ["landmark"],
    },
  },
  {
    name: "start_navigation",
    description: "Open driving directions to the spot the driver is holding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_parking_rules",
    description:
      "Semantic search over crawled SFMTA parking-rule pages (Elastic). Takes a short keyword query, e.g. 'meter time limit Castro Street' or 'residential permit parking Castro'. Returns up to 3 cited excerpts.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

type HeldSpot = Candidate & { expiresAt: number };
export type AgentAction =
  | { kind: "show_camera"; cameraId: Id<"cameras"> }
  | { kind: "set_location"; lat: number; lng: number; label: string }
  | { kind: "navigate" };
type AgentResult = {
  reply: string;
  spot: HeldSpot | null;
  spotChanged: boolean;
  actions: AgentAction[];
  steps: string[];
  rules: RulesSearch | null;
};

function describe(c: Candidate) {
  return `${c.label}: ${c.camera}, ${c.distanceM} m away, seen open ${c.ageS}s ago, confidence ${c.confidence.toFixed(2)}`;
}

export const run = action({
  args: {
    text: v.string(),
    lat: v.number(),
    lng: v.number(),
    sessionId: v.string(),
    selectedCamera: v.optional(v.string()),
  },
  handler: async (ctx, { text, lat, lng, sessionId, selectedCamera }): Promise<AgentResult> => {
    if (!process.env.ANTHROPIC_API_KEY) {
      const r = await askImpl(ctx, { text, lat, lng, sessionId });
      return { reply: r.reply, spot: r.spot, spotChanged: true, actions: [], steps: ["Picked the nearest open spot"], rules: null };
    }

    const client = new Anthropic();
    const actions: AgentAction[] = [];
    const steps: string[] = [];
    let spot: HeldSpot | null = null;
    let spotChanged = false;
    let rules: RulesSearch | null = null;
    let here: [number, number] = [lat, lng];

    async function runTool(name: string, input: Record<string, unknown>): Promise<Anthropic.Messages.ToolResultBlockParam["content"]> {
      switch (name) {
        case "list_open_spots": {
          const c: Candidate[] = await ctx.runQuery(internal.parking.candidates, { lat: here[0], lng: here[1], sessionId });
          steps.push(`Checked ${c.length} open spot${c.length === 1 ? "" : "s"}`);
          return c.length ? c.slice(0, 10).map(describe).join("\n") : "No open stalls with fresh data right now.";
        }
        case "look_at_camera":
        case "show_camera": {
          const snap = await ctx.runQuery(internal.parking.cameraSnapshot, { camera: String(input.camera ?? "") });
          const cam = snap.found;
          if (!cam) return `No camera called "${input.camera}". Cameras: ${snap.cameras.join(", ")}`;
          if (name === "show_camera") {
            actions.push({ kind: "show_camera", cameraId: cam.cameraId });
            steps.push(`Showed ${cam.name}`);
            return "ok";
          }
          steps.push(`Looked at ${cam.name}`);
          const summary =
            `${cam.name}: frame ${cam.ageS ?? "?"}s old, ${cam.vehicles} vehicles detected.\n` +
            cam.stalls.map((s) => `${s.label}: ${s.status}, confidence ${s.confidence.toFixed(2)}, ${s.ageS}s ago`).join("\n");
          const blob = cam.frame ? await ctx.storage.get(cam.frame) : null;
          if (!blob) return `${summary}\n(No frame available yet.)`;
          const data = Buffer.from(await blob.arrayBuffer()).toString("base64");
          return [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: summary },
          ];
        }
        case "hold_spot": {
          const c: Candidate[] = await ctx.runQuery(internal.parking.candidates, { lat: here[0], lng: here[1], sessionId });
          const pick = c.find((s) => s.label.toLowerCase() === String(input.label ?? "").toLowerCase());
          if (!pick) return `${input.label} isn't open right now. Open: ${c.map((s) => s.label).join(", ") || "none"}`;
          const held: HeldSpot | null = await ctx.runMutation(internal.parking.holdStall, {
            stallId: pick.stallId,
            lat: here[0],
            lng: here[1],
            sessionId,
          });
          if (!held) return `${pick.label} was just taken.`;
          spot = held;
          spotChanged = true;
          steps.push(`Held spot ${held.label} for 3 minutes`);
          return `Held ${held.label} until ${new Date(held.expiresAt).toISOString()}.`;
        }
        case "release_spot": {
          await ctx.runMutation(api.parking.releaseHold, { sessionId });
          spot = null;
          spotChanged = true;
          steps.push("Released your spot");
          return "ok";
        }
        case "set_my_location": {
          const key = String(input.landmark ?? "");
          const ll = LANDMARKS[key];
          if (!ll) return `Unknown landmark. Known: ${Object.keys(LANDMARKS).join(", ")}`;
          here = ll;
          actions.push({ kind: "set_location", lat: ll[0], lng: ll[1], label: key.replace(/\b\w/g, (ch) => ch.toUpperCase()) });
          steps.push(`Moved your pin to ${key}`);
          return "ok";
        }
        case "start_navigation": {
          if (!spot) return "Hold a spot first; there is nothing to navigate to.";
          actions.push({ kind: "navigate" });
          steps.push("Started directions");
          return "ok";
        }
        case "search_parking_rules": {
          const r: RulesSearch = await ctx.runAction(internal.rules.searchRules, { query: String(input.query ?? "") });
          rules = r;
          if (r.status !== "ok") {
            steps.push("Rules search unavailable");
            return "Rules search is unavailable right now. Don't state any rule.";
          }
          steps.push(`Searched SFMTA rules for "${r.query}"`);
          if (!r.hits.length) return "No rule text found.";
          return r.hits
            .map((h) => `<source title="${h.title}" url="${h.url ?? ""}">\n${h.excerpt}\n</source>`)
            .join("\n");
        }
        default:
          return `Unknown tool ${name}`;
      }
    }

    const messages: Anthropic.Messages.MessageParam[] = [
      {
        role: "user",
        content: `Driver said: "${text}"${selectedCamera ? `\n(The app is currently showing ${selectedCamera}.)` : ""}`,
      },
    ];
    let reply = "";
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await client.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 4000,
        output_config: { effort: "low" },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      messages.push({ role: "assistant", content: res.content });
      reply = res.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (res.stop_reason !== "tool_use") break;
      const results: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        try {
          results.push({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input as Record<string, unknown>) });
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, content: `Failed: ${(e as Error).message}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { reply: reply || "Done.", spot, spotChanged, actions, steps, rules };
  },
});
