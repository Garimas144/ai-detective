import type { z } from "zod";
import { normalizeTimes } from "../time";
import type { CallSink, LLMCallRecord, LLMClient, LLMRequest } from "./types";

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in reply");
  return JSON.parse(body.slice(start, end + 1));
}

function logCall(record: LLMCallRecord) {
  const cost = record.costUsd ? ` $${record.costUsd.toFixed(5)}` : "";
  const status = record.ok ? "" : ` ERROR ${record.error}`;
  console.log(
    `[llm] ${record.purpose} ${record.provider}:${record.model} in=${record.inputTokens} out=${record.outputTokens} ${record.latencyMs}ms${cost}${status}`,
  );
  if (process.env.LLM_LOG_BODIES === "1") console.log(`[llm] response: ${record.response.slice(0, 800)}`);
}

/** Calls the model, validates the JSON reply with zod, and retries once on a parse failure. */
export async function callJson<S extends z.ZodTypeAny>(
  llm: LLMClient,
  req: LLMRequest,
  schema: S,
  sink?: CallSink,
): Promise<z.infer<S>> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const request =
      attempt === 0
        ? req
        : {
            ...req,
            user: `${req.user}\n\nYour previous reply could not be used: ${lastError}\nReply again with a single JSON object that matches the schema exactly. No other text.`,
          };
    let result: Awaited<ReturnType<LLMClient["complete"]>>;
    try {
      result = await llm.complete(request);
    } catch (err) {
      const record = (err as { record?: LLMCallRecord }).record;
      if (record) {
        logCall(record);
        sink?.(record);
      }
      throw err;
    }
    logCall(result.record);
    sink?.(result.record);
    try {
      return schema.parse(extractJson(normalizeTimes(result.text)));
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 400) : String(err);
    }
  }
  throw new Error(`${req.purpose}: invalid JSON after retry (${lastError})`);
}

/** Plain-text call (player agents' spoken answers). */
export async function callText(llm: LLMClient, req: LLMRequest, sink?: CallSink): Promise<string> {
  try {
    const { text, record } = await llm.complete(req);
    logCall(record);
    sink?.(record);
    return text;
  } catch (err) {
    const record = (err as { record?: LLMCallRecord }).record;
    if (record) {
      logCall(record);
      sink?.(record);
    }
    throw err;
  }
}
