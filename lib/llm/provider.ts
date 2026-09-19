import { createMockClient } from "./mock";
import { createNebiusClient } from "./nebius";
import type { LLMClient } from "./types";

let cached: LLMClient | null = null;

export interface LLMSelection {
  provider: "nebius" | "mock";
  /** Why this provider was chosen, for logs and preflight. Never contains a key. */
  reason: string;
}

/** Decides Nebius vs mock from the environment. Pure, so it can be tested and shown in preflight. */
export function selectLLM(env: Record<string, string | undefined> = process.env): LLMSelection {
  const key = env.NEBIUS_API_KEY?.trim();
  if (env.LLM_PROVIDER?.trim() === "mock") return { provider: "mock", reason: "LLM_PROVIDER=mock forces the offline mock" };
  if (!key) return { provider: "mock", reason: "NEBIUS_API_KEY is not set" };
  return { provider: "nebius", reason: "NEBIUS_API_KEY is set" };
}

/** Nebius when NEBIUS_API_KEY is set, otherwise the offline mock. REQUIRE_NEBIUS=1 refuses to fall back. */
export function getLLM(): LLMClient {
  if (cached) return cached;
  const choice = selectLLM();
  if (choice.provider === "mock" && process.env.REQUIRE_NEBIUS === "1") {
    throw new Error(`REQUIRE_NEBIUS=1 but the mock detective would be used (${choice.reason}). Set NEBIUS_API_KEY.`);
  }
  cached = choice.provider === "nebius" ? createNebiusClient(process.env.NEBIUS_API_KEY!.trim()) : createMockClient();
  return cached;
}

/** For tests. */
export function resetLLMForTests() {
  cached = null;
}

/** Loud console banner so the mock is never mistaken for Nebius. */
export function mockBanner(reason: string): string {
  const bar = "!".repeat(72);
  return [
    "",
    bar,
    "!!  MOCK DETECTIVE ACTIVE: NOT NEBIUS. Answers are canned heuristics.  !!",
    `!!  Reason: ${reason}`.padEnd(70) + "!!",
    "!!  Do NOT demo this. Set NEBIUS_API_KEY, then run: npm run preflight  !!",
    bar,
    "",
  ].join("\n");
}
