// ElevenLabs on the server. The API key lives only here and never reaches a browser.
//
// Voice modes, decided at startup by checking with ElevenLabs (see createVerifiedVoiceService):
//   agent    A real ElevenLabs Conversational AI (Agents) session on the player's phone. The phone gets only a
//            short-lived conversation token from us. The agent speaks the ONE question the game engine chose
//            and listens to the ONE answer. It never decides what to ask.
//   stt-tts  Fallback. The phone records audio, we transcribe it (Scribe) and the host screen speaks the
//            question with text-to-speech. Not the Conversational AI product.
//   text     Fallback. Players type.
//
// In every mode the authoritative testimony is the final transcript text recorded by the game server.

import { VOICE } from "../lib/config";
import { readAloudMs } from "../lib/voiceTiming";

export { readAloudMs };

export type VoiceMode = "agent" | "stt-tts" | "text";

export interface ConversationToken {
  token: string;
  conversationId?: string;
}

export interface VoiceService {
  mode: VoiceMode;
  /** The agent this server issues tokens for (agent mode only). */
  agentId: string | null;
  /** Human-readable startup notes (never contain keys). */
  notes: string[];
  /** text-to-speech for the host screen (accusation, and questions in stt-tts mode). */
  speak(text: string): Promise<{ audio: Buffer; mimeType: string }>;
  /** speech-to-text for a phone recording (stt-tts mode). */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
  /** Short-lived credential for one Conversational AI session. Agent mode only. */
  getConversationToken(): Promise<ConversationToken>;
  /**
   * ElevenLabs' own record of what the user said in a conversation, used to cross-check what the phone reports.
   * Returns null when it isn't available yet.
   */
  getUserUtterances(conversationId: string): Promise<string[] | null>;
}

const API = "https://api.elevenlabs.io/v1";
type FetchFn = typeof fetch;

export interface VoiceConfig {
  apiKey: string;
  agentId?: string;
  voiceId?: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}

class ElevenLabsVoice implements VoiceService {
  agentId: string | null;
  private base: string;
  private f: FetchFn;
  private voiceId: string;

  constructor(
    private apiKey: string,
    public mode: VoiceMode,
    public notes: string[],
    cfg: VoiceConfig,
  ) {
    this.agentId = mode === "agent" ? cfg.agentId ?? null : null;
    this.base = (cfg.baseUrl ?? API).replace(/\/+$/, "");
    this.f = cfg.fetchFn ?? fetch;
    this.voiceId = cfg.voiceId || VOICE.defaultDetectiveVoiceId;
  }

