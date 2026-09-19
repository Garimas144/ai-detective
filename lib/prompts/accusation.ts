import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import { renderCase, renderInferences, renderTestimony, TESTIMONY_RULE, TIME_RULE, type DetectiveView } from "../game/detectiveView";
import type { SuspicionProfile } from "../types";

export const accusationSchema = z.object({
  accusedPlayerId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  keyPoints: z.array(z.string()).min(1).max(6),
  assessments: z
    .array(z.object({ playerId: z.string(), suspicious: z.array(z.string()).max(6), checkedOut: z.array(z.string()).max(6) }))
    .default([]),
});
export type AccusationOutput = z.infer<typeof accusationSchema>;

const SYSTEM = `You are the Detective. The questioning is over. You must now accuse EXACTLY ONE of the people being questioned as the culprit.

${TESTIMONY_RULE}
${TIME_RULE}

How to decide:
- Reason only from the public evidence and the testimony you heard or read.
- Weigh which account breaks down on the facts of the crime itself: conflicts with evidence, a story that changed from the written alibi, and independent testimony placing them where they deny being.
- Innocent people also lie, usually to protect a personal secret. A lie about something unrelated to the crime is weak proof.
- Corroborated accounts are more credible. Uncorroborated denials are not proof of innocence.
- The suspicion scores are a helpful tally, not the answer. You may accuse someone who is not ranked first if the reasoning is stronger.

Then announce it out loud:
- "reasoning": a spoken accusation of 4 to 7 sentences, addressed to the room. Name the accused, walk through the key contradictions and evidence, and say clearly which parts are evidence and which are testimony. No stage directions or markdown.
- "keyPoints": 2 to 5 short bullet phrases of the decisive points.
- "assessments": one entry for EVERY person being questioned (accused or not), so the room can see how you judged each of them:
  - "suspicious": what specifically made this person suspicious. Each item names the actual statement or evidence and why it is a problem (for example "Said she was in the library at 9:10 PM, but Dana says she saw her at the loading dock at 9:12 PM"). Include story changes and dodged questions. Write "Nothing solid" if there is nothing.
  - "checkedOut": what specifically held up for this person: statements corroborated by another person or by the evidence, and alibi details that stayed consistent. Write "Nothing confirmed" if nothing did.
  Be concrete and keep each item to one sentence. Never claim something checked out unless it is in the testimony or findings above.

Reply with JSON only:
{"accusedPlayerId":string,"confidence":number,"reasoning":string,"keyPoints":[string],"assessments":[{"playerId":string,"suspicious":[string],"checkedOut":[string]}]}`;

export function buildAccusationRequest(view: DetectiveView, profiles: SuspicionProfile[]): LLMRequest {
  const speaker = (id: string) => view.players.find((p) => p.id === id)?.character ?? id;
  const user = `${renderCase(view)}

ALL TESTIMONY:
${renderTestimony(view)}

YOUR FINDINGS:
${renderInferences(view)}

SUSPICION PROFILES:
${profiles.map((p) => `- ${speaker(p.playerId)} (id ${p.playerId}): score ${p.suspicionScore}, rank ${p.rank}, questions ${p.questionsReceived}, story changes ${p.storyChanges}, evidence conflicts ${p.evidenceConflicts}, corroborations ${p.corroborationIds.length}`).join("\n")}

Accuse exactly one person, using their id.`;
  return {
    purpose: "accusation",
    model: MODELS.detectiveReasoning,
    system: SYSTEM,
    user,
    json: true,
    temperature: 0.3,
    maxTokens: 14000,
    mockData: { profiles, players: view.players },
  };
}
