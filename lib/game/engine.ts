// The one game engine. Used by the realtime server (server/rooms.ts) and by the headless simulation runner.
// Functions mutate the GameState they are given. Secrets are passed explicitly and never reach
// detective-side prompt builders (extractor, review, accusation).

import { DEFAULT_WEIGHTS, GAME, type ScoringWeights } from "../config";
import { getCase, publicEvidence } from "../cases";
import { callJson } from "../llm/json";
import type { CallSink, LLMClient } from "../llm/types";
import { accusationSchema, buildAccusationRequest } from "../prompts/accusation";
import { buildExtractorRequest, extractorSchema } from "../prompts/extractor";
import { buildReviewRequest, reviewSchema, type ReviewOutput } from "../prompts/review";
import { buildRevealFacts, buildRevealRequest, revealSchema } from "../prompts/reveal";
import { verifyReveal } from "./revealCheck";
import { buildProfiles, topSuspect } from "../scoring";
import type {
  Claim,
  Contradiction,
  Corroboration,
  EndReason,
  GameState,
  PlannedQuestion,
  Player,
  Result,
  Secrets,
  Settings,
  Turn,
  TurnVoice,
} from "../types";
import { dealCharacters, type Rng } from "./deal";
import { buildDetectiveView, detectiveName } from "./detectiveView";

export interface EngineDeps {
  llm: LLMClient;
  rng: Rng;
  weights?: ScoringWeights;
  onCall?: CallSink;
  now?: () => number;
  /** Called when state changes mid-operation (e.g. before a slow model call) so clients can be updated. */
  onChange?: (state: GameState) => void;
  /** Extra time before the answer clock starts, e.g. while the question is read aloud. */
  questionLeadMs?: (text: string) => number;
}

const weightsOf = (deps: EngineDeps) => deps.weights ?? DEFAULT_WEIGHTS;
const nowOf = (deps: EngineDeps) => (deps.now ?? Date.now)();
const notify = (state: GameState, deps: EngineDeps) => deps.onChange?.(state);

export function newId(prefix: string, rng: Rng = Math.random): string {
  return `${prefix}_${Math.floor(rng() * 36 ** 8).toString(36).padStart(8, "0")}`;
}

export function createGame(id: string, settings?: Partial<Settings>): GameState {
  return {
    id,
    createdAt: Date.now(),
    phase: "LOBBY",
    settings: {
      rounds: GAME.defaultRounds,
      maxQuestions: null,
      answerSeconds: GAME.defaultAnswerSeconds,
      allowEarlyEnd: true,
      earlyEndConfidence: GAME.earlyEndConfidence,
      ...settings,
    },
    caseId: null,
    evidence: [],
    players: [],
    absent: [],
    round: 0,
    roundQueue: [],
    current: null,
    questionsAsked: 0,
    questionsByPlayer: {},
    turns: [],
    claims: [],
    contradictions: [],
    corroborations: [],
    openQuestions: [],
    notes: [],
    reviewLog: [],
    analyzedClaimCount: 0,
    profiles: null,
    accusation: null,
    assessments: [],
    endReason: null,
    revealAnalysis: null,
    busy: false,
    error: null,
  };
}

function requirePhase(state: GameState, ...phases: GameState["phase"][]) {
  if (!phases.includes(state.phase)) throw new Error(`Not allowed in phase "${state.phase}".`);
}

export function maxQuestions(state: GameState): number {
  return state.settings.maxQuestions ?? state.settings.rounds * state.players.length * GAME.questionsPerRoundPerPlayer;
}

// ---------- Setup ----------

export function selectCase(state: GameState, caseId: string) {
  requirePhase(state, "LOBBY");
  const c = getCase(caseId);
  state.caseId = c.id;
  state.evidence = publicEvidence(c);
}

export function addPlayer(state: GameState, name: string, id?: string): Player {
  requirePhase(state, "LOBBY");
  const clean = name.trim().slice(0, 24);
  if (!clean) throw new Error("Name required.");
  if (state.players.length >= GAME.maxPlayers) throw new Error(`At most ${GAME.maxPlayers} players.`);
  if (state.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) throw new Error("Name already taken.");
  const player: Player = {
    id: id ?? newId("p"),
    name: clean,
    characterId: null,
    characterName: null,
    characterBlurb: null,
    ready: false,
    alibiLocked: false,
    connected: false,
    speakerLabel: null,
  };
  state.players.push(player);
  return player;
}

export function removePlayer(state: GameState, playerId: string) {
  requirePhase(state, "LOBBY");
  state.players = state.players.filter((p) => p.id !== playerId);
}

