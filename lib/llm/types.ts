export type Provider = "nebius" | "mock";

export type Purpose =
  | "extractor"
  | "review"
  | "accusation"
  | "reveal"
  | "player-answer"
  | "player-alibi";

/** Detective-side purposes. These must never see secrets (enforced by tests/isolation.test.ts). */
export const DETECTIVE_PURPOSES: Purpose[] = ["extractor", "review", "accusation"];

export interface LLMRequest {
  purpose: Purpose;
  model: string;
  system: string;
  user: string;
  json: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Structured copy of the prompt inputs, used only by the mock provider. */
  mockData?: unknown;
}

export interface LLMCallRecord {
  at: string;
  purpose: Purpose;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
  ok: boolean;
  error?: string;
  system: string;
  user: string;
  response: string;
}

export interface LLMClient {
  provider: Provider;
  complete(req: LLMRequest): Promise<{ text: string; record: LLMCallRecord }>;
}

export type CallSink = (record: LLMCallRecord) => void;
