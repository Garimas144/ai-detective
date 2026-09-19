import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import {
  renderCase,
  renderClaims,
  renderInferences,
  renderTestimony,
  TESTIMONY_RULE,
  type DetectiveView,
} from "../game/detectiveView";
import type { SuspicionProfile } from "../types";

export const reviewSchema = z.object({
  contradictions: z
    .array(
      z.object({
        kind: z.enum(["vs_evidence", "vs_alibi", "self", "vs_other_player", "implausible"]),
        claimIds: z.array(z.string()).min(1).max(2),
        evidenceId: z.string().nullish(),
        severity: z.number().min(0).max(1),
        explanation: z.string(),
      }),
    )
    .max(15),
  corroborations: z
    .array(
      z.object({
        claimIds: z.array(z.string()).min(1).max(2),
        evidenceId: z.string().nullish(),
        strength: z.number().min(0).max(1),
        explanation: z.string(),
      }),
    )
    .max(15),
  openQuestions: z.array(z.object({ playerId: z.string(), text: z.string() })).max(12),
  notes: z.array(z.object({ playerId: z.string(), text: z.string() })).max(12),
  reasoning: z.string(),
  endInvestigation: z.boolean(),
  confidence: z.number().min(0).max(1),
  questions: z.array(z.object({ targetPlayerId: z.string(), question: z.string().min(3) })).max(12),
});
export type ReviewOutput = z.infer<typeof reviewSchema>;

export interface ReviewContext {
  completedRound: number; // 0 = only alibis so far
  nextRound: number | null; // null when no more rounds will be played
  totalRounds: number;
  questionsForNextRound: number;
  earlyEndAllowed: boolean;
  newClaimIds: string[];
}

const SYSTEM = `You are the Detective, reviewing testimony between rounds of questioning. Exactly one person being questioned is the culprit. Your job has two parts.

PART 1: ANALYSIS. Compare the NEW claims against everything else:
- the speaker's own WRITTEN ALIBI ("vs_alibi"): their story changed from what they wrote
- the speaker's own earlier answers ("self")
- other people's testimony ("vs_other_player")
- the public evidence ("vs_evidence", set evidenceId)
- plausibility on its face ("implausible", one claim only)
A contradiction means both cannot be true. Omissions, vagueness, extra detail, and time differences of 5 minutes or less are NOT contradictions.
Severity 0.9-1.0: direct conflict about the crime window, crime location or a logged record. 0.5-0.8: clear conflict about movements near the crime. 0.2-0.4: minor.
Also record CORROBORATIONS: two people independently supporting each other, or testimony matching evidence. Strength 0-1.
Record OPEN QUESTIONS (what still needs explaining, including unexplained evidence) and NOTES (suspicious statements, story changes, who is covering what).
Remember that innocent people also lie, usually to hide a personal secret. A lie alone does not make someone the culprit. Ask whether the lie is about the crime or about something else.

PART 2: PLAN. Choose the questions for the next round.
- Each question is ONE or two spoken sentences to ONE person. No stage directions.
- Pursue contradictions, story changes, unexplained evidence and open questions. Confront people with evidence or with what others said.
- You may quote other people's testimony, but always as testimony ("Dana says you called her at 19:55").
- Allocate freely: you may ask one person several questions and skip others.
- If you are confident enough to accuse now and early ending is allowed, set endInvestigation true and give no questions.

${TESTIMONY_RULE}

Use claim ids and player ids exactly as given. Your "reasoning" is private notes (3-6 sentences) on where the case stands.

Reply with JSON only:
{"contradictions":[{"kind":"vs_evidence"|"vs_alibi"|"self"|"vs_other_player"|"implausible","claimIds":[string],"evidenceId":string|null,"severity":number,"explanation":string}],
 "corroborations":[{"claimIds":[string],"evidenceId":string|null,"strength":number,"explanation":string}],
 "openQuestions":[{"playerId":string,"text":string}],
 "notes":[{"playerId":string,"text":string}],
 "reasoning":string,"endInvestigation":boolean,"confidence":number,
 "questions":[{"targetPlayerId":string,"question":string}]}`;

export function buildReviewRequest(view: DetectiveView, profiles: SuspicionProfile[], ctx: ReviewContext): LLMRequest {
  const newIds = new Set(ctx.newClaimIds);
  const speaker = (id: string) => view.players.find((p) => p.id === id)?.character ?? id;
  let planRule: string;
  if (ctx.nextRound === null) planRule = "This was the final round. Do the analysis only. Set endInvestigation true and questions [].";
  else if (ctx.nextRound === 1)
    planRule = `Next is ROUND 1 of ${ctx.totalRounds}. Ask EXACTLY one question to EACH person (${view.players.length} questions), so everyone gets initial attention. endInvestigation must be false.`;
  else
    planRule = `Next is ROUND ${ctx.nextRound} of ${ctx.totalRounds}. You have ${ctx.questionsForNextRound} questions to allocate however you like.${ctx.earlyEndAllowed ? " You may end the investigation now if you are confident (confidence 0.8 or higher)." : ""}`;

  const user = `${renderCase(view)}

ALL TESTIMONY SO FAR:
${renderTestimony(view)}

EARLIER CLAIMS:
${renderClaims(view, (id) => !newIds.has(id))}

NEW CLAIMS TO ANALYZE (since your last review):
${renderClaims(view, (id) => newIds.has(id))}

YOUR FINDINGS SO FAR:
${renderInferences(view)}

SUSPICION PROFILES (your running tally; higher = more suspicious):
${profiles.map((p) => `- ${speaker(p.playerId)} (id ${p.playerId}): score ${p.suspicionScore}, rank ${p.rank}, questions so far ${p.questionsReceived}, story changes ${p.storyChanges}, evidence conflicts ${p.evidenceConflicts}`).join("\n")}

ROUNDS COMPLETED: ${ctx.completedRound} of ${ctx.totalRounds}.
${planRule}

Only report NEW contradictions and corroborations that involve at least one of the NEW claims.`;
  return {
    purpose: "review",
    model: MODELS.detectiveReasoning,
    system: SYSTEM,
    user,
    json: true,
    temperature: 0.5,
    maxTokens: 12000,
    mockData: { view, ctx, profiles },
  };
}
