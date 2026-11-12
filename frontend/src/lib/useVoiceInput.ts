import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice notes via the browser's built-in speech recognition (Web Speech API).
 * Speech is transcribed on the device/browser — no audio is sent to our server or to Claude;
 * only the resulting text goes through the normal agent. Best support: Chrome / Edge.
 *   en-IN → English and Hinglish (Roman script)   hi-IN → Hindi (Devanagari)
 */
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoiceInput(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const supported = typeof window !== "undefined" && getCtor() !== null;

  const stop = useCallback(() => recRef.current?.stop(), []);

  const start = useCallback(
    (lang: "en-IN" | "hi-IN") => {
      const Ctor = getCtor();
      if (!Ctor) return setError("Voice input isn't supported in this browser — try Chrome or Edge.");
      setError(null);
      const rec = new Ctor();
      rec.lang = lang;
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (e) => {
        let finalText = "";
        let partial = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]!;
          if (r.isFinal) finalText += r[0].transcript;
          else partial += r[0].transcript;
        }
        setInterim(partial);
        if (finalText.trim()) onFinal(finalText.trim());
      };
      rec.onerror = (e) =>
        setError(e.error === "not-allowed" ? "Microphone permission was denied." : e.error === "no-speech" ? "Didn't catch that — please try again." : `Voice input error: ${e.error}`);
      rec.onend = () => {
        setListening(false);
        setInterim("");
      };
      recRef.current = rec;
      rec.start();
      setListening(true);
    },
    [onFinal],
  );

  useEffect(() => () => recRef.current?.stop(), []);
  return { supported, listening, interim, error, start, stop };
}
