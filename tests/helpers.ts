import { seededRng } from "@/lib/game/deal";
import { addPlayer, beginInterrogation, createGame, deal, openAlibis, selectCase, submitAlibi, submitAnswer, type EngineDeps } from "@/lib/game/engine";
import { createMockClient } from "@/lib/llm/mock";
import type { LLMClient, LLMRequest } from "@/lib/llm/types";
import type { GameState, Secrets, Settings } from "@/lib/types";

export const PLAYER_NAMES = ["Ana", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal"];

export function recordingClient(): { llm: LLMClient; requests: LLMRequest[] } {
  const inner = createMockClient();
  const requests: LLMRequest[] = [];
  return {
    requests,
    llm: { provider: "mock", complete: (req) => (requests.push(req), inner.complete(req)) },
  };
}

/** Plays a whole game with the mock detective. `answer` decides each spoken answer. */
export async function playGame(opts: {
  caseId: string;
  players: number;
  seed?: number;
  settings?: Partial<Settings>;
  llm?: LLMClient;
  alibi?: (state: GameState, playerId: string) => string;
  answer?: (state: GameState, playerId: string, i: number) => string;
}): Promise<{ state: GameState; secrets: Secrets; deps: EngineDeps }> {
  const rng = seededRng(opts.seed ?? 1);
  const deps: EngineDeps = { llm: opts.llm ?? createMockClient(), rng };
  const state = createGame("g_test", opts.settings);
  selectCase(state, opts.caseId);
  PLAYER_NAMES.slice(0, opts.players).forEach((n) => addPlayer(state, n));
  const secrets = deal(state, rng);
  openAlibis(state);
  for (const p of state.players)
    await submitAlibi(state, deps, p.id, opts.alibi?.(state, p.id) ?? `I'm ${p.characterName}. I was in the main hall from 21:00 to 21:30.`);
  await beginInterrogation(state, deps);
  let i = 0;
  while (state.phase === "INTERROGATION" && state.current && i < 200) {
    const target = state.current.targetPlayerId;
    await submitAnswer(state, deps, target, opts.answer?.(state, target, i) ?? `I was in the library at 21:${String(10 + (i % 40)).padStart(2, "0")}.`);
    i++;
  }
  return { state, secrets, deps };
}
