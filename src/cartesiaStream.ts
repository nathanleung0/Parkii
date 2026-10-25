// Streams Cartesia sonic-3.6 speech over WebSocket and plays each PCM chunk as it arrives, so the
// reply starts in a few hundred ms instead of after the whole WAV. The browser only ever holds a
// 5-minute access token from `assistant.voiceToken`; the API key stays on Convex.

type Token = { token: string; voiceId: string; expiresAt: number };

const SAMPLE_RATE = 24_000;
const VERSION = "2026-08-14";

let cached: Token | null = null;
let audio: AudioContext | null = null;
let queue: Promise<void> = Promise.resolve();

// Call from a user gesture (mic/Ask click) so the browser lets audio play later.
export function unlockAudio() {
  audio ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  void audio.resume();
}

async function token(getToken: () => Promise<Token | null>): Promise<Token | null> {
  if (cached && cached.expiresAt - Date.now() > 30_000) return cached;
  cached = await getToken();
  return cached;
}

function play(text: string, t: Token): Promise<void> {
  unlockAudio();
  const ctx = audio!;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.cartesia.ai/tts/websocket?access_token=${encodeURIComponent(t.token)}&cartesia_version=${VERSION}`,
    );
    let at = 0; // when the next chunk starts, in AudioContext time
    let started = false;
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          model_id: "sonic-3.6",
          transcript: text,
          voice: { mode: "id", id: t.voiceId },
          language: "en",
          context_id: crypto.randomUUID(),
          output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: SAMPLE_RATE },
          continue: false,
        }),
      );
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; data?: string; error?: string };
      if (msg.type === "chunk" && msg.data) {
        const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
        const samples = new Float32Array(bytes.buffer, 0, bytes.byteLength >> 2);
        const buf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
        buf.copyToChannel(samples, 0);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        at = Math.max(at, ctx.currentTime + 0.05);
        src.start(at);
        at += buf.duration;
        started = true;
      } else if (msg.type === "done") {
        ws.close();
        window.setTimeout(resolve, Math.max(0, (at - ctx.currentTime) * 1000));
      } else if (msg.type === "error") {
        ws.close();
        if (started) resolve();
        else reject(new Error(msg.error ?? "Cartesia stream error"));
      }
    };
    ws.onerror = () => (started ? resolve() : reject(new Error("Cartesia WebSocket failed")));
  });
}

// Queued so a quick "on it" and the final reply never talk over each other.
// Rejects (before any audio played) so the caller can fall back to WAV or the browser voice.
export function speakStream(text: string, getToken: () => Promise<Token | null>): Promise<void> {
  const next = queue.then(async () => {
    const t = await token(getToken);
    if (!t) throw new Error("no Cartesia key");
    await play(text, t);
  });
  queue = next.catch(() => {});
  return next;
}
