import type { ConversationToken, VoiceMode, VoiceService } from "@/server/voice";

/** A configurable stand-in for ElevenLabs. Holds a pretend API key so tests can prove it never leaks. */
export const FAKE_ELEVEN_KEY = "sk_test_ELEVEN_SECRET_0123456789abcdef";

export interface FakeVoice extends VoiceService {
  tokensIssued: number;
  /** What ElevenLabs "recorded" the user saying, per conversation id. null = not available yet. */
  official: Map<string, string[] | null>;
  spoken: string[];
}

export function fakeVoice(mode: VoiceMode = "agent"): FakeVoice {
  let n = 0;
  const v: FakeVoice = {
    mode,
    agentId: mode === "agent" ? "agent_test" : null,
    notes: [],
    tokensIssued: 0,
    official: new Map(),
    spoken: [],
    async speak(text) {
      v.spoken.push(text);
      return { audio: Buffer.from("audio"), mimeType: "audio/mpeg" };
    },
    async transcribe() {
      return "recorded words";
    },
    async getConversationToken(): Promise<ConversationToken> {
      v.tokensIssued++;
      n++;
      return { token: `conv_token_${n}`, conversationId: `conv_${n}` };
    },
    async getUserUtterances(id) {
      return v.official.get(id) ?? null;
    },
  };
  return v;
}
