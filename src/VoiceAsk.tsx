import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type AskResult = FunctionReturnType<typeof api.assistant.ask>;

const MAX_RECORD_MS = 12_000; // Cartesia path accepts up to ~15 s / 1 MB

// Hands-free "find me parking near X": mic -> Cartesia speech-to-text -> Claude picks a spot ->
// Cartesia text-to-speech. Typed input and browser voices remain as fallbacks when keys are missing.
export function VoiceAsk({
  lat,
  lng,
  sessionId,
  onResult,
}: {
  lat: number;
  lng: number;
  sessionId: string;
  onResult: (r: AskResult) => void;
}) {
  const ask = useAction(api.assistant.ask);
  const speak = useAction(api.assistant.speak);
  const transcribe = useAction(api.assistant.transcribe);
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stopTimer = useRef<number | undefined>(undefined);

  const canRecord = typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  useEffect(() => () => window.clearTimeout(stopTimer.current), []);

  async function submit(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await ask({ text: q, lat, lng, sessionId });
      setReply(r.reply);
      onResult(r);
      await say(r.reply);
    } catch (e) {
      setReply(`Sorry, something went wrong: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function say(line: string) {
    try {
      const wav = await speak({ text: line });
      if (wav) {
        const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
        await new Audio(url).play();
        return;
      }
    } catch (e) {
      console.warn("Cartesia TTS failed, using browser voice", e);
    }
    window.speechSynthesis?.speak(new SpeechSynthesisUtterance(line));
  }

  async function startRecording() {
    setReply(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setReply("I can't use the microphone. Allow mic access or type your request.");
      return;
    }
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      window.clearTimeout(stopTimer.current);
      setRecording(false);
      const type = rec.mimeType || "audio/webm";
      setBusy(true);
      try {
        const audio = await new Blob(chunks, { type }).arrayBuffer();
        const heard = await transcribe({ audio, mimeType: type });
        setText(heard);
        setBusy(false);
        await submit(heard);
      } catch (e) {
        setBusy(false);
        setReply((e as Error).message.replace(/^.*Uncaught Error: /s, "").split("\n")[0]);
      }
    };
    recorder.current = rec;
    rec.start();
    setRecording(true);
    stopTimer.current = window.setTimeout(() => rec.state === "recording" && rec.stop(), MAX_RECORD_MS);
  }

  function toggleMic() {
    if (recording) recorder.current?.stop();
    else void startRecording();
  }

  return (
    <div className="voice">
      <form
        className="find-row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(text);
        }}
      >
        <button
          type="button"
          className={recording ? "mic on" : "mic"}
          onClick={toggleMic}
          disabled={!canRecord || (busy && !recording)}
          title={canRecord ? (recording ? "Stop and send" : "Speak your request") : "Microphone not available in this browser"}
        >
          🎙
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={recording ? "Listening… tap the mic to send" : 'Try "parking near this pin"'}
        />
        <button type="submit" className="ghost" disabled={busy || recording}>{busy ? "…" : "Ask"}</button>
      </form>
      {reply && <p className="reply">“{reply}”</p>}
    </div>
  );
}
