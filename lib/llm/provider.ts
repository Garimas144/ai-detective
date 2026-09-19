import { createMockClient } from "./mock";
import { createNebiusClient } from "./nebius";
import type { LLMClient } from "./types";

let cached: LLMClient | null = null;

/** Nebius when NEBIUS_API_KEY is set, otherwise the offline mock. LLM_PROVIDER=mock forces the mock. */
export function getLLM(): LLMClient {
  if (cached) return cached;
  const key = process.env.NEBIUS_API_KEY?.trim();
  const forceMock = process.env.LLM_PROVIDER?.trim() === "mock";
  cached = key && !forceMock ? createNebiusClient(key) : createMockClient();
  if (cached.provider === "mock") console.warn("[llm] No NEBIUS_API_KEY set: using the offline mock detective.");
  return cached;
}
