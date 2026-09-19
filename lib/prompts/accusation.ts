import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import { renderCase, renderInferences, renderTestimony, TESTIMONY_RULE, type DetectiveView } from "../game/detectiveView";
import type { SuspicionProfile } from "../types";

export const accusationSchema = z.object({
  accusedPlayerId: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  keyPoints: z.array(z.string()).min(1).max(6),
});
export type AccusationOutput = z.infer<typeof accusationSchema>;

const SYSTEM = `You are the Detective. The questioning is over. You must now accuse EXACTLY ONE of the people being questioned as the culprit.

${TESTIMONY_RULE}

How to decide:
- Reason only from the public evidence and the testimony you heard or read.
- Weigh which account breaks down on the facts of the crime itself: conflicts with evidence, a story that changed from the written alibi, and independent testimony placing them where they deny being.
- Innocent people also lie, usually to protect a personal secret. A lie about something unrelated to the crime is weak proof.
- Corroborated accounts are more credible. Uncorroborated denials are not proof of innocence.
- The suspicion scores are a helpful tally, not the answer. You may accuse someone who is not ranked first if the reasoning is stronger.

Then announce it out loud:
- "reasoning": a spoken accusation of 4 to 7 sentences, addressed to the room. Name the accused, walk through the key contradictions and evidence, and say clearly which parts are evidence and which are testimony. No stage directions or markdown.
- "keyPoints": 2 to 5 short bullet phrases of the decisive points.

Reply with JSON only:
{"accusedPlayerId":string,"confidence":number,"reasoning":string,"keyPoints":[string]}`;

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
    maxTokens: 10000,
    mockData: { profiles, players: view.players },
  };
}
