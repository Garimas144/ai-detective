// ElevenLabs voice, server side (the API key never leaves the host machine).
//   speak()      detective question / accusation -> audio for the shared screen (text-to-speech)
//   transcribe() a player's recorded answer -> text testimony (speech-to-text)
// With no ELEVENLABS_API_KEY the service is disabled and players type their answers instead.

import { VOICE } from "../lib/config";

export interface VoiceService {
  enabled: boolean;
  speak(text: string): Promise<{ audio: Buffer; mimeType: string }>;
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

const API = "https://api.elevenlabs.io/v1";

class ElevenLabsVoice implements VoiceService {
  enabled = true;
  constructor(
    private apiKey: string,
    private detectiveVoiceId: string,
  ) {}

  async speak(text: string) {
    const res = await fetch(`${API}/text-to-speech/${this.detectiveVoiceId}?output_format=${VOICE.outputFormat}`, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: VOICE.ttsModel }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mimeType: "audio/mpeg" };
  }

  async transcribe(audio: Buffer, mimeType: string) {
    const form = new FormData();
    form.append("model_id", VOICE.sttModel);
    form.append("tag_audio_events", "false");
    const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
    form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType }), `answer.${ext}`);
    const res = await fetch(`${API}/speech-to-text`, { method: "POST", headers: { "xi-api-key": this.apiKey }, body: form });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }
}

class DisabledVoice implements VoiceService {
  enabled = false;
  async speak(): Promise<never> {
    throw new Error("Voice is off (no ELEVENLABS_API_KEY).");
  }
  async transcribe(): Promise<never> {
    throw new Error("Voice is off (no ELEVENLABS_API_KEY). Type your answer instead.");
  }
}

export function createVoiceService(): VoiceService {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return new DisabledVoice();
  return new ElevenLabsVoice(key, process.env.ELEVENLABS_DETECTIVE_VOICE_ID?.trim() || VOICE.defaultDetectiveVoiceId);
}

/**
 * Asks ElevenLabs whether the key works (GET /v1/user) and falls back to "voice off" if not, so players get
 * the typing fallback instead of failing recordings. Never logs the key.
 */
export async function createVerifiedVoiceService(): Promise<VoiceService> {
  const service = createVoiceService();
  if (!service.enabled) return service;
  try {
    const res = await fetch(`${API}/user`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!.trim() } });
    if (res.ok) return service;
    const body = (await res.json().catch(() => null)) as { detail?: { message?: string } | string } | null;
    const detail = typeof body?.detail === "string" ? body.detail : body?.detail?.message ?? `HTTP ${res.status}`;
    console.warn(`[voice] ElevenLabs rejected ELEVENLABS_API_KEY, so voice is off: ${detail}`);
  } catch (err) {
    console.warn(`[voice] Couldn't reach ElevenLabs to check the key, so voice is off: ${err instanceof Error ? err.message : err}`);
  }
  return new DisabledVoice();
}

/** Rough time to read a question aloud, added to the answer deadline when voice is on. */
export function readAloudMs(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil((words / 2.6) * 1000) + 1500;
}