export function updateSettings(state: GameState, patch: Partial<Settings>) {
  requirePhase(state, "LOBBY");
  const s = state.settings;
  if (patch.rounds !== undefined) s.rounds = Math.max(1, Math.min(5, Math.round(patch.rounds)));
  if (patch.answerSeconds !== undefined) s.answerSeconds = Math.max(10, Math.min(120, Math.round(patch.answerSeconds)));
  if (patch.maxQuestions !== undefined) s.maxQuestions = patch.maxQuestions === null ? null : Math.max(1, Math.round(patch.maxQuestions));
  if (patch.allowEarlyEnd !== undefined) s.allowEarlyEnd = patch.allowEarlyEnd;
}

/** Deals characters privately and moves to ROLE_REVEAL. Returns the secrets for the caller to store. */
export function deal(state: GameState, rng: Rng): Secrets {
  requirePhase(state, "LOBBY");
  if (!state.caseId) throw new Error("Pick a case first.");
  if (state.players.length < GAME.minPlayers) throw new Error(`Need at least ${GAME.minPlayers} players.`);
  const c = getCase(state.caseId);
  const { secrets, absent } = dealCharacters(state.id, c, state.players, rng);
  for (const p of state.players) {
    const ch = c.characters.find((x) => x.id === secrets.characterOf[p.id])!;
    p.characterId = ch.id; // needed by the player's own view; stripped from public payloads
    p.characterName = ch.name;
    p.characterBlurb = ch.blurb;
    p.ready = false;
  }
  state.absent = absent;
  state.questionsByPlayer = Object.fromEntries(state.players.map((p) => [p.id, 0]));
  state.phase = "ROLE_REVEAL";
  return secrets;
}

/** A player has read their character card. When everyone is ready, alibi entry opens. */
export function setReady(state: GameState, playerId: string) {
  requirePhase(state, "ROLE_REVEAL");
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error("Unknown player.");
  player.ready = true;
  if (state.players.every((p) => p.ready)) state.phase = "ALIBI_ENTRY";
}

/** Host moves on without waiting for every Ready tap. */
export function openAlibis(state: GameState) {
  requirePhase(state, "ROLE_REVEAL");
  state.phase = "ALIBI_ENTRY";
}

// ---------- Testimony ----------

const ATTRIBUTION = /\b(says|said|claims|claimed|states|stated|writes|wrote|told|tells|reports|recalls|admits|denies|insists|alleges|according to)\b/i;

/** Testimony must never read as fact. If the model dropped the attribution, add it back. */
export function asTestimony(statement: string, speaker: string): string {
  const s = statement.trim();
  return ATTRIBUTION.test(s) ? s : `${speaker} says: ${s}`;
}

async function recordTestimony(
  state: GameState,
  deps: EngineDeps,
  playerId: string,
  kind: Turn["kind"],
  question: string | null,
  text: string,
  timedOut = false,
  voice?: TurnVoice,
): Promise<Turn> {
  const c = getCase(state.caseId!);
  const player = state.players.find((p) => p.id === playerId)!;
  const turn: Turn = {
    id: `T${state.turns.length + 1}`,
    kind,
    round: kind === "alibi" ? 0 : state.round,
    playerId,
    question,
    answer: text.trim() || "(no answer)",
    timedOut,
    evasive: timedOut,
    claimIds: [],
    voice,
  };
  state.turns.push(turn);
  notify(state, deps);
  if (!text.trim()) return turn;
  try {
    const out = await callJson(
      deps.llm,
      buildExtractorRequest(buildDetectiveView(state, c), { id: playerId, character: detectiveName(player) }, kind, question, turn.answer),
      extractorSchema,
      deps.onCall,
    );
    turn.evasive = turn.evasive || (kind === "answer" && out.evasive);
    const validIds = new Set(state.players.map((p) => p.id));
    const claims: Claim[] = out.claims.map((x, i) => ({
      id: `C${state.claims.length + i + 1}`,
      playerId,
      source: kind,
      round: turn.round,
      turnId: turn.id,
      subject: x.subject,
      location: x.location ?? null,
      timeStart: x.timeStart ?? null,
      timeEnd: x.timeEnd ?? null,
      aboutPlayerIds: (x.aboutPlayerIds ?? []).filter((id) => validIds.has(id) && id !== playerId),
      statement: asTestimony(x.statement, detectiveName(player)),
    }));
    state.claims.push(...claims);
    turn.claimIds = claims.map((x) => x.id);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    console.error("[engine] testimony extraction failed:", state.error);
  }
  return turn;
}

