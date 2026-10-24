import { useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type AskResult = FunctionReturnType<typeof api.assistant.ask>;

// Hands-free "find me parking near X": speech -> Claude picks a spot -> Cartesia speaks.
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
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const recRef = useRef<any>(null);

  const SpeechRecognition = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

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

  function listen() {
    if (!SpeechRecognition) return;
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join("");
      setText(t);
      if (e.results[e.results.length - 1].isFinal) submit(t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    rec.start();
  }

  return (
    <div className="voice">
      <form
        className="find-row"
        onSubmit={(e) => {
          e.preventDefault();
          submit(text);
        }}
      >
        <button
          type="button"
          className={listening ? "mic on" : "mic"}
          onClick={() => (listening ? recRef.current?.stop() : listen())}
          disabled={!SpeechRecognition || busy}
          title={SpeechRecognition ? "Speak your request" : "Speech recognition not supported in this browser"}
        >
          🎙
        </button>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Try "parking near the Castro Theatre"'
        />
        <button type="submit" className="ghost" disabled={busy}>{busy ? "…" : "Ask"}</button>
      </form>
      {reply && <p className="reply">“{reply}”</p>}
    </div>
  );
}
