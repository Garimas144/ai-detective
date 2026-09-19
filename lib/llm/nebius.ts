import OpenAI from "openai";
import { MODELS, NEBIUS_BASE_URL, PRICES_PER_M } from "../config";
import type { LLMCallRecord, LLMClient, LLMRequest } from "./types";

export function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES_PER_M[model];
  if (!p) return 0;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Reasoning models may put their chain of thought inline. Keep only the final answer. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
}

export function createNebiusClient(apiKey: string): LLMClient {
  const client = new OpenAI({ apiKey, baseURL: NEBIUS_BASE_URL, maxRetries: 4, timeout: 90_000 });
  const noJsonMode = new Set<string>();

  async function once(req: LLMRequest, model: string) {
    const useJsonMode = req.json && !noJsonMode.has(model);
    try {
      return await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens ?? 1200,
        temperature: req.temperature ?? 0.4,
        ...(useJsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });
    } catch (err) {
      // Some models reject JSON mode. Remember that and retry with prompt-only JSON.
      if (useJsonMode && err instanceof OpenAI.BadRequestError && /response_format|json/i.test(err.message)) {
        noJsonMode.add(model);
        return once(req, model);
      }
      throw err;
    }
  }

  return {
    provider: "nebius",
    async complete(req) {
      const started = Date.now();
      const models =
        req.model === MODELS.detectiveTurn ? [req.model, MODELS.detectiveTurnFallback] : [req.model];
      let lastError: unknown;
      for (const model of models) {
        try {
          const res = await once(req, model);
          const raw = res.choices[0]?.message?.content ?? "";
          const text = stripReasoning(raw);
          const inputTokens = res.usage?.prompt_tokens ?? 0;
          const outputTokens = res.usage?.completion_tokens ?? 0;
          const record: LLMCallRecord = {
            at: new Date().toISOString(),
            purpose: req.purpose,
            provider: "nebius",
            model,
            inputTokens,
            outputTokens,
            latencyMs: Date.now() - started,
            costUsd: costFor(model, inputTokens, outputTokens),
            ok: true,
            system: req.system,
            user: req.user,
            response: text,
          };
          return { text, record };
        } catch (err) {
          lastError = err;
        }
      }
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      throw Object.assign(new Error(`Nebius call failed (${req.purpose}): ${message}`), {
        record: {
          at: new Date().toISOString(),
          purpose: req.purpose,
          provider: "nebius",
          model: req.model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - started,
          costUsd: 0,
          ok: false,
          error: message,
          system: req.system,
          user: req.user,
          response: "",
        } satisfies LLMCallRecord,
      });
    },
  };
}
