// Deterministic suspicion scoring. Pure functions only, so saved sim logs can be re-scored offline.
// Profiles stay hidden during play. They feed the detective's planning and accusation and are shown
// at the final reveal.
//
// Per player (charges from the detective's own contradiction / corroboration analysis):
//   evidence      = vsEvidence    * severity   testimony conflicts with a public evidence item
//   alibi         = vsAlibi       * severity   later answer conflicts with their own written alibi
//   self          = self          * severity   answer conflicts with their own earlier answer
//   crossPlayer   = vsOtherPlayer * severity   conflicts with someone else's testimony, charged per `crossSplit`
//   implausible   = implausible   * severity   testimony that is implausible on its face
//   evasiveness   = evasive       * (evasive or timed-out answers)
//   corroboration = corroboration * strength   SUBTRACTED, capped at corroborationCapShare of the logical total
//
// Normalization: normalized = raw * normalizeTo / max(questionsReceived, minQuestionsForNormalize)
//   i.e. "weighted problems per 3 questions", with a floor of 2 so a single answer isn't over-weighted.
// Suspicion score: round(100 * (1 - exp(-curveK * normalized)))
//   curveK 1.0: 0.5 -> 39, 1.0 -> 63, 1.5 -> 78, 2.0 -> 86, 3.0 -> 95.
// Rank 1 = most suspicious. The detective must still pick exactly one culprit itself.

import type { ScoringWeights } from "./config";
import type { Claim, ComponentScores, Contradiction, Corroboration, Note, SuspicionProfile, Turn } from "./types";

export interface ScoringInput {
  playerIds: string[];
  contradictions: Contradiction[];
  corroborations: Corroboration[];
  turns: Turn[];
  claims: Claim[];
  questionsByPlayer: Record<string, number>;
  openQuestions?: Note[];
  notes?: Note[];
}

export function chargeFor(c: Contradiction, w: ScoringWeights): number {
  const weight =
    c.kind === "vs_evidence" ? w.vsEvidence
    : c.kind === "vs_alibi" ? w.vsAlibi
    : c.kind === "self" ? w.self
    : c.kind === "implausible" ? w.implausible
    : w.vsOtherPlayer;
  const base = weight * c.severity;
  if (c.kind !== "vs_other_player") return base;
  if (w.crossSplit === "none") return 0;
  return w.crossSplit === "split" ? base / 2 : base;
}

export function suspicionCurve(normalized: number, k: number): number {
  return Math.round(100 * (1 - Math.exp(-k * Math.max(0, normalized))));
}

function profileFor(playerId: string, input: ScoringInput, w: ScoringWeights): Omit<SuspicionProfile, "rank"> {
  const mine = input.contradictions.filter((c) => c.playerIds.includes(playerId));
  const components: ComponentScores = { evidence: 0, alibi: 0, self: 0, crossPlayer: 0, implausible: 0, evasiveness: 0, corroboration: 0 };
  for (const c of mine) {
    const charge = chargeFor(c, w);
    if (c.kind === "vs_evidence") components.evidence += charge;
    else if (c.kind === "vs_alibi") components.alibi += charge;
    else if (c.kind === "self") components.self += charge;
    else if (c.kind === "implausible") components.implausible += charge;
    else components.crossPlayer += charge;
  }
  const evasiveTurns = input.turns.filter((t) => t.playerId === playerId && t.kind === "answer" && (t.evasive || t.timedOut)).length;
  components.evasiveness = w.evasive * evasiveTurns;

  const logical = components.evidence + components.alibi + components.self + components.crossPlayer + components.implausible + components.evasiveness;
  const supported = input.corroborations.filter((c) => c.playerIds.includes(playerId));
  const rawCredit = supported.reduce((s, c) => s + w.corroboration * c.strength, 0);
  components.corroboration = Math.min(rawCredit, w.corroborationCapShare * logical);

  const raw = logical - components.corroboration;
  const questionsReceived = input.questionsByPlayer[playerId] ?? 0;
  const normalized = (raw * w.normalizeTo) / Math.max(questionsReceived, w.minQuestionsForNormalize);

  return {
    playerId,
    suspicionScore: suspicionCurve(normalized, w.curveK),
    components,
    contradictionIds: mine.filter((c) => chargeFor(c, w) > 0).sort((a, b) => chargeFor(b, w) - chargeFor(a, w)).map((c) => c.id),
    corroborationIds: supported.map((c) => c.id),
    evidenceConflicts: mine.filter((c) => c.kind === "vs_evidence").length,
    storyChanges: mine.filter((c) => c.kind === "vs_alibi" || c.kind === "self").length,
    openQuestions: (input.openQuestions ?? []).filter((n) => n.playerId === playerId).map((n) => n.text),
    notes: (input.notes ?? []).filter((n) => n.playerId === playerId).map((n) => n.text),
    questionsReceived,
    claimsMade: input.claims.filter((c) => c.playerId === playerId).length,
  };
}

export function buildProfiles(input: ScoringInput, w: ScoringWeights): SuspicionProfile[] {
  const profiles = input.playerIds.map((id) => profileFor(id, input, w));
  const order = [...profiles].sort((a, b) => b.suspicionScore - a.suspicionScore || b.contradictionIds.length - a.contradictionIds.length);
  return profiles.map((p) => ({ ...p, rank: order.indexOf(p) + 1 }));
}

/** Deterministic pick used as a fallback and by the offline sweep. */
export function topSuspect(profiles: SuspicionProfile[]): string {
  return [...profiles].sort((a, b) => a.rank - b.rank)[0].playerId;
}
