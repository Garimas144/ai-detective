// Server-authoritative rooms. One Room = one game. Transport-agnostic: the socket layer (server/socket.ts)
// calls these methods and pushes views out through the `broadcast` callback.
//
// Identity: every player and the host get a random session token when they create/join. Clients keep it in
// localStorage and present it again after a refresh or reconnect, so the same player is restored instead
// of a duplicate being created.

import { randomBytes } from "node:crypto";
import { GAME } from "../lib/config";
import type { Rng } from "../lib/game/deal";
import {
  addPlayer,
  beginInterrogation,
  createGame,
  deal,
  endInvestigationNow,
  finishGame,
  openAlibis,
  removePlayer,
  revealTruth,
  selectCase,
  setReady,
  submitAlibi,
  submitAnswer,
  updateSettings,
  type EngineDeps,
} from "../lib/game/engine";
import type { LLMClient } from "../lib/llm/types";
import type { HostAction, PlayerAction } from "../lib/protocol";
import type { GameState, Secrets } from "../lib/types";
import type { ViewContext } from "./views";
import { readAloudMs, type VoiceService } from "./voice";

export interface Connection {
  id: string; // socket id
  role: "host" | "player";
  playerId?: string;
}

export interface Room {
  code: string;
  state: GameState;
  secrets: Secrets | null;
  hostToken: string;
  playerTokens: Map<string, string>; // token -> playerId
  connections: Map<string, Connection>;
  timer: { askedAt: number; handle: ReturnType<typeof setTimeout>; extraWaits: number } | null;
  receivingAudioFor: number | null; // askedAt of a question whose voice answer is being transcribed
  pendingAlibis: Set<Promise<void>>;
  ttsCache: Map<string, { audio: Buffer; mimeType: string }>;
}

export interface RoomsOptions {
  llm: LLMClient;
  voice: VoiceService;
  publicUrl: string | null;
  broadcast: (room: Room) => void;
  onKick?: (room: Room, playerId: string) => void;
  rng?: Rng;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I or O
const token = () => randomBytes(18).toString("base64url");

export class Rooms {
  private rooms = new Map<string, Room>();
  constructor(private opts: RoomsOptions) {}

  get(code: string): Room | null {
    return this.rooms.get(code.trim().toUpperCase()) ?? null;
  }

  viewContext(room: Room): ViewContext {
    return {
      state: room.state,
      secrets: room.secrets,
      llmProvider: this.opts.llm.provider,
      voiceEnabled: this.opts.voice.enabled,
      publicUrl: this.opts.publicUrl,
    };
  }

  private deps(room: Room): EngineDeps {
    return {
      llm: this.opts.llm,
      rng: this.opts.rng ?? Math.random,
      onChange: () => this.changed(room),
      questionLeadMs: this.opts.voice.enabled ? readAloudMs : undefined,
    };
  }

  /** Push the new state to every client and keep the answer timer in step. */
  changed(room: Room) {
    this.opts.broadcast(room);
    this.armTimer(room);
  }

  // ---------- Sessions ----------

