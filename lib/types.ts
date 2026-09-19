// Core data model.
//
// Three categories are kept strictly apart:
//   Evidence   - predetermined, objective, from the case file (public text; kind + explanation hidden)
//   Testimony  - anything a player writes (alibi) or says (answers). Stored as claims, never as facts.
//   Inference  - what the detective concludes: contradictions, corroborations, profiles, accusation.
//
// Anything marked "private" must never reach a detective-side prompt.

// ---------- Case content ----------

export type EvidenceKind = "key" | "ambiguous" | "red_herring" | "odd";

export interface CaseEvidence {
  id: string; // "E1".."E5"
  title: string; // public
  text: string; // public
  kind: EvidenceKind; // private until reveal
  explanation: string; // private until reveal
}

export interface CaseCharacter {
  id: string; // "C1".."C5"
  name: string; // public
  blurb: string; // public one-liner, e.g. "Lord Blackwood's physician and old friend"
  // Everything below is private to the player dealt this character.
  background: string;
  relationship: string;
  reasonPresent: string;
  motive: string;
  suspicious: string; // suspicious or embarrassing circumstances
  secret: string | null; // a reason to conceal something (about 30-50% of innocents)
  knows: string[]; // what they saw, heard or know; often involves another character
  culprit: boolean;
  /** Culprit only: what they actually did. Context, not a scripted alibi. */
  whatYouDid?: string[];
  /** Culprit only: things that could expose them. */
  looseEnds?: string[];
}

export interface ChainLink {
  id: string;
  description: string;
  keywords: string[]; // lowercase; a contradiction or accusation mentioning any of them surfaces the link
}

export interface Case {
  id: string;
  title: string;
  description: string; // public, 2-3 sentences
  setting: string;
  victim: string;
  timeline: { start: string; end: string };
  evidence: CaseEvidence[];
  characters: CaseCharacter[];
  /** Private: the true explanation of the crime, revealed at the end. */
  truth: string;
  /** Private: documented contradiction chain that should expose the culprit. */
  chain: ChainLink[];
}

// ---------- Game state ----------

export interface PublicEvidence {
  id: string;
  title: string;
  text: string;
}

export interface Player {
  id: string;
  name: string; // the real person's display name
  characterId: string | null; // engine-internal; never sent to other clients
  characterName: string | null; // public cast identity (see GAME.publicCast)
  characterBlurb: string | null;
  ready: boolean; // ROLE_REVEAL: has read their card
  alibiLocked: boolean;
  connected: boolean;
  speakerLabel: string | null;
}

export type TestimonySource = "alibi" | "answer";

export interface Claim {
  id: string;
  playerId: string;
  source: TestimonySource;
  round: number; // 0 = alibi
  turnId: string;
  subject: string;
  location: string | null;
  timeStart: string | null;
  timeEnd: string | null;
  aboutPlayerIds: string[]; // other players this claim is about
  statement: string; // always phrased as testimony: "X says ..."
}

export type ContradictionKind = "vs_evidence" | "vs_alibi" | "self" | "vs_other_player" | "implausible";

export interface Contradiction {
  id: string;
  kind: ContradictionKind;
  claimIds: string[];
  evidenceId: string | null;
  playerIds: string[]; // players charged
  severity: number; // 0..1
  explanation: string;
  round: number;
}

export interface Corroboration {
  id: string;
  claimIds: string[];
  evidenceId: string | null;
  playerIds: string[]; // players whose testimony is supported
  strength: number; // 0..1
  explanation: string;
  round: number;
}

/** How a spoken or typed answer reached the server. Kept for later delivery/hesitation analysis. */
export interface TurnVoice {
  mode: "typed" | "stt-tts" | "agent";
  /** Where the final text came from: our own STT call, ElevenLabs' record of the conversation, or the phone's report. */
  transcriptSource: "typed" | "stt" | "elevenlabs-api" | "client-reported";
  conversationId?: string;
  /** The user's utterances exactly as recognized, before we joined and trimmed them. */
  segments?: string[];
  /** Milliseconds from the question being asked to the answer arriving. */
  answerMs?: number;
}

export interface Turn {
  id: string;
  kind: TestimonySource;
  round: number;
  playerId: string;
  question: string | null;
  answer: string;
  timedOut: boolean;
  evasive: boolean;
  claimIds: string[];
  voice?: TurnVoice;
}

export interface PlannedQuestion {
  targetPlayerId: string;
  text: string;
}

export interface CurrentQuestion extends PlannedQuestion {
  askedAt: number;
  deadline: number;
}

export interface Note {
  playerId: string;
  text: string;
  round: number;
}

export interface ComponentScores {
  evidence: number;
  alibi: number;
  self: number;
  crossPlayer: number;
  implausible: number;
  evasiveness: number;
  corroboration: number; // subtracted
}

/** Hidden during play. Shown at the final reveal. */
export interface SuspicionProfile {
  playerId: string;
  suspicionScore: number; // 0..100
  rank: number; // 1 = most suspicious
  components: ComponentScores;
  contradictionIds: string[];
  corroborationIds: string[];
  evidenceConflicts: number;
  storyChanges: number;
  openQuestions: string[];
  notes: string[];
  questionsReceived: number;
  claimsMade: number;
}

export interface Accusation {
  accusedPlayerId: string;
  confidence: number;
  reasoning: string;
  keyPoints: string[];
  source: "model" | "fallback";
}

export interface RevealAnalysis {
  summary: string;
  importantLies: { playerId: string; statement: string; truth: string }[];
  misleadingTestimony: { playerId: string; statement: string; effect: string }[];
}

export interface Result {
  playerId: string;
  culprit: boolean;
  accused: boolean;
  outcome: "win" | "lose";
}

export interface Settings {
  rounds: number;
  maxQuestions: number | null; // null = rounds x players
  answerSeconds: number;
  allowEarlyEnd: boolean;
  earlyEndConfidence: number;
}

export type Phase =
  | "LOBBY"
  | "ROLE_REVEAL"
  | "ALIBI_ENTRY"
  | "INTERROGATION"
  | "ROUND_ANALYSIS"
  | "ACCUSATION"
  | "REVEAL"
  | "FINISHED";
export type EndReason = "rounds" | "budget" | "early" | "host";

export interface GameState {
  id: string; // the room code
  createdAt: number;
  phase: Phase;
  settings: Settings;
  caseId: string | null;
  evidence: PublicEvidence[];
  players: Player[];
  /** Characters not dealt to anyone: at the scene but not being questioned. */
  absent: { name: string; blurb: string }[];
  round: number; // 0 before round 1
  roundQueue: PlannedQuestion[]; // hidden
  current: CurrentQuestion | null;
  questionsAsked: number;
  questionsByPlayer: Record<string, number>;
  turns: Turn[];
  claims: Claim[];
  contradictions: Contradiction[];
  corroborations: Corroboration[];
  openQuestions: Note[];
  notes: Note[];
  /** Detective's private reasoning per review, hidden until reveal. */
  reviewLog: { round: number; reasoning: string }[];
  analyzedClaimCount: number;
  profiles: SuspicionProfile[] | null;
  accusation: Accusation | null;
  endReason: EndReason | null;
  revealAnalysis: RevealAnalysis | null;
  busy: boolean;
  error: string | null;
}

/** Secret state. Read only by player views, the reveal, and the sim logger. */
export interface Secrets {
  gameId: string;
  culpritPlayerId: string;
  /** playerId -> characterId */
  characterOf: Record<string, string>;
}
