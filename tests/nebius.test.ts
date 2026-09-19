import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCase } from "@/lib/cases";
import { MODELS } from "@/lib/config";
import { revealTruth } from "@/lib/game/engine";
import { createNebiusClient } from "@/lib/llm/nebius";
import { getLLM, mockBanner, resetLLMForTests, selectLLM } from "@/lib/llm/provider";
import { playGame } from "./helpers";

const KEY = "nebius_test_KEY_abc123";

/**
 * A tiny Nebius look-alike (OpenAI-compatible /chat/completions). It records exactly what the game sends,
 * which proves the game really calls Nebius at runtime, with which model, and with which credentials.
 */
let server: Server;
let baseURL = "";
const calls: { purpose: string; model: string; auth: string | undefined; user: string }[] = [];

const purposeOf = (system: string) =>
  /Recorder/.test(system) ? "extractor" : /reviewing testimony/.test(system) ? "review" : /accuse EXACTLY ONE/.test(system) ? "accusation" : "reveal";

function answerFor(system: string, user: string): string {
  const ids = [...user.matchAll(/\(id (p_[a-z0-9]+)/g)].map((m) => m[1]);
  switch (purposeOf(system)) {
    case "extractor":
      return JSON.stringify({
        claims: [{ subject: "Someone", location: "the hall", timeStart: "21:00", timeEnd: null, aboutPlayerIds: [], statement: "Someone says they were in the hall at 21:00." }],
        evasive: false,
      });
    case "review": {
      const round1 = /Next is ROUND 1/.test(user);
      const final = /This was the final round/.test(user);
      const questions = final ? [] : round1 ? ids.map((id) => ({ targetPlayerId: id, question: "Where were you at nine?" })) : [{ targetPlayerId: ids[0], question: "Explain yourself." }];
      return JSON.stringify({ contradictions: [], corroborations: [], openQuestions: [], notes: [], reasoning: "Nebius test review.", endInvestigation: final, confidence: 0.4, questions });
    }
    case "accusation":
      return JSON.stringify({ accusedPlayerId: ids[0], confidence: 0.7, reasoning: "I accuse the first person.", keyPoints: ["Test point"] });
    default:
      return JSON.stringify({ summary: "The reveal.", importantLies: [], misleadingTestimony: [] });
  }
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = JSON.parse(body);
    const system = json.messages.find((m: { role: string }) => m.role === "system").content as string;
    const user = json.messages.find((m: { role: string }) => m.role === "user").content as string;
    calls.push({ purpose: purposeOf(system), model: json.model, auth: req.headers.authorization, user });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "x",
        object: "chat.completion",
        created: 0,
        model: json.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: answerFor(system, user) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }),
    );
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Nebius is genuinely wired into the runtime", () => {
  it("a full game calls Nebius for extraction, review, accusation and the reveal, with the right models and key", async () => {
    calls.length = 0;
    const llm = createNebiusClient(KEY, baseURL);
    const { state, secrets, deps } = await playGame({ caseId: "blackwood-manor", players: 4, llm, settings: { allowEarlyEnd: false } });
    await revealTruth(state, deps, secrets);

    const byPurpose = (p: string) => calls.filter((c) => c.purpose === p);
    const answers = state.turns.filter((t) => t.kind === "answer").length;
    expect(byPurpose("extractor").length).toBeGreaterThanOrEqual(4 + answers); // 4 alibis + every answer
    expect(byPurpose("review").length).toBeGreaterThanOrEqual(1 + state.settings.rounds); // after the alibis + after each round
    expect(byPurpose("accusation")).toHaveLength(1);
    expect(byPurpose("reveal")).toHaveLength(1);

    // Latency-sensitive extraction uses the fast model; between-round reasoning and the accusation use the reasoning model.
    for (const c of byPurpose("extractor")) expect(c.model).toBe(MODELS.detectiveTurn);
    for (const c of byPurpose("review")) expect(c.model).toBe(MODELS.detectiveReasoning);
    expect(byPurpose("accusation")[0].model).toBe(MODELS.detectiveReasoning);
    expect(calls.every((c) => c.auth === `Bearer ${KEY}`)).toBe(true);

    // The game state came from the model's answers: Nebius chose the questions and made the accusation.
    expect(state.reviewLog.some((r) => r.reasoning === "Nebius test review.")).toBe(true);
    expect(state.accusation?.source).toBe("model");
    expect(state.accusation?.reasoning).toBe("I accuse the first person.");
  });

  it("no detective-side Nebius request contains the culprit's identity or private card text", async () => {
    calls.length = 0;
    const llm = createNebiusClient(KEY, baseURL);
    const { secrets } = await playGame({ caseId: "museum-heist", players: 5, llm });
    const detective = calls.filter((c) => c.purpose !== "reveal");
    expect(detective.length).toBeGreaterThan(10);
    const blob = detective.map((c) => c.user).join("\n");
    const card = getCase("museum-heist").characters.find((c) => c.id === secrets.characterOf[secrets.culpritPlayerId])!;
    expect(blob).not.toContain("culpritPlayerId");
    expect(blob).not.toMatch(/\(THE CULPRIT\)|culprit"?\s*:\s*true/);
    for (const secret of [card.motive, card.suspicious, ...(card.whatYouDid ?? []), ...(card.looseEnds ?? [])]) expect(blob).not.toContain(secret);
  });
});

describe("mock vs Nebius selection is unmistakable", () => {
  it("chooses Nebius when the key exists, the mock when it doesn't, and says why", () => {
    expect(selectLLM({ NEBIUS_API_KEY: KEY })).toMatchObject({ provider: "nebius" });
    const none = selectLLM({});
    expect(none.provider).toBe("mock");
    expect(none.reason).toMatch(/NEBIUS_API_KEY is not set/);
    expect(selectLLM({ NEBIUS_API_KEY: KEY, LLM_PROVIDER: "mock" }).provider).toBe("mock");
    expect(selectLLM({ NEBIUS_API_KEY: "   " }).provider).toBe("mock");
  });

  it("getLLM returns the matching client, and REQUIRE_NEBIUS=1 refuses to fall back to the mock", () => {
    const saved = { ...process.env };
    try {
      delete process.env.NEBIUS_API_KEY;
      delete process.env.LLM_PROVIDER;
      delete process.env.REQUIRE_NEBIUS;
      resetLLMForTests();
      expect(getLLM().provider).toBe("mock");
      resetLLMForTests();
      process.env.REQUIRE_NEBIUS = "1";
      expect(() => getLLM()).toThrow(/REQUIRE_NEBIUS/);
      resetLLMForTests();
      process.env.NEBIUS_API_KEY = KEY;
      expect(getLLM().provider).toBe("nebius");
    } finally {
      process.env = saved;
      resetLLMForTests();
    }
  });

  it("the console banner can't be mistaken for a live demo", () => {
    const banner = mockBanner("NEBIUS_API_KEY is not set");
    expect(banner).toMatch(/MOCK DETECTIVE ACTIVE: NOT NEBIUS/);
    expect(banner).toMatch(/Do NOT demo this/);
  });
});