/** Alibis are mandatory and immutable once submitted. */
export async function submitAlibi(state: GameState, deps: EngineDeps, playerId: string, text: string) {
  requirePhase(state, "ALIBI_ENTRY");
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error("Unknown player.");
  if (player.alibiLocked) throw new Error("Your alibi is already locked in.");
  const clean = text.trim();
  if (clean.length < 10) throw new Error("Write at least a sentence: where you were, when, and with whom.");
  player.alibiLocked = true;
  await recordTestimony(state, deps, playerId, "alibi", null, clean.slice(0, 1200));
}

// ---------- Rounds ----------

function askNext(state: GameState, deps: EngineDeps) {
  const next = state.roundQueue.shift();
  if (!next) {
    state.current = null;
    return;
  }
  const now = nowOf(deps);
  const lead = deps.questionLeadMs?.(next.text) ?? 0;
  state.current = { ...next, askedAt: now, deadline: now + lead + state.settings.answerSeconds * 1000 };
  state.questionsAsked += 1;
  state.questionsByPlayer[next.targetPlayerId] = (state.questionsByPlayer[next.targetPlayerId] ?? 0) + 1;
  state.phase = "INTERROGATION";
  notify(state, deps);
}

export function computeProfiles(state: GameState, weights: ScoringWeights = DEFAULT_WEIGHTS) {
  return buildProfiles(
    {
      playerIds: state.players.map((p) => p.id),
      contradictions: state.contradictions,
      corroborations: state.corroborations,
      turns: state.turns,
      claims: state.claims,
      questionsByPlayer: state.questionsByPlayer,
      openQuestions: state.openQuestions,
      notes: state.notes,
    },
    weights,
  );
}

/** Validates and stores the analysis half of a review. */
function applyAnalysis(state: GameState, out: ReviewOutput, newClaimIds: Set<string>) {
  const claimById = new Map(state.claims.map((c) => [c.id, c]));
  const evidenceIds = new Set(state.evidence.map((e) => e.id));
  const playerIds = new Set(state.players.map((p) => p.id));
  const key = (ids: string[], ev: string | null | undefined) => [...ids].sort().join("|") + "#" + (ev ?? "");
  const seenX = new Set(state.contradictions.map((c) => key(c.claimIds, c.evidenceId)));
  const seenC = new Set(state.corroborations.map((c) => key(c.claimIds, c.evidenceId)));

  for (const r of out.contradictions) {
    const claims = [...new Set(r.claimIds)].map((id) => claimById.get(id)).filter((c): c is Claim => !!c);
    if (!claims.length || !claims.some((c) => newClaimIds.has(c.id))) continue;
    const evidenceId = r.evidenceId && evidenceIds.has(r.evidenceId) ? r.evidenceId : null;
    let kind: Contradiction["kind"];
    let charged: string[];
    if (claims.length === 2) {
      const [a, b] = claims;
      if (a.playerId !== b.playerId) {
        kind = "vs_other_player";
        charged = [a.playerId, b.playerId];
      } else {
        kind = a.source === "alibi" || b.source === "alibi" ? "vs_alibi" : "self";
        charged = [a.playerId];
      }
    } else if (evidenceId) {
      kind = "vs_evidence";
      charged = [claims[0].playerId];
    } else if (r.kind === "implausible") {
      kind = "implausible";
      charged = [claims[0].playerId];
    } else continue;
    const k = key(claims.map((c) => c.id), evidenceId);
    if (seenX.has(k)) continue;
    seenX.add(k);
    state.contradictions.push({
      id: `X${state.contradictions.length + 1}`,
      kind,
      claimIds: claims.map((c) => c.id),
      evidenceId: kind === "vs_evidence" ? evidenceId : null,
      playerIds: charged,
      severity: Math.max(0, Math.min(1, r.severity)),
      explanation: r.explanation.trim(),
      round: state.round,
    });
  }

  for (const r of out.corroborations) {
    const claims = [...new Set(r.claimIds)].map((id) => claimById.get(id)).filter((c): c is Claim => !!c);
    if (!claims.length || !claims.some((c) => newClaimIds.has(c.id))) continue;
    const evidenceId = r.evidenceId && evidenceIds.has(r.evidenceId) ? r.evidenceId : null;
    const supported = [...new Set(claims.map((c) => c.playerId))];
    // A corroboration needs independent support: another person, or the evidence.
    if (supported.length < 2 && !evidenceId) continue;
    const k = key(claims.map((c) => c.id), evidenceId);
    if (seenC.has(k)) continue;
    seenC.add(k);
    const corr: Corroboration = {
      id: `K${state.corroborations.length + 1}`,
      claimIds: claims.map((c) => c.id),
      evidenceId,
      playerIds: supported,
      strength: Math.max(0, Math.min(1, r.strength)),
      explanation: r.explanation.trim(),
      round: state.round,
    };
    state.corroborations.push(corr);
  }

  for (const q of out.openQuestions) if (playerIds.has(q.playerId)) state.openQuestions.push({ playerId: q.playerId, text: q.text, round: state.round });
  for (const n of out.notes) if (playerIds.has(n.playerId)) state.notes.push({ playerId: n.playerId, text: n.text, round: state.round });
  state.reviewLog.push({ round: state.round, reasoning: out.reasoning });
}

