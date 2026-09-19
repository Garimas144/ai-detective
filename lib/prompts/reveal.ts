// Post-game narrator. This is NOT the detective: it runs only after the accusation has been made
// and is allowed to see the truth, so it can point out lies and misleading testimony.
//
// It is NOT allowed to invent facts. Everything it may call "true" is a numbered FACT taken from the case files,
// and every lie it reports must cite the facts that prove it and quote words the player really said or wrote.
// The engine verifies both (see lib/game/revealCheck.ts) and drops anything unsupported.

import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import type { Accusation, Case, GameState, Secrets } from "../types";

export const revealSchema = z.object({
  summary: z.string(),
  importantLies: z
    .array(z.object({ playerId: z.string(), statement: z.string(), truth: z.string(), factIds: z.array(z.string()).default([]) }))
    .max(10),
  misleadingTestimony: z.array(z.object({ playerId: z.string(), statement: z.string(), effect: z.string() })).max(8),
});
export type RevealOutput = z.infer<typeof revealSchema>;

/** A fact the narrator may rely on. Text comes verbatim from the case files. */
export interface RevealFact {
  id: string;
  /** The character this fact is about, or null for the case as a whole. */
  playerId: string | null;
  text: string;
}

/** Numbered facts from the case files: the true story, evidence explanations, and each dealt character's card. */
export function buildRevealFacts(state: GameState, c: Case, secrets: Secrets): RevealFact[] {
  const facts: RevealFact[] = [];
  const add = (playerId: string | null, text: string | null | undefined) => {
    if (text && text.trim()) facts.push({ id: `F${facts.length + 1}`, playerId, text: text.trim() });
  };
  add(null, c.truth);
  for (const e of c.evidence) add(null, `${e.title}: ${e.explanation}`);
  for (const p of state.players) {
    const ch = c.characters.find((x) => x.id === secrets.characterOf[p.id]);
    if (!ch) continue;
    add(p.id, ch.secret ? `Secret: ${ch.secret}` : null);
    for (const k of ch.knows) add(p.id, `Knows: ${k}`);
    for (const d of ch.whatYouDid ?? []) add(p.id, `Actually did: ${d}`);
    add(p.id, `Motive: ${ch.motive}`);
    add(p.id, `Suspicious circumstance: ${ch.suspicious}`);
  }
  return facts;
}

const SYSTEM = `You are the narrator of a murder-mystery game's final reveal. The detective has already made its accusation. You may use the numbered FACTS below, and nothing else, as the truth.

Write:
- "summary": 3 to 5 sentences in the style of the end of a mystery film, tying together what really happened and why the strange details make sense. Use only the FACTS.
- "importantLies": lies players told. Include an entry ONLY when a player's TESTIMONY directly conflicts with one or more FACTS. For each:
  - "statement": words the player actually said or wrote, copied from the TESTIMONY exactly (a short exact phrase is best).
  - "factIds": the ids (like "F12") of the FACTS that show it is false. At least one.
  - "truth": one sentence stating what the cited FACTS say really happened. Do not add anything the FACTS do not say.
  Do NOT report a statement as a lie just because it sounds suspicious or cannot be checked. Do NOT invent events, motives, movements or reasons. A player who kept a secret without saying anything false did not lie. If no statement conflicts with a fact, return an empty list.
- "misleadingTestimony": things players actually SAID OR WROTE that pushed the detective in the wrong direction (made someone look guiltier or more innocent than the FACTS show). "statement" must be copied exactly from the TESTIMONY. Never quote anything from the FACTS as if a player said it: a player's private card is not testimony.
Write every time in 12-hour form with AM or PM (for example 9:05 PM), never 24-hour.
Only use player ids given. Reply with JSON only:
{"summary":string,"importantLies":[{"playerId":string,"statement":string,"factIds":[string],"truth":string}],"misleadingTestimony":[{"playerId":string,"statement":string,"effect":string}]}`;

export function buildRevealRequest(state: GameState, c: Case, secrets: Secrets, accusation: Accusation): LLMRequest {
  const nameOf = (id: string) => state.players.find((p) => p.id === id)?.characterName ?? id;
  const facts = buildRevealFacts(state, c, secrets);
  const factLines = facts.map((f) => `[${f.id}]${f.playerId ? ` (about ${nameOf(f.playerId)}, id ${f.playerId})` : ""} ${f.text}`);
  const culprit = state.players.find((p) => p.id === secrets.culpritPlayerId);
  const testimony = state.turns
    .map((t) =>
      t.kind === "alibi"
        ? `${nameOf(t.playerId)} (id ${t.playerId}) wrote in their alibi: "${t.answer}"`
        : `Q to ${nameOf(t.playerId)} (id ${t.playerId}): "${t.question}"  ${nameOf(t.playerId)} said: "${t.answer}"`,
    )
    .join("\n");
  const user = `CASE: ${c.title}
THE CULPRIT WAS: ${culprit ? nameOf(culprit.id) : "unknown"}

FACTS (the only things you may treat as true):
${factLines.join("\n")}

TESTIMONY (what players actually wrote and said):
${testimony}

DETECTIVE ACCUSED: ${nameOf(accusation.accusedPlayerId)}. Reasoning: ${accusation.reasoning}`;
  return {
    purpose: "reveal",
    model: MODELS.revealNarrator,
    system: SYSTEM,
    user,
    json: true,
    temperature: 0.3,
    maxTokens: 3500,
    mockData: { truth: c.truth },
  };
}
