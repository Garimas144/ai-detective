// Post-game narrator. This is NOT the detective: it runs only after the accusation has been made
// and is allowed to see the truth, so it can point out lies and misleading testimony.

import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import type { Accusation, Case, GameState, Secrets } from "../types";

export const revealSchema = z.object({
  summary: z.string(),
  importantLies: z.array(z.object({ playerId: z.string(), statement: z.string(), truth: z.string() })).max(10),
  misleadingTestimony: z.array(z.object({ playerId: z.string(), statement: z.string(), effect: z.string() })).max(8),
});
export type RevealOutput = z.infer<typeof revealSchema>;

const SYSTEM = `You are the narrator of a murder-mystery game's final reveal. The detective has already made its accusation. You know the full truth.

Write:
- "summary": 3 to 5 sentences in the style of the end of a mystery film, tying together what really happened and why the strange details make sense.
- "importantLies": the most important lies players told, each quoted (or closely paraphrased) from their testimony, with the truth.
- "misleadingTestimony": testimony that pushed the detective in the wrong direction or made someone look guiltier or more innocent than they were, and how.
Only use player ids given. Reply with JSON only:
{"summary":string,"importantLies":[{"playerId":string,"statement":string,"truth":string}],"misleadingTestimony":[{"playerId":string,"statement":string,"effect":string}]}`;

export function buildRevealRequest(state: GameState, c: Case, secrets: Secrets, accusation: Accusation): LLMRequest {
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.characterName ?? id;
  const cards = state.players.map((p) => {
    const ch = c.characters.find((x) => x.id === secrets.characterOf[p.id])!;
    return `- id ${p.id}: ${ch.name}${ch.culprit ? " (THE CULPRIT)" : ""}. Secret: ${ch.secret ?? "none"}. Knows: ${ch.knows.join(" ")}${ch.whatYouDid ? ` Did: ${ch.whatYouDid.join(" ")}` : ""}`;
  });
  const testimony = state.turns
    .map((t) => (t.kind === "alibi" ? `${nameOf(t.playerId)} (alibi): "${t.answer}"` : `Q to ${nameOf(t.playerId)}: "${t.question}" A: "${t.answer}"`))
    .join("\n");
  const user = `CASE: ${c.title}
TRUTH: ${c.truth}
EVIDENCE EXPLAINED:
${c.evidence.map((e) => `- ${e.title}: ${e.explanation}`).join("\n")}
CHARACTERS:
${cards.join("\n")}

TESTIMONY:
${testimony}

DETECTIVE ACCUSED: ${nameOf(accusation.accusedPlayerId)}. Reasoning: ${accusation.reasoning}`;
  return {
    purpose: "reveal",
    model: MODELS.revealNarrator,
    system: SYSTEM,
    user,
    json: true,
    temperature: 0.6,
    maxTokens: 2500,
    mockData: { truth: c.truth },
  };
}