function planRoundOne(state: GameState, planned: PlannedQuestion[]): PlannedQuestion[] {
  const out: PlannedQuestion[] = [];
  for (const q of planned) if (!out.some((x) => x.targetPlayerId === q.targetPlayerId)) out.push(q);
  for (const p of state.players)
    if (!out.some((x) => x.targetPlayerId === p.id))
      out.push({ targetPlayerId: p.id, text: `${detectiveName(p)}, where exactly were you at ${getCase(state.caseId!).timeline.start}, and who else was in that room?` });
  return out;
}

/** Between-round review: analysis of new testimony, then either a plan for the next round or the end. */
async function review(state: GameState, deps: EngineDeps, final: boolean): Promise<{ plan: PlannedQuestion[]; endEarly: boolean }> {
  const c = getCase(state.caseId!);
  const newClaims = state.claims.slice(state.analyzedClaimCount);
  const completed = state.round;
  const remaining = maxQuestions(state) - state.questionsAsked;
  const nextRound = final || completed >= state.settings.rounds || remaining <= 0 ? null : completed + 1;
  const perRound = state.players.length * GAME.questionsPerRoundPerPlayer;
  const questionsForNextRound = nextRound === null ? 0 : Math.min(perRound, remaining);
  const earlyEndAllowed = state.settings.allowEarlyEnd && completed >= 1;

  state.phase = "ROUND_ANALYSIS";
  state.current = null;
  notify(state, deps);
  let plan: PlannedQuestion[] = [];
  let endEarly = false;
  try {
    const out = await callJson(
      deps.llm,
      buildReviewRequest(buildDetectiveView(state, c), computeProfiles(state, weightsOf(deps)), {
        completedRound: completed,
        nextRound,
        totalRounds: state.settings.rounds,
        questionsForNextRound,
        earlyEndAllowed,
        newClaimIds: newClaims.map((x) => x.id),
      }),
      reviewSchema,
      deps.onCall,
    );
    applyAnalysis(state, out, new Set(newClaims.map((x) => x.id)));
    const valid = new Set(state.players.map((p) => p.id));
    plan = out.questions.filter((q) => valid.has(q.targetPlayerId)).map((q) => ({ targetPlayerId: q.targetPlayerId, text: q.question.trim() }));
    endEarly = earlyEndAllowed && nextRound !== null && nextRound > 1 && out.endInvestigation && out.confidence >= state.settings.earlyEndConfidence;
    state.error = null;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    console.error("[engine] review failed:", state.error);
  }
  state.analyzedClaimCount = state.claims.length;

  if (nextRound === null) return { plan: [], endEarly: false };
  if (nextRound === 1) return { plan: planRoundOne(state, plan), endEarly: false };
  if (!plan.length && !endEarly) {
    const suspect = topSuspect(computeProfiles(state, weightsOf(deps)));
    const suspectPlayer = state.players.find((p) => p.id === suspect);
    const name = suspectPlayer ? detectiveName(suspectPlayer) : "";
    plan = [{ targetPlayerId: suspect, text: `${name}, what time exactly did you last see the victim area, and who can confirm it?` }];
  }
  return { plan: plan.slice(0, questionsForNextRound), endEarly };
}

export async function beginInterrogation(state: GameState, deps: EngineDeps) {
  requirePhase(state, "ALIBI_ENTRY");
  const missing = state.players.filter((p) => !p.alibiLocked);
  if (missing.length) throw new Error(`Waiting for alibis from ${missing.map((p) => p.name).join(", ")}.`);
  const { plan } = await review(state, deps, false);
  state.round = 1;
  state.roundQueue = plan;
  askNext(state, deps);
}

