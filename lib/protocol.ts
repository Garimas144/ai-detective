// Shared client/server protocol. Types only (plus event names), safe to import from React pages.
//
// Three audiences get three different payloads, built in server/views.ts:
//   PublicView      shared screen and everyone: never contains private cards, alibis, or detective state
//   PlayerPrivate   one player's own device only: their own card and alibi
//   (the AI detective's view is built separately in lib/game/detectiveView.ts)

import type {
  Accusation,
  CaseCharacter,
  CaseEvidence,
  Claim,
  Contradiction,
  Corroboration,
  EndReason,
  Phase,
  PublicEvidence,
  Result,
  RevealAnalysis,
  Settings,
  SuspicionProfile,
} from "./types";

export const EVENTS = {
  /** server -> client: the latest view for this socket's audience */
  state: "state",
  /** server -> client: this player was removed from the room */
  kicked: "kicked",
  hostCreate: "host:create",
  playerJoin: "player:join",
  sessionResume: "session:resume",
  hostAction: "host:action",
  playerAction: "player:action",
  voiceAnswer: "player:voiceAnswer",
  agentToken: "voice:agentToken",
  agentAnswer: "player:agentAnswer",
  tts: "host:tts",
} as const;

export type Ack<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface CaseCard {
  id: string;
  title: string;
  description: string;
  setting: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  characterName: string | null; // null unless GAME.publicCast (or after the reveal)
  characterBlurb: string | null;
  ready: boolean;
  alibiLocked: boolean;
  connected: boolean;
  questionsReceived: number;
}

export interface TranscriptLine {
  id: string;
  round: number;
  playerId: string;
  question: string | null;
  answer: string;
  timedOut: boolean;
}

/** Everything revealed at the end. Only present in REVEAL and FINISHED. */
export interface RevealData {
  title: string;
  truth: string;
  evidence: CaseEvidence[];
  characters: { playerId: string; card: CaseCharacter }[];
  alibis: { playerId: string; text: string }[];
  culpritPlayerId: string;
  results: Result[];
  analysis: RevealAnalysis | null;
  accusation: Accusation;
  profiles: SuspicionProfile[];
  caseFile: CaseFileEntry[];
  contradictions: Contradiction[];
  corroborations: Corroboration[];
  claims: Claim[];
  reviewLog: { round: number; reasoning: string }[];
}

/** One person's file: the itemized score, what made them suspicious, and what checked out. Reveal only. */
export interface CaseFileEntry {
  playerId: string;
  suspicionScore: number;
  rank: number;
  /** Findings that raised suspicion, most damaging first, with the points each added. */
  suspicious: { kind: string; points: number; text: string; quotes: string[] }[];
  /** Findings that held up. */
  checkedOut: { text: string; strength: number; quotes: string[] }[];
  /** The detective's own wording per person (may be empty if the model omitted it). */
  detective: { suspicious: string[]; checkedOut: string[] } | null;
  questionsReceived: number;
  evasiveAnswers: number;
}

export interface PublicView {
  code: string;
  phase: Phase;
  settings: Settings;
  publicUrl: string | null;
  cases: CaseCard[]; // for the lobby picker
  case: { id: string; title: string; description: string; setting: string; victim: string } | null;
  evidence: PublicEvidence[];
  players: PublicPlayer[];
  minPlayers: number;
  maxPlayers: number;
  round: number;
  current: { targetPlayerId: string; text: string; askedAt: number; deadline: number } | null;
  questionsAsked: number;
  maxQuestions: number;
  transcript: TranscriptLine[];
  accusation: Accusation | null; // ACCUSATION onward
  endReason: EndReason | null;
  reveal: RevealData | null; // REVEAL onward
  busy: boolean;
  error: string | null;
  llmProvider: "nebius" | "mock";
  /** agent = ElevenLabs Conversational AI on the phone; stt-tts = recorder + text-to-speech fallback; text = typing */
  voiceMode: "agent" | "stt-tts" | "text";
  serverNow: number;
}

export interface PlayerPrivate {
  id: string;
  name: string;
  card: CaseCharacter | null; // this player's own card only
  alibi: string | null; // this player's own locked alibi
  isMyTurn: boolean;
  result: Result | null; // REVEAL onward
}

export type ClientPayload =
  | { role: "host"; view: PublicView; debug: unknown | null }
  | { role: "player"; view: PublicView; me: PlayerPrivate };

export type HostAction =
  | { type: "selectCase"; caseId: string }
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "kick"; playerId: string }
  | { type: "start" } // deal characters -> ROLE_REVEAL
  | { type: "openAlibis" } // skip waiting for Ready taps
  | { type: "devFillAlibis" }
  | { type: "begin" } // -> ROUND_ANALYSIS (alibis) -> INTERROGATION
  | { type: "skipAnswer" }
  | { type: "endNow" }
  | { type: "reveal" }
  | { type: "finish" };

export type PlayerAction =
  | { type: "ready" }
  | { type: "alibi"; text: string }
  | { type: "answer"; text: string; timedOut?: boolean };

export interface SessionInfo {
  code: string;
  role: "host" | "player";
  token: string;
  playerId?: string;
  name?: string;
}

/** localStorage key for a saved session. */
export const sessionKey = (code: string, role: "host" | "player") => `ai-detective:${code.toUpperCase()}:${role}`;