  create(): { code: string; token: string } {
    let code = "";
    do {
      code = Array.from({ length: GAME.roomCodeLength }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    } while (this.rooms.has(code));
    const room: Room = {
      code,
      state: createGame(code),
      secrets: null,
      hostToken: token(),
      playerTokens: new Map(),
      connections: new Map(),
      timer: null,
      receivingAudioFor: null,
      pendingAlibis: new Set(),
      ttsCache: new Map(),
    };
    this.rooms.set(code, room);
    return { code, token: room.hostToken };
  }

  join(code: string, name: string): { room: Room; playerId: string; token: string } {
    const room = this.get(code);
    if (!room) throw new Error("No game with that code.");
    if (room.state.phase !== "LOBBY") throw new Error("This game has already started.");
    const player = addPlayer(room.state, name);
    const t = token();
    room.playerTokens.set(t, player.id);
    this.changed(room);
    return { room, playerId: player.id, token: t };
  }

  resume(code: string, t: string): { room: Room; role: "host" | "player"; playerId?: string } {
    const room = this.get(code);
    if (!room) throw new Error("That game no longer exists.");
    if (t === room.hostToken) return { room, role: "host" };
    const playerId = room.playerTokens.get(t);
    if (!playerId || !room.state.players.some((p) => p.id === playerId)) throw new Error("Session not found. Join again.");
    return { room, role: "player", playerId };
  }

  attach(room: Room, conn: Connection) {
    room.connections.set(conn.id, conn);
    this.refreshPresence(room);
    this.changed(room);
  }

  detach(room: Room, connId: string) {
    room.connections.delete(connId);
    this.refreshPresence(room);
    this.changed(room);
  }

  private refreshPresence(room: Room) {
    const online = new Set([...room.connections.values()].filter((c) => c.role === "player").map((c) => c.playerId));
    for (const p of room.state.players) p.connected = online.has(p.id);
  }

  // ---------- Actions ----------

  /** Runs a slow step with a busy flag so it can't run twice, and pushes updates as it goes. */
  private async exclusive(room: Room, fn: () => Promise<void>) {
    if (room.state.busy) throw new Error("The detective is still thinking. Try again in a moment.");
    room.state.busy = true;
    this.changed(room);
    try {
      await fn();
    } finally {
      room.state.busy = false;
      this.changed(room);
    }
  }

  async hostAction(room: Room, action: HostAction) {
    const s = room.state;
    const deps = this.deps(room);
    switch (action.type) {
      case "selectCase":
        selectCase(s, action.caseId);
        break;
      case "settings":
        updateSettings(s, action.patch);
        break;
      case "kick": {
        removePlayer(s, action.playerId);
        for (const [t, id] of room.playerTokens) if (id === action.playerId) room.playerTokens.delete(t);
        this.opts.onKick?.(room, action.playerId);
        for (const [id, c] of room.connections) if (c.playerId === action.playerId) room.connections.delete(id);
        break;
      }
      case "start":
        room.secrets = deal(s, this.opts.rng ?? Math.random);
        break;
      case "openAlibis":
        openAlibis(s);
        break;
      case "devFillAlibis":
        for (const p of s.players.filter((x) => !x.alibiLocked)) {
          this.trackAlibi(room, submitAlibi(s, deps, p.id, `I'm ${p.characterName}. I was in the main room most of the evening and saw nothing unusual.`));
        }
        break;
      case "begin":
        await this.exclusive(room, async () => {
          await Promise.all(room.pendingAlibis); // every alibi's claims must be recorded before the first review
          await beginInterrogation(s, deps);
        });
        return;
      case "skipAnswer":
        await this.exclusive(room, () => submitAnswer(s, deps, null, "", { timedOut: true }));
        return;
      case "endNow":
        await this.exclusive(room, () => endInvestigationNow(s, deps));
        return;
      case "reveal":
        if (!room.secrets) throw new Error("Nothing to reveal yet.");
        await this.exclusive(room, () => revealTruth(s, deps, room.secrets!));
        return;
      case "finish":
        finishGame(s);
        break;
      default:
        throw new Error("Unknown action.");
    }
    this.changed(room);
  }

  async playerAction(room: Room, playerId: string, action: PlayerAction) {
    const s = room.state;
    const deps = this.deps(room);
    switch (action.type) {
      case "ready":
        setReady(s, playerId);
        break;
      case "alibi": {
        const p = submitAlibi(s, deps, playerId, action.text);
        this.trackAlibi(room, p);
        this.changed(room); // the alibi is locked immediately; extraction continues in the background
        await p;
        break;
      }
      case "answer":
        this.requireTurn(room, playerId);
        await this.exclusive(room, () => submitAnswer(s, deps, playerId, action.text ?? "", { timedOut: action.timedOut }));
        return;
      default:
        throw new Error("Unknown action.");
    }
    this.changed(room);
  }

  /** A recorded spoken answer: transcribe with ElevenLabs, then treat the text as testimony. */
  async voiceAnswer(room: Room, playerId: string, audio: Buffer, mimeType: string, timedOut: boolean) {
    this.requireTurn(room, playerId);
    const askedAt = room.state.current!.askedAt;
    room.receivingAudioFor = askedAt;
    let text: string;
    try {
      text = audio.length ? await this.opts.voice.transcribe(audio, mimeType) : "";
    } finally {
      room.receivingAudioFor = null;
    }
    if (room.state.current?.askedAt !== askedAt) throw new Error("Too late: the detective has moved on.");
    await this.exclusive(room, () => submitAnswer(room.state, this.deps(room), playerId, text, { timedOut }));
    return text;
  }

  /** Detective speech for the shared screen. Only public text (the current question or the accusation). */
  async tts(room: Room, kind: "question" | "accusation") {
    const s = room.state;
    const key = kind === "question" ? `q:${s.current?.askedAt}` : "accusation";
    const text = kind === "question" ? s.current?.text : s.accusation?.reasoning;
    if (!text) throw new Error("Nothing to say right now.");
    const cached = room.ttsCache.get(key);
    if (cached) return cached;
    const out = await this.opts.voice.speak(text);
    room.ttsCache.set(key, out);
    return out;
  }

  private requireTurn(room: Room, playerId: string) {
    const s = room.state;
    if (s.phase !== "INTERROGATION" || !s.current) throw new Error("No question is waiting for an answer.");
    if (s.current.targetPlayerId !== playerId) throw new Error("This question isn't for you.");
  }

  private trackAlibi(room: Room, p: Promise<void>) {
    const tracked = p.catch(() => {}).finally(() => {
      room.pendingAlibis.delete(tracked);
      this.changed(room);
    });
    room.pendingAlibis.add(tracked);
  }

  // ---------- Server-side answer timer ----------

  /** If the questioned player's time (plus grace) runs out, the server records "no answer" and moves on. */
  private armTimer(room: Room) {
    const q = room.state.phase === "INTERROGATION" ? room.state.current : null;
    if (!q) {
      if (room.timer) clearTimeout(room.timer.handle);
      room.timer = null;
      return;
    }
    if (room.timer?.askedAt === q.askedAt) return;
    if (room.timer) clearTimeout(room.timer.handle);
    const delay = Math.max(0, q.deadline + GAME.answerGraceSeconds * 1000 - Date.now());
    room.timer = { askedAt: q.askedAt, handle: this.schedule(room, q.askedAt, delay), extraWaits: 0 };
  }

  private schedule(room: Room, askedAt: number, delay: number) {
    const handle = setTimeout(() => void this.onTimeout(room, askedAt), delay);
    handle.unref?.();
    return handle;
  }

  private async onTimeout(room: Room, askedAt: number) {
    const s = room.state;
    if (s.phase !== "INTERROGATION" || s.current?.askedAt !== askedAt) return;
    // A voice answer is still being transcribed, or another step is running: wait a little (up to ~20s).
    if ((room.receivingAudioFor === askedAt || s.busy) && room.timer && room.timer.extraWaits < 10) {
      room.timer.extraWaits += 1;
      room.timer.handle = this.schedule(room, askedAt, 2000);
      return;
    }
    try {
      await this.exclusive(room, () => submitAnswer(s, this.deps(room), null, "", { timedOut: true }));
    } catch (err) {
      console.error("[rooms] timeout handling failed:", err);
    }
  }
}