  private headers(json = false): Record<string, string> {
    return { "xi-api-key": this.apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
  }

  async speak(text: string) {
    const res = await this.f(`${this.base}/text-to-speech/${this.voiceId}?output_format=${VOICE.outputFormat}`, {
      method: "POST",
      headers: { ...this.headers(true), Accept: "audio/mpeg" },
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
    const res = await this.f(`${this.base}/speech-to-text`, { method: "POST", headers: this.headers(), body: form });
    if (!res.ok) throw new Error(`ElevenLabs STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }

  async getConversationToken(): Promise<ConversationToken> {
    if (!this.agentId) throw new Error("Agent voice is not configured (set ELEVENLABS_AGENT_ID).");
    const res = await this.f(`${this.base}/convai/conversation/token?agent_id=${encodeURIComponent(this.agentId)}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`ElevenLabs conversation token ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { token?: string; conversation_id?: string };
    if (!json.token) throw new Error("ElevenLabs returned no conversation token.");
    return { token: json.token, conversationId: json.conversation_id };
  }

  async getUserUtterances(conversationId: string): Promise<string[] | null> {
    const res = await this.f(`${this.base}/convai/conversations/${encodeURIComponent(conversationId)}`, { headers: this.headers() });
    if (!res.ok) return null;
    const json = (await res.json()) as { transcript?: { role?: string; message?: string | null }[] };
    if (!Array.isArray(json.transcript)) return null;
    return json.transcript.filter((t) => t.role === "user" && t.message?.trim()).map((t) => t.message!.trim());
  }
}

class TextOnlyVoice implements VoiceService {
  mode: VoiceMode = "text";
  agentId = null;
  constructor(public notes: string[]) {}
  async speak(): Promise<never> {
    throw new Error("Voice is off.");
  }
  async transcribe(): Promise<never> {
    throw new Error("Voice is off. Type your answer instead.");
  }
  async getConversationToken(): Promise<never> {
    throw new Error("Voice is off.");
  }
  async getUserUtterances(): Promise<null> {
    return null;
  }
}

async function errorDetail(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: { message?: string } | string } | null;
  return typeof body?.detail === "string" ? body.detail : body?.detail?.message ?? `HTTP ${res.status}`;
}

/**
 * Checks with ElevenLabs which voice mode actually works, so the game never advertises voice it can't deliver:
 * key rejected -> text; key ok and agent reachable -> agent; key ok, no working agent -> stt-tts.
 * Never logs a key.
 */
export async function createVerifiedVoiceService(cfg?: Partial<VoiceConfig>): Promise<VoiceService> {
  const apiKey = (cfg?.apiKey ?? process.env.ELEVENLABS_API_KEY ?? "").trim();
  const agentId = (cfg?.agentId ?? process.env.ELEVENLABS_AGENT_ID ?? "").trim();
  const voiceId = cfg?.voiceId ?? process.env.ELEVENLABS_DETECTIVE_VOICE_ID?.trim();
  const f = cfg?.fetchFn ?? fetch;
  // ELEVENLABS_API_BASE (an origin, no /v1) exists only so tests can point at a local fake. Never set it in a real run.
  const origin = (process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "");
  const base = (cfg?.baseUrl ?? `${origin}/v1`).replace(/\/+$/, "");
  const full: VoiceConfig = { apiKey, agentId, voiceId, fetchFn: f, baseUrl: base };

  if (!apiKey) return new TextOnlyVoice(["ELEVENLABS_API_KEY is not set: players type their answers."]);

  try {
    const res = await f(`${base}/user`, { headers: { "xi-api-key": apiKey } });
    if (!res.ok) return new TextOnlyVoice([`ElevenLabs rejected ELEVENLABS_API_KEY (${await errorDetail(res)}): players type their answers.`]);
  } catch (err) {
    return new TextOnlyVoice([`Couldn't reach ElevenLabs (${err instanceof Error ? err.message : err}): players type their answers.`]);
  }

  if (!agentId) {
    return new ElevenLabsVoice(apiKey, "stt-tts", ["ELEVENLABS_AGENT_ID is not set: using the recorder + text-to-speech fallback, NOT the conversational agent."], full);
  }
  try {
    const res = await f(`${base}/convai/agents/${encodeURIComponent(agentId)}`, { headers: { "xi-api-key": apiKey } });
    if (res.ok) return new ElevenLabsVoice(apiKey, "agent", [`Conversational agent ${agentId} reachable.`], full);
    return new ElevenLabsVoice(apiKey, "stt-tts", [`ELEVENLABS_AGENT_ID ${agentId} isn't usable (${await errorDetail(res)}): using the recorder + text-to-speech fallback.`], full);
  } catch (err) {
    return new ElevenLabsVoice(apiKey, "stt-tts", [`Couldn't check the agent (${err instanceof Error ? err.message : err}): using the recorder + text-to-speech fallback.`], full);
  }
}

/** In agent mode the phone must also connect a WebRTC session before the question is heard. */
export function questionLeadMs(mode: VoiceMode): ((text: string) => number) | undefined {
  if (mode === "text") return undefined;
  if (mode === "agent") return (text) => readAloudMs(text) + VOICE.agentConnectMs;
  return readAloudMs;
}
