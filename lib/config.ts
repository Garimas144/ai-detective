// Central config. Model IDs, scoring weights and game rules live here.
// Nebius model IDs: verify with `npm run models` once NEBIUS_API_KEY is set.

export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

const fromEnv = (name: string, fallback: string) => process.env[name]?.trim() || fallback;

/**
 * Nebius model IDs. Each can be overridden in .env.local without editing code, so if `npm run preflight`
 * reports a model as missing you can switch to an available one immediately.
 * Reasoning quality matters for the between-round review and the accusation; latency matters for per-answer extraction.
 */
export const MODELS = {
  /** Per-answer claim extraction. Fast: it runs while players wait. NEBIUS_MODEL_EXTRACT */
  detectiveTurn: fromEnv("NEBIUS_MODEL_EXTRACT", "Qwen/Qwen3-235B-A22B-Instruct-2507"),
  /** Used if the extraction model errors or is unavailable. NEBIUS_MODEL_EXTRACT_FALLBACK */
  detectiveTurnFallback: fromEnv("NEBIUS_MODEL_EXTRACT_FALLBACK", "Qwen/Qwen3-30B-A3B-Instruct-2507"),
  /** Between-round review (contradictions, allocation, early end) and the final accusation. NEBIUS_MODEL_REASONING */
  detectiveReasoning: fromEnv("NEBIUS_MODEL_REASONING", "deepseek-ai/DeepSeek-V4.1-Flash"),
  /** Used if the reasoning model errors or is unavailable. NEBIUS_MODEL_REASONING_FALLBACK */
  detectiveReasoningFallback: fromEnv("NEBIUS_MODEL_REASONING_FALLBACK", "Qwen/Qwen3-235B-A22B-Instruct-2507"),
  /** Post-game reveal narration (knows the truth; runs only after the accusation). */
  revealNarrator: fromEnv("NEBIUS_MODEL_EXTRACT", "Qwen/Qwen3-235B-A22B-Instruct-2507"),
  /** Simulated player agents (M1.5). */
  playerAgent: "openai/gpt-oss-120b",
  /** Cheaper player agent for comparison runs. */
  playerAgentCheap: "Qwen/Qwen3-30B-A3B-Instruct-2507",
} as const;

/** Every model the live game can call, for preflight. */
export const RUNTIME_MODELS: { role: string; id: string }[] = [
  { role: "Extraction (per answer)", id: MODELS.detectiveTurn },
  { role: "Extraction fallback", id: MODELS.detectiveTurnFallback },
  { role: "Reasoning (review + accusation)", id: MODELS.detectiveReasoning },
  { role: "Reasoning fallback", id: MODELS.detectiveReasoningFallback },
];

/** USD per 1M tokens. From `npm run models` on 2026-09-19. */
export const PRICES_PER_M: Record<string, { input: number; output: number }> = {
  "Qwen/Qwen3-235B-A22B-Instruct-2507": { input: 0.2, output: 0.6 },
  "Qwen/Qwen3-30B-A3B-Instruct-2507": { input: 0.1, output: 0.3 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  // Prices from the Nebius model list (`npm run models`).
  "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.3, output: 1.2 },
};

export const GAME = {
  minPlayers: 3,
  maxPlayers: 8,
  defaultRounds: 3,
  /** Round 1 is always one question per player; later rounds get the same count, freely allocated. */
  questionsPerRoundPerPlayer: 1,
  defaultAnswerSeconds: 40,
  /**
   * Seconds the server waits after the visible deadline before recording "no answer".
   * Covers a voice answer's upload and transcription after the phone stops recording.
   */
  answerGraceSeconds: 10,
  earlyEndConfidence: 0.8,
  /**
   * If true, everyone (and the detective) sees each player's character name and one-line description,
   * like a cast list. Everything else on the card stays private. Set false to keep identities secret
   * until the reveal; the detective then only knows players by display name.
   */
  publicCast: true,
  roomCodeLength: 4,
};

/**
 * ElevenLabs. Server-side only.
 * Voice modes (chosen at startup from what is configured and working):
 *   agent    real ElevenLabs Conversational AI session on the player's phone (needs ELEVENLABS_AGENT_ID)
 *   stt-tts  phone records, server transcribes (Scribe); host screen speaks the question (TTS)
 *   text     players type
 */
export const VOICE = {
  ttsModel: "eleven_flash_v2_5", // lowest latency per ElevenLabs docs
  /** English agents on ElevenLabs must use a turbo or flash v2 model (v2_5 is rejected). */
  agentTtsModel: "eleven_flash_v2",
  sttModel: "scribe_v2",
  outputFormat: "mp3_44100_64",
  /** "George", a premade ElevenLabs voice. Override with ELEVENLABS_DETECTIVE_VOICE_ID. Used by TTS (fallback mode + accusation) and the agent. */
  defaultDetectiveVoiceId: "JBFqnCBsd6RMkjVDRZzb",
  /** Extra time before the answer clock starts in agent mode, for the WebRTC session to connect. */
  agentConnectMs: 4000,
  /** Max accepted recording size from a phone. */
  maxAudioBytes: 5 * 1024 * 1024,
};

export interface ScoringWeights {
  vsEvidence: number;
  vsAlibi: number;
  self: number;
  vsOtherPlayer: number;
  implausible: number;
  evasive: number;
  corroboration: number;
  /** Corroboration can offset at most this share of a player's logical total. */
  corroborationCapShare: number;
  /** How a cross-player contradiction is charged: both in full, split in half, or ignored. */
  crossSplit: "both" | "split" | "none";
  /** Suspicion curve steepness, see lib/scoring.ts. */
  curveK: number;
  normalizeTo: number;
  minQuestionsForNormalize: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  vsEvidence: 1.0,
  vsAlibi: 0.9,
  self: 0.8,
  vsOtherPlayer: 0.5,
  implausible: 0.3,
  evasive: 0.3,
  corroboration: 0.3,
  corroborationCapShare: 0.5,
  crossSplit: "both",
  curveK: 1.0,
  normalizeTo: 3,
  minQuestionsForNormalize: 2,
};
