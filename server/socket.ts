// Socket.IO wiring. Identity comes from the server-side session bound to the socket, never from the
// payload, so a player can only act as themselves and only the host can run host actions.

import type { Server, Socket } from "socket.io";
import { VOICE } from "../lib/config";
import { EVENTS, type Ack, type HostAction, type PlayerAction } from "../lib/protocol";
import type { Connection, Room, Rooms } from "./rooms";
import { hostView, playerView } from "./views";

type AckFn = (res: Ack<Record<string, unknown>>) => void;

export function broadcastRoom(io: Server, rooms: Rooms, room: Room) {
  const ctx = rooms.viewContext(room);
  for (const conn of room.connections.values()) {
    try {
      const payload = conn.role === "host" ? hostView(ctx) : playerView(ctx, conn.playerId!);
      io.to(conn.id).emit(EVENTS.state, payload);
    } catch (err) {
      console.error("[socket] view failed:", err);
    }
  }
}

export function attachSockets(io: Server, rooms: Rooms) {
  io.on("connection", (socket: Socket) => {
    let bound: { room: Room; conn: Connection } | null = null;

    const bind = (room: Room, role: "host" | "player", playerId?: string) => {
      if (bound) rooms.detach(bound.room, socket.id);
      const conn: Connection = { id: socket.id, role, playerId };
      bound = { room, conn };
      rooms.attach(room, conn);
    };

    /** Wraps a handler: errors go back to the caller as { ok: false, error }. */
    const handle =
      <P>(fn: (payload: P) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void) =>
      async (payload: P, ack?: AckFn) => {
        try {
          const out = await fn(payload);
          ack?.({ ok: true, ...(out ?? {}) });
        } catch (err) {
          ack?.({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      };

    const requireHost = () => {
      if (!bound || bound.conn.role !== "host") throw new Error("Only the host can do that.");
      return bound.room;
    };
    const requirePlayer = () => {
      if (!bound || bound.conn.role !== "player" || !bound.conn.playerId) throw new Error("Join the game first.");
      return { room: bound.room, playerId: bound.conn.playerId };
    };

    socket.on(
      EVENTS.hostCreate,
      handle(() => {
        const { code, token } = rooms.create();
        bind(rooms.get(code)!, "host");
        return { code, token };
      }),
    );

    socket.on(
      EVENTS.playerJoin,
      handle(({ code, name }: { code: string; name: string }) => {
        const { room, playerId, token } = rooms.join(String(code ?? ""), String(name ?? ""));
        bind(room, "player", playerId);
        return { code: room.code, playerId, token };
      }),
    );

    socket.on(
      EVENTS.sessionResume,
      handle(({ code, token }: { code: string; token: string }) => {
        const { room, role, playerId } = rooms.resume(String(code ?? ""), String(token ?? ""));
        bind(room, role, playerId);
        return { code: room.code, role, playerId };
      }),
    );

    socket.on(EVENTS.hostAction, handle((action: HostAction) => rooms.hostAction(requireHost(), action)));

    socket.on(
      EVENTS.playerAction,
      handle((action: PlayerAction) => {
        const { room, playerId } = requirePlayer();
        return rooms.playerAction(room, playerId, action);
      }),
    );

    socket.on(
      EVENTS.voiceAnswer,
      handle(async ({ audio, mimeType, timedOut }: { audio: ArrayBuffer | Buffer; mimeType: string; timedOut?: boolean }) => {
        const { room, playerId } = requirePlayer();
        const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
        if (buf.length > VOICE.maxAudioBytes) throw new Error("Recording too long.");
        const transcript = await rooms.voiceAnswer(room, playerId, buf, String(mimeType || "audio/webm"), !!timedOut);
        return { transcript };
      }),
    );

    socket.on(
      EVENTS.tts,
      handle(async ({ kind }: { kind: "question" | "accusation" }) => {
        const { audio, mimeType } = await rooms.tts(requireHost(), kind === "accusation" ? "accusation" : "question");
        return { audio, mimeType };
      }),
    );

    socket.on("disconnect", () => {
      if (bound) rooms.detach(bound.room, socket.id);
      bound = null;
    });
  });
}
