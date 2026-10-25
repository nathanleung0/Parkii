"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Candidate } from "./parking";

const Choice = z.object({
  stallLabel: z.string().nullable(), // null when nothing fits the request
  reply: z.string(), // one short sentence to speak to the driver
});

const SYSTEM = `You are ParkSight, a hands-free parking assistant for drivers in San Francisco.
You get the driver's spoken request and a list of street parking stalls that public traffic cameras currently see as open.
Pick the stall that best fits the request (usually the nearest; respect stated preferences like "near the theater" or "on 18th").
The reply is read aloud while the driver is driving: one sentence, under 25 words, no lists, no markdown.
Be honest about uncertainty: camera data can be stale or wrong, so if the chosen stall's data is older than 30 seconds or confidence is below 1.0, say it may have changed.
If no stall fits, set stallLabel to null and say so briefly.`;

type HeldSpot = Candidate & { expiresAt: number };
type AskResult = { spot: HeldSpot | null; reply: string };
type AskArgs = { text: string; lat: number; lng: number; sessionId: string };

function describe(c: Candidate) {
  return `${c.label}: ${c.camera}, ${c.distanceM} m away, processed ${c.ageS}s ago, detection agreement ${c.confidence.toFixed(2)}`;
}

// Shared by the web app (`ask`) and the Fetch.ai agent (`askCore`, via POST /agent/find).
async function askImpl(ctx: ActionCtx, { text, lat, lng, sessionId }: AskArgs): Promise<AskResult> {
  const candidates: Candidate[] = await ctx.runQuery(internal.parking.candidates, { lat, lng, sessionId });
  if (candidates.length === 0) {
    const coverage = await ctx.runQuery(internal.parking.agentCoverage, { lat, lng });
    return {
      spot: null,
      reply: coverage.observedStalls === 0
        ? "I don't have camera coverage within six hundred meters of that location yet."
        : coverage.freshStalls === 0
          ? "The nearby cameras are stale right now. Try again later."
          : "I don't see any open spots on the nearby cameras right now.",
    };
  }

  let pick: Candidate | undefined = candidates[0];
  let reply = `Nearest open spot is ${pick.label} on ${pick.camera}, about ${pick.distanceM} meters away.`;

  if (process.env.ANTHROPIC_API_KEY) {
    const client = new Anthropic();
    const response = await client.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low", format: zodOutputFormat(Choice) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Driver said: "${text}"\n\nOpen stalls (nearest first):\n${candidates.slice(0, 10).map(describe).join("\n")}`,
        },
      ],
    });
    const choice = response.stop_reason === "refusal" ? null : response.parsed_output;
    if (choice) {
      pick = choice.stallLabel ? candidates.find((c) => c.label === choice.stallLabel) : undefined;
      reply = choice.reply;
    }
  }

  if (!pick) return { spot: null, reply };
  const spot: HeldSpot | null = await ctx.runMutation(internal.parking.holdStall, {
    stallId: pick.stallId,
    lat,
    lng,
    sessionId,
  });
  if (!spot) return { spot: null, reply: "That spot was just taken. Ask me again for another one." };
  return { spot, reply };
}

const askArgs = { text: v.string(), lat: v.number(), lng: v.number(), sessionId: v.string() };

// Driver says something like "find me parking near the Castro Theatre".
export const ask = action({
  args: askArgs,
  handler: (ctx, args): Promise<AskResult> => askImpl(ctx, args),
});

export const askCore = internalAction({
  args: askArgs,
  handler: (ctx, args): Promise<AskResult> => askImpl(ctx, args),
});

// Cartesia text-to-speech. Returns WAV bytes, or null when no key is configured.
export const speak = action({
  args: { text: v.string() },
  handler: async (_ctx, { text }): Promise<ArrayBuffer | null> => {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) return null;
    const res = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Cartesia-Version": "2026-08-14",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: "sonic-3.6",
        transcript: text,
        voice: { id: process.env.CARTESIA_VOICE_ID ?? "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4" },
        output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 24000 },
      }),
    });
    if (!res.ok) throw new Error(`Cartesia ${res.status}: ${await res.text()}`);
    return res.arrayBuffer();
  },
});

// --- Cartesia speech-to-text (ported from Vortex apps/desktop/electron/voice.mjs) ---------------

const MAX_AUDIO_BYTES = 1024 * 1024; // short commands only: ~15 s
const STT_TIMEOUT_MS = 20_000;
const MAX_TRANSCRIPT_CHARS = 2400;

function audioExtension(bytes: Uint8Array, mimeType: string): "webm" | "ogg" | "wav" | null {
  const type = mimeType.split(";")[0];
  const magic = Array.from(bytes.slice(0, 4)).join();
  if (type === "audio/webm" && magic === "26,69,223,163") return "webm";
  if (type === "audio/ogg" && magic === "79,103,103,83") return "ogg";
  if (
    type === "audio/wav" &&
    magic === "82,73,70,70" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  ) {
    return "wav";
  }
  return null;
}

// Returns the transcript, or throws an Error with a message that is safe to show the driver
// (provider bodies can contain private details, so they are never echoed).
export const transcribe = action({
  args: { audio: v.bytes(), mimeType: v.string() },
  handler: async (_ctx, { audio, mimeType }): Promise<string> => {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error("Voice isn't set up yet. Type your request instead.");
    const bytes = new Uint8Array(audio);
    if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) {
      throw new Error("Record a short request, up to 15 seconds.");
    }
    const ext = audioExtension(bytes, mimeType);
    if (!ext) throw new Error("That recording format isn't supported. Try again or type your request.");

    const body = new FormData();
    body.set("file", new Blob([bytes], { type: mimeType.split(";")[0] }), `request.${ext}`);
    body.set("model", "ink-whisper");
    body.set("language", "en");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
    try {
      const res = await fetch("https://api.cartesia.ai/stt", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Cartesia-Version": "2026-08-14" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) throw new Error("Voice key was rejected. Type your request instead.");
      if (res.status === 429) throw new Error("Voice is busy right now. Type your request instead.");
      if (!res.ok) throw new Error("Couldn't transcribe that. Try again or type your request.");
      const value = (await res.json()) as { text?: unknown };
      const text = typeof value.text === "string" ? value.text.trim() : "";
      if (!text || text.length > MAX_TRANSCRIPT_CHARS) throw new Error("I didn't catch that. Try again or type your request.");
      return text;
    } catch (e) {
      if (controller.signal.aborted) throw new Error("Transcription timed out. Try again or type your request.");
      if (e instanceof Error && !e.message.startsWith("fetch")) throw e;
      throw new Error("Couldn't reach the voice service. Type your request instead.");
    } finally {
      clearTimeout(timer);
    }
  },
});
