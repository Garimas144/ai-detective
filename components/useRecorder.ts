"use client";

// Microphone recording for spoken answers. Needs a secure context (HTTPS or localhost).
// The recording is sent to the host, which transcribes it with ElevenLabs.

import { useCallback, useRef, useState } from "react";

const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function micSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);

  const start = useCallback(async () => {
    stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickMimeType();
    const r = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.start(250);
    recorder.current = r;
    setRecording(true);
  }, []);

  /** Stops recording and returns the audio (or null if nothing was recording). */
  const stop = useCallback(
    () =>
      new Promise<{ blob: Blob; mimeType: string } | null>((resolve) => {
        const r = recorder.current;
        if (!r || r.state === "inactive") return resolve(null);
        r.onstop = () => {
          stream.current?.getTracks().forEach((t) => t.stop());
          const mimeType = r.mimeType || "audio/webm";
          resolve({ blob: new Blob(chunks.current, { type: mimeType }), mimeType });
          recorder.current = null;
          setRecording(false);
        };
        r.stop();
      }),
    [],
  );

  return { recording, start, stop };
}
