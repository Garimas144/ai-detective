// The only place client payloads are built. Each function returns exactly what one audience may see.
//   publicView  -> shared screen and every player (no private cards, alibis, or detective state before the reveal)
//   playerView  -> one player's device (public view + that player's own card and alibi)
//   hostView    -> shared screen controls (public view; detective internals only with DEBUG_HOST=1)

import { caseCards, getCase } from "../lib/cases";
import { GAME } from "../lib/config";
import { computeResults, maxQuestions } from "../lib/game/engine";
import type { ClientPayload, PlayerPrivate, PublicView, RevealData } from "../lib/protocol";
import type { GameState, Secrets } from "../lib/types";

export interface ViewContext {
  state: GameState;
  secrets: Secrets | null;
  llmProvider: "nebius" | "mock";
  voiceEnabled: boolean;
  publicUrl: string | null;
}

const REVEALED: GameState["phase"][] = ["REVEAL", "FINISHED"];
const ACCUSED: GameState["phase"][] = ["ACCUSATION", ...REVEALED];

function revealData(state: GameState, secrets: Secrets): RevealData {
  const c = getCase(state.caseId!);
  return {
    title: c.title,
    truth: c.truth,
    evidence: c.evidence,
    characters: state.players.map((p) => ({ playerId: p.id, card: c.characters.find((x) => x.id === secrets.characterOf[p.id])! })),
    alibis: state.turns.filter((t) => t.kind === "alibi").map((t) => ({ playerId: t.playerId, text: t.answer })),
    culpritPlayerId: secrets.culpritPlayerId,
    results: computeResults(state, secrets),
    analysis: state.revealAnalysis,
    accusation: state.accusation!,
    profiles: state.profiles ?? [],
    contradictions: state.contradictions,
    corroborations: state.corroborations,
    claims: state.claims,
    reviewLog: state.reviewLog,
  };
}

export function publicView(ctx: ViewContext): PublicView {
  const { state, secrets } = ctx;
  const c = state.caseId ? getCase(state.caseId) : null;
  const revealed = REVEALED.includes(state.phase) && !!secrets && !!state.accusation;
  const showCast = GAME.publicCast || revealed;
  return {
    code: state.id,
    phase: state.phase,
    settings: state.settings,
    publicUrl: ctx.publicUrl,
    cases: state.phase === "LOBBY" ? caseCards() : [],
    case: c ? { id: c.id, title: c.title, description: c.description, setting: c.setting, victim: c.victim } : null,
    evidence: state.evidence,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      characterName: showCast ? p.characterName : null,
      characterBlurb: showCast ? p.characterBlurb : null,
      ready: p.ready,
      alibiLocked: p.alibiLocked,
      connected: p.connected,
      questionsReceived: state.questionsByPlayer[p.id] ?? 0,
    })),
    minPlayers: GAME.minPlayers,
    maxPlayers: GAME.maxPlayers,
    round: state.round,
    current: state.current
      ? { targetPlayerId: state.current.targetPlayerId, text: state.current.text, askedAt: state.current.askedAt, deadline: state.current.deadline }
      : null,
    questionsAsked: state.questionsAsked,
    maxQuestions: state.players.length ? maxQuestions(state) : 0,
    transcript: state.turns
      .filter((t) => t.kind === "answer")
      .map(({ id, round, playerId, question, answer, timedOut }) => ({ id, round, playerId, question, answer, timedOut })),
    accusation: ACCUSED.includes(state.phase) ? state.accusation : null,
    endReason: ACCUSED.includes(state.phase) ? state.endReason : null,
    reveal: revealed ? revealData(state, secrets!) : null,
    busy: state.busy,
    error: state.error,
    llmProvider: ctx.llmProvider,
    voiceEnabled: ctx.voiceEnabled,
    serverNow: Date.now(),
  };
}

export function playerPrivate(ctx: ViewContext, playerId: string): PlayerPrivate {
  const { state, secrets } = ctx;
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error("Unknown player.");
  const c = state.caseId ? getCase(state.caseId) : null;
  const card = c && secrets ? c.characters.find((x) => x.id === secrets.characterOf[playerId]) ?? null : null;
  return {
    id: player.id,
    name: player.name,
    card,
    alibi: state.turns.find((t) => t.kind === "alibi" && t.playerId === playerId)?.answer ?? null,
    isMyTurn: state.phase === "INTERROGATION" && state.current?.targetPlayerId === playerId,
    result: REVEALED.includes(state.phase) && secrets ? computeResults(state, secrets).find((r) => r.playerId === playerId) ?? null : null,
  };
}

export function playerView(ctx: ViewContext, playerId: string): ClientPayload {
  return { role: "player", view: publicView(ctx), me: playerPrivate(ctx, playerId) };
}

export function hostView(ctx: ViewContext): ClientPayload {
  return { role: "host", view: publicView(ctx), debug: process.env.DEBUG_HOST === "1" ? ctx.state : null };
}