async function endRound(state: GameState, deps: EngineDeps) {
  const outOfRounds = state.round >= state.settings.rounds;
  const outOfBudget = state.questionsAsked >= maxQuestions(state);
  if (outOfRounds || outOfBudget) {
    await review(state, deps, true);
    return finish(state, deps, outOfRounds ? "rounds" : "budget");
  }
  const { plan, endEarly } = await review(state, deps, false);
  if (endEarly) return finish(state, deps, "early");
  state.round += 1;
  state.roundQueue = plan;
  askNext(state, deps);
}

export async function submitAnswer(
  state: GameState,
  deps: EngineDeps,
  playerId: string | null,
  text: string,
  opts: { timedOut?: boolean; voice?: TurnVoice } = {},
) {
  requirePhase(state, "INTERROGATION");
  const q = state.current;
  if (!q) throw new Error("No question is waiting for an answer.");
  if (playerId && playerId !== q.targetPlayerId) throw new Error("This question isn't for you.");
  const late = nowOf(deps) > q.deadline + GAME.answerGraceSeconds * 1000;
  state.current = null;
  const voice = opts.voice ?? (text.trim() ? { mode: "typed" as const, transcriptSource: "typed" as const } : undefined);
  if (voice) voice.answerMs = nowOf(deps) - q.askedAt;
  await recordTestimony(state, deps, q.targetPlayerId, "answer", q.text, text, !!opts.timedOut || late, voice);
  if (state.roundQueue.length && state.questionsAsked < maxQuestions(state)) askNext(state, deps);
  else await endRound(state, deps);
}

/** Host ends the investigation early. An asked-but-unanswered question is refunded. */
export async function endInvestigationNow(state: GameState, deps: EngineDeps) {
  requirePhase(state, "INTERROGATION");
  if (state.current) {
    state.questionsAsked -= 1;
    state.questionsByPlayer[state.current.targetPlayerId] -= 1;
    state.current = null;
  }
  state.roundQueue = [];
  if (state.claims.length > state.analyzedClaimCount) await review(state, deps, true);
  await finish(state, deps, "host");
}

// ---------- Accusation and reveal ----------

async function finish(state: GameState, deps: EngineDeps, reason: EndReason) {
  state.endReason = reason;
  state.current = null;
  state.roundQueue = [];
  state.phase = "ROUND_ANALYSIS";
  notify(state, deps);
  const profiles = computeProfiles(state, weightsOf(deps));
  state.profiles = profiles;
  const c = getCase(state.caseId!);
  try {
    const out = await callJson(deps.llm, buildAccusationRequest(buildDetectiveView(state, c), profiles), accusationSchema, deps.onCall);
    if (!state.players.some((p) => p.id === out.accusedPlayerId)) throw new Error(`accused unknown player ${out.accusedPlayerId}`);
    state.accusation = { accusedPlayerId: out.accusedPlayerId, confidence: out.confidence, reasoning: out.reasoning, keyPoints: out.keyPoints, source: "model" };
    state.assessments = out.assessments.filter((a) => state.players.some((p) => p.id === a.playerId));
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    const suspect = topSuspect(profiles);
    const suspectPlayer = state.players.find((p) => p.id === suspect);
    const name = suspectPlayer ? detectiveName(suspectPlayer) : "";
    state.accusation = {
      accusedPlayerId: suspect,
      confidence: 0.5,
      reasoning: `I accuse ${name}. Their account produced the most unresolved contradictions with the evidence and with everyone else's testimony.`,
      keyPoints: ["Highest suspicion score"],
      source: "fallback",
    };
  }
  state.phase = "ACCUSATION";
}

export async function revealTruth(state: GameState, deps: EngineDeps, secrets: Secrets) {
  requirePhase(state, "ACCUSATION");
  const c = getCase(state.caseId!);
  try {
    const out = await callJson(deps.llm, buildRevealRequest(state, c, secrets, state.accusation!), revealSchema, deps.onCall);
    // Never show a guess as a fact: keep only lies that quote real testimony and cite case-file facts.
    state.revealAnalysis = verifyReveal(out, state, buildRevealFacts(state, c, secrets));
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.revealAnalysis = { summary: c.truth, importantLies: [], misleadingTestimony: [] };
  }
  state.phase = "REVEAL";
}

export function finishGame(state: GameState) {
  requirePhase(state, "REVEAL");
  state.phase = "FINISHED";
}

/** Culprit wins unless accused. An innocent loses only if accused. */
export function computeResults(state: GameState, secrets: Secrets): Result[] {
  const accused = state.accusation?.accusedPlayerId;
  return state.players.map((p) => {
    const culprit = p.id === secrets.culpritPlayerId;
    const isAccused = p.id === accused;
    return { playerId: p.id, culprit, accused: isAccused, outcome: isAccused ? "lose" : "win" };
  });
}
