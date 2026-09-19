// Central config. Model IDs, scoring weights and game rules live here.
// Nebius model IDs: verify with `npm run models` once NEBIUS_API_KEY is set.

export const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";

export const MODELS = {
  /** Per-answer claim extraction. Fast, runs while the game waits. */
  detectiveTurn: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  /** Fallback if the per-answer model errors or times out. */
  detectiveTurnFallback: "Qwen/Qwen3-30B-A3B-Instruct-2507",
  /** Between-round review (analysis + next-round plan) and the final accusation. */
  detectiveReasoning: "deepseek-ai/DeepSeek-R1-0528",
  /** Post-game reveal narration (knows the truth; runs only after the accusation). */
  revealNarrator: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  /** Simulated player agents (M1.5). */
  playerAgent: "openai/gpt-oss-120b",
  /** Cheaper player agent for comparison runs. */
  playerAgentCheap: "Qwen/Qwen3-30B-A3B-Instruct-2507",
} as const;

/** USD per 1M tokens. Third-party listing as of 2026-09; confirm against `npm run models`. */
export const PRICES_PER_M: Record<string, { input: number; output: number }> = {
  "Qwen/Qwen3-235B-A22B-Instruct-2507": { input: 0.2, output: 0.6 },
  "Qwen/Qwen3-30B-A3B-Instruct-2507": { input: 0.1, output: 0.3 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },
  // Placeholder: no verified price found yet. Update from `npm run models`.
  "deepseek-ai/DeepSeek-R1-0528": { input: 0.8, output: 2.4 },
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

/** ElevenLabs. Server-side only. Voice IDs can be overridden in .env.local. */
export const VOICE = {
  ttsModel: "eleven_flash_v2_5", // lowest latency per ElevenLabs docs
  sttModel: "scribe_v2",
  outputFormat: "mp3_44100_64",
  /** "George", a premade ElevenLabs voice. Override with ELEVENLABS_DETECTIVE_VOICE_ID. */
  defaultDetectiveVoiceId: "JBFqnCBsd6RMkjVDRZzb",
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
