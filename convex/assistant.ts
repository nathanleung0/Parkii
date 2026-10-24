"use node";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Candidate } from "./parking";

const Choice = z.object({
  stallLabel: z.string().nullable(), // null when nothing fits the request
  reply: z.string(), // one short sentence to speak to the driver
});

const SYSTEM = `You are ParkSight, a hands-free parking assistant for drivers in San Francisco's Castro neighborhood.
You get the driver's spoken request and a list of street parking stalls that public traffic cameras currently see as open.
Pick the stall that best fits the request (usually the nearest; respect stated preferences like "near the theater" or "on 18th").
The reply is read aloud while the driver is driving: one sentence, under 25 words, no lists, no markdown.
Be honest about uncertainty: camera data can be stale or wrong, so if the chosen stall's data is older than 30 seconds or confidence is below 1.0, say it may have changed.
If no stall fits, set stallLabel to null and say so briefly.`;

type HeldSpot = Candidate & { expiresAt: number };
type AskResult = { spot: HeldSpot | null; reply: string };

function describe(c: Candidate) {
  return `${c.label}: ${c.camera}, ${c.distanceM} m away, seen open ${c.ageS}s ago, confidence ${c.confidence.toFixed(2)}`;
}

// Driver says something like "find me parking near the Castro Theatre".
export const ask = action({
  args: { text: v.string(), lat: v.number(), lng: v.number(), sessionId: v.string() },
  handler: async (ctx, { text, lat, lng, sessionId }): Promise<AskResult> => {
    const candidates: Candidate[] = await ctx.runQuery(internal.parking.candidates, { lat, lng, sessionId });
    if (candidates.length === 0) {
      return { spot: null, reply: "I don't see any open spots on the cameras right now. Try again in a minute." };
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
  },
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
