// Offline stand-in for Nebius. Crude heuristics, good enough to exercise the full game loop,
// the UI and the tests without an API key. Never used for real results.

import type { LLMCallRecord, LLMClient, LLMRequest } from "./types";

type AnyRec = Record<string, any>;

const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/g;
const PLACE_RE = /\b(?:in|at|to|from|near|by|inside|outside) the ([a-z][a-z' -]{2,28}?)(?=[,.;!?]| from| until| till| at| with| and| when| around| about|$)/i;
const NEGATION_RE = /\b(never|didn't|did not|wasn't|was not|not|no one|nobody)\b/i;
const EVASIVE_RE = /\b(don't remember|can't recall|cannot recall|no comment|why does it matter|none of your business|i'd rather not)\b/i;
const STOP = new Set(["the", "and", "was", "were", "with", "from", "that", "this", "their", "there", "they", "your", "have", "been", "into", "until", "about", "which", "while", "after", "before"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9: ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4 && !STOP.has(w)),
  );
}

function toMinutes(t: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function extract(d: AnyRec) {
  const sentences = String(d.answer)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
  const others: AnyRec[] = (d.players ?? []).filter((p: AnyRec) => p.id !== d.speakerId);
  const claims = sentences.slice(0, 6).map((s) => {
    const times = [...s.matchAll(TIME_RE)].map((m) => `${m[1].padStart(2, "0")}:${m[2]}`);
    const place = s.match(PLACE_RE)?.[1]?.trim() ?? null;
    const about = others
      .filter((p) => String(p.character).split(/\s+/).some((w: string) => w.length > 3 && s.toLowerCase().includes(w.toLowerCase())))
      .map((p) => p.id);
    return {
      subject: d.speakerName,
      location: place,
      timeStart: times[0] ?? null,
      timeEnd: times[1] ?? null,
      aboutPlayerIds: about,
      statement: `${d.speakerName} says: ${s}`,
    };
  });
  const answer = String(d.answer);
  return { claims, evasive: d.kind === "answer" && (answer.length < 25 || EVASIVE_RE.test(answer)) };
}

function review(d: AnyRec) {
  const view = d.view as AnyRec;
  const ctx = d.ctx as AnyRec;
  const profiles = d.profiles as AnyRec[];
  const newIds = new Set<string>(ctx.newClaimIds);
  const claims: AnyRec[] = view.claims;
  const contradictions: AnyRec[] = [];
  const corroborations: AnyRec[] = [];
  for (const c of claims.filter((x) => newIds.has(x.id))) {
    const t = toMinutes(c.timeStart);
    for (const p of claims.filter((x) => x.id !== c.id && (!newIds.has(x.id) || Number(x.id.slice(1)) < Number(c.id.slice(1))))) {
      const pt = toMinutes(p.timeStart);
      if (t === null || pt === null || !c.location || !p.location || Math.abs(t - pt) > 10) continue;
      const samePlace = c.location.toLowerCase() === p.location.toLowerCase();
      if (samePlace && p.playerId !== c.playerId) {
        corroborations.push({ claimIds: [p.id, c.id], evidenceId: null, strength: 0.5, explanation: `${c.speaker} and ${p.speaker} both place themselves at ${c.location} around ${c.timeStart}.` });
      } else if (!samePlace && p.playerId === c.playerId) {
        contradictions.push({ kind: "self", claimIds: [p.id, c.id], evidenceId: null, severity: 0.7, explanation: `${c.speaker} now says ${c.location} around ${c.timeStart}, but earlier said ${p.location} around ${p.timeStart}.` });
      }
    }
    if (NEGATION_RE.test(c.statement)) {
      const cw = words(c.statement);
      for (const e of view.evidence as AnyRec[]) {
        const overlap = [...words(`${e.title} ${e.text}`)].filter((w) => cw.has(w));
        if (overlap.length >= 2) {
          contradictions.push({ kind: "vs_evidence", claimIds: [c.id], evidenceId: e.id, severity: 0.8, explanation: `${c.speaker} denies something that evidence ${e.id} records (${overlap.slice(0, 3).join(", ")}).` });
          break;
        }
      }
    }
  }
  const players = view.players as AnyRec[];
  let questions: AnyRec[] = [];
  if (ctx.nextRound === 1) {
    questions = players.map((p) => ({ targetPlayerId: p.id, question: `${p.character}, ${OPENERS[0]}` }));
  } else if (ctx.nextRound) {
    const ranked = [...profiles].sort((a, b) => a.rank - b.rank || a.questionsReceived - b.questionsReceived);
    for (let i = 0; i < ctx.questionsForNextRound; i++) {
      const target = ranked[i % Math.min(2, ranked.length)];
      const p = players.find((x) => x.id === target.playerId)!;
      const x = (view.contradictions as AnyRec[]).filter((c) => c.speakers.includes(p.character)).slice(-1)[0];
      questions.push({ targetPlayerId: target.playerId, question: x ? `${p.character}, explain this: ${x.explanation}` : `${p.character}, ${OPENERS[(i + 1) % OPENERS.length]}` });
    }
  }
  return {
    contradictions: contradictions.slice(0, 10),
    corroborations: corroborations.slice(0, 10),
    openQuestions: [],
    notes: [],
    reasoning: `Mock review after round ${ctx.completedRound}.`,
    endInvestigation: ctx.nextRound === null,
    confidence: 0.5,
    questions,
  };
}

const OPENERS = [
  "walk me through exactly where you were during the key window, minute by minute.",
  "who can confirm where you were, and at what time?",
  "what did you see or hear that seemed out of place tonight?",
  "when did you last see anyone near the scene, and who was it?",
  "tell me about the moment you first heard something was wrong. Where were you?",
];

function accuse(d: AnyRec) {
  const top = [...(d.profiles as AnyRec[])].sort((a, b) => a.rank - b.rank)[0];
  const p = (d.players as AnyRec[]).find((x) => x.id === top.playerId);
  return {
    accusedPlayerId: top.playerId,
    confidence: 0.6,
    reasoning: `I accuse ${p?.character}. Their testimony produced the most contradictions with the evidence and with the others. That is testimony weighed against evidence, and it does not hold.`,
    keyPoints: ["Most contradictions", `Suspicion score ${top.suspicionScore}`],
  };
}

function playerText(req: LLMRequest, d: AnyRec): string {
  const facts: string[] = d?.facts ?? [];
  if (req.purpose === "player-alibi") return facts[0] ?? "I was around the main room most of the evening.";
  const q = words(String(d?.question ?? ""));
  const scored = facts.map((f) => ({ f, s: [...words(f)].filter((w) => q.has(w)).length }));
  scored.sort((a, b) => b.s - a.s);
  const pick = scored[0]?.f ?? "I honestly don't remember the details.";
  if (d?.guilty && /you (used|took|switched|crushed|ran|slipped|carried|walked|went|stepped|rode|loaded|hid|came back|bought|asked)/i.test(pick)) {
    return "I was where I told you. I never went near there.";
  }
  return pick.replace(/\bYou\b/g, "I").replace(/\byou\b/g, "I").replace(/\byour\b/gi, "my");
}

export function createMockClient(): LLMClient {
  return {
    provider: "mock",
    async complete(req) {
      const started = Date.now();
      const d = (req.mockData ?? {}) as AnyRec;
      let text: string;
      switch (req.purpose) {
        case "extractor":
          text = JSON.stringify(extract(d));
          break;
        case "review":
          text = JSON.stringify(review(d));
          break;
        case "accusation":
          text = JSON.stringify(accuse(d));
          break;
        case "reveal":
          text = JSON.stringify({ summary: d.truth, importantLies: [], misleadingTestimony: [] });
          break;
        default:
          text = playerText(req, d);
      }
      const inputTokens = Math.ceil((req.system.length + req.user.length) / 4);
      const outputTokens = Math.ceil(text.length / 4);
      const record: LLMCallRecord = {
        at: new Date().toISOString(),
        purpose: req.purpose,
        provider: "mock",
        model: req.model,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - started,
        costUsd: 0,
        ok: true,
        system: req.system,
        user: req.user,
        response: text,
      };
      return { text, record };
    },
  };
}
