// Builds the ONLY context the detective side may see:
//   public case description, public evidence (no kinds or explanations), the public cast,
//   and testimony (alibis + answers), plus the detective's own inferences.
// Never pass Secrets or private character-card fields through here.

import { GAME } from "../config";
import type { Case, GameState, Player, PublicEvidence } from "../types";

/** How the detective refers to a player: public character name if the cast is public, else display name. */
export function detectiveName(p: Player): string {
  return GAME.publicCast ? p.characterName ?? p.name : p.name;
}

export interface DetectiveView {
  title: string;
  description: string;
  setting: string;
  victim: string;
  timeline: { start: string; end: string };
  evidence: PublicEvidence[];
  players: { id: string; playerName: string; character: string; blurb: string }[];
  absent: { name: string; blurb: string }[];
  testimony: { turnId: string; kind: "alibi" | "answer"; round: number; playerId: string; speaker: string; question: string | null; answer: string; timedOut: boolean }[];
  claims: { id: string; playerId: string; speaker: string; source: string; round: number; statement: string; location: string | null; timeStart: string | null; timeEnd: string | null }[];
  contradictions: { id: string; kind: string; claimIds: string[]; evidenceId: string | null; speakers: string[]; severity: number; explanation: string }[];
  corroborations: { id: string; claimIds: string[]; evidenceId: string | null; speakers: string[]; strength: number; explanation: string }[];
  openQuestions: { speaker: string; text: string }[];
  notes: { speaker: string; text: string }[];
}

export function buildDetectiveView(state: GameState, c: Case): DetectiveView {
  const speaker = (id: string) => {
    const p = state.players.find((x) => x.id === id);
    return p ? detectiveName(p) : id;
  };
  return {
    title: c.title,
    description: c.description,
    setting: c.setting,
    victim: c.victim,
    timeline: c.timeline,
    evidence: state.evidence,
    players: state.players.map((p) => ({ id: p.id, playerName: p.name, character: detectiveName(p), blurb: GAME.publicCast ? p.characterBlurb ?? "" : "" })),
    absent: GAME.publicCast ? state.absent : [],
    testimony: state.turns.map((t) => ({
      turnId: t.id, kind: t.kind, round: t.round, playerId: t.playerId, speaker: speaker(t.playerId),
      question: t.question, answer: t.answer, timedOut: t.timedOut,
    })),
    claims: state.claims.map((c) => ({
      id: c.id, playerId: c.playerId, speaker: speaker(c.playerId), source: c.source, round: c.round,
      statement: c.statement, location: c.location, timeStart: c.timeStart, timeEnd: c.timeEnd,
    })),
    contradictions: state.contradictions.map((x) => ({
      id: x.id, kind: x.kind, claimIds: x.claimIds, evidenceId: x.evidenceId, speakers: x.playerIds.map(speaker), severity: x.severity, explanation: x.explanation,
    })),
    corroborations: state.corroborations.map((x) => ({
      id: x.id, claimIds: x.claimIds, evidenceId: x.evidenceId, speakers: x.playerIds.map(speaker), strength: x.strength, explanation: x.explanation,
    })),
    openQuestions: state.openQuestions.map((n) => ({ speaker: speaker(n.playerId), text: n.text })),
    notes: state.notes.map((n) => ({ speaker: speaker(n.playerId), text: n.text })),
  };
}

export const TESTIMONY_RULE = `EVIDENCE vs TESTIMONY (critical):
- Only the numbered PUBLIC EVIDENCE items are objective facts.
- Everything a person wrote (their alibi) or said (their answers) is TESTIMONY. It may be true, mistaken, or a lie.
- Never treat testimony as established fact. Record it as "X says ...". You may believe, doubt, corroborate, contradict or investigate it, but it stays testimony.
- If testimony is implausible, say it is implausible. Do not quietly replace it with what you think really happened.`;

export const TIME_RULE = `TIMES: write every time in 12-hour form with AM or PM, for example "9:05 PM" or "12:30 AM". Never use 24-hour times like 21:05.`;

export function renderCase(view: DetectiveView): string {
  const lines = [
    `CASE: ${view.title}`,
    view.description,
    `Setting: ${view.setting}`,
    `Victim: ${view.victim}`,
    `Key time window: ${view.timeline.start} to ${view.timeline.end}`,
    "",
    "PUBLIC EVIDENCE (objective facts):",
    ...view.evidence.map((e) => `- [${e.id}] ${e.title}: ${e.text}`),
    "",
    "PEOPLE BEING QUESTIONED (use the id when you refer to them):",
    ...view.players.map((p) => `- ${p.character}${p.blurb ? `, ${p.blurb}` : ""} (id ${p.id}${p.character !== p.playerName ? `, played by ${p.playerName}` : ""})`),
  ];
  if (view.absent.length) {
    lines.push("", "OTHERS CONNECTED TO THE CASE (not present, cannot be questioned, cannot be accused):", ...view.absent.map((a) => `- ${a.name}, ${a.blurb}`));
  }
  lines.push("", "Exactly one of the people being questioned is the culprit.");
  return lines.join("\n");
}

export function renderTestimony(view: DetectiveView): string {
  if (!view.testimony.length) return "(no testimony yet)";
  return view.testimony
    .map((t) =>
      t.kind === "alibi"
        ? `[${t.turnId}] ${t.speaker}'s WRITTEN ALIBI: "${t.answer}"`
        : `[${t.turnId}] Round ${t.round}. Detective to ${t.speaker}: "${t.question}"\n[${t.turnId}] ${t.speaker}: "${t.answer}"${t.timedOut ? " (ran out of time)" : ""}`,
    )
    .join("\n");
}

export function renderClaims(view: DetectiveView, filter?: (id: string) => boolean): string {
  const list = filter ? view.claims.filter((c) => filter(c.id)) : view.claims;
  if (!list.length) return "(none)";
  return list
    .map((c) => {
      const when = c.timeStart ? ` [${c.timeStart}${c.timeEnd ? `-${c.timeEnd}` : ""}]` : "";
      const where = c.location ? ` @${c.location}` : "";
      return `- [${c.id}] (${c.source}${c.source === "answer" ? `, round ${c.round}` : ""}) ${c.statement}${when}${where}`;
    })
    .join("\n");
}

export function renderInferences(view: DetectiveView): string {
  const lines = ["CONTRADICTIONS FOUND:"];
  lines.push(...(view.contradictions.length ? view.contradictions.map((c) => `- [${c.id}] ${c.kind}, ${c.speakers.join(" vs ")}, severity ${c.severity.toFixed(2)}: ${c.explanation}`) : ["(none)"]));
  lines.push("", "CORROBORATIONS FOUND:");
  lines.push(...(view.corroborations.length ? view.corroborations.map((c) => `- [${c.id}] ${c.speakers.join(" + ")}, strength ${c.strength.toFixed(2)}: ${c.explanation}`) : ["(none)"]));
  if (view.openQuestions.length) lines.push("", "OPEN QUESTIONS:", ...view.openQuestions.map((q) => `- ${q.speaker}: ${q.text}`));
  if (view.notes.length) lines.push("", "NOTES:", ...view.notes.map((n) => `- ${n.speaker}: ${n.text}`));
  return lines.join("\n");
}
