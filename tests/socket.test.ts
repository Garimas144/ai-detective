import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockClient } from "@/lib/llm/mock";
import { EVENTS, type ClientPayload } from "@/lib/protocol";
import { Rooms } from "@/server/rooms";
import { attachSockets, broadcastRoom } from "@/server/socket";
import { FAKE_ELEVEN_KEY, fakeVoice } from "./fakeVoice";

let http: HttpServer;
let io: Server;
let url = "";
const sockets: Socket[] = [];

beforeAll(async () => {
  http = createServer();
  io = new Server(http);
  const voice = fakeVoice("agent");
  const rooms: Rooms = new Rooms({ llm: createMockClient(), voice, publicUrl: null, broadcast: (room) => broadcastRoom(io, rooms, room) });
  attachSockets(io, rooms);
  await new Promise<void>((r) => http.listen(0, r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  io.close();
});

interface Client {
  socket: Socket;
  latest: () => ClientPayload | null;
  emit: <T = Record<string, unknown>>(event: string, payload?: unknown) => Promise<{ ok: boolean; error?: string } & T>;
}

function client(): Client {
  const socket = connect(url, { transports: ["websocket"], forceNew: true });
  sockets.push(socket);
  let latest: ClientPayload | null = null;
  socket.on(EVENTS.state, (p: ClientPayload) => (latest = p));
  return {
    socket,
    latest: () => latest,
    emit: (event, payload) => new Promise((resolve) => socket.emit(event, payload ?? {}, resolve)),
  };
}

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting for state");
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("Socket.IO layer (real network, real handlers)", () => {
  it("identity comes from the session: only the questioned player gets a token, tokens hold no keys, and reconnecting restores the player", async () => {
    const host = client();
    const created = await host.emit<{ code: string; token: string }>(EVENTS.hostCreate);
    expect(created.ok).toBe(true);
    const code = created.code;

    const players = [client(), client(), client()];
    const joined = [];
    for (const [i, p] of players.entries()) joined.push(await p.emit<{ playerId: string; token: string }>(EVENTS.playerJoin, { code, name: `P${i}` }));

    // Players can't run host actions.
    expect((await players[0].emit(EVENTS.hostAction, { type: "start" })).ok).toBe(false);

    await host.emit(EVENTS.hostAction, { type: "selectCase", caseId: "night-train" });
    expect((await host.emit(EVENTS.hostAction, { type: "start" })).ok).toBe(true);
    await host.emit(EVENTS.hostAction, { type: "openAlibis" });
    await host.emit(EVENTS.hostAction, { type: "devFillAlibis" });
    expect((await host.emit(EVENTS.hostAction, { type: "begin" })).ok).toBe(true);

    const view = await waitFor(() => {
      const p = host.latest();
      return p?.view.phase === "INTERROGATION" && p.view.current ? p.view : null;
    });
    const targetIdx = joined.findIndex((j) => j.playerId === view.current!.targetPlayerId);
    const otherIdx = (targetIdx + 1) % 3;

    // Someone else can't take the token or answer, even though they're connected and in the same room.
    const denied = await players[otherIdx].emit(EVENTS.agentToken);
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/isn't for you/);

    // The questioned player can, and the response carries no credential.
    const granted = await players[targetIdx].emit<{ token: string; conversationId: string; question: string }>(EVENTS.agentToken);
    expect(granted.ok).toBe(true);
    expect(JSON.stringify(granted)).not.toContain(FAKE_ELEVEN_KEY);
    expect(granted.question).toBe(view.current!.text);

    // Every state payload each device received holds no key and no other player's card.
    for (const c of [host, ...players]) expect(JSON.stringify(c.latest())).not.toMatch(/sk_test_ELEVEN|xi-api-key/);
    const mine = players[targetIdx].latest() as Extract<ClientPayload, { role: "player" }>;
    const theirs = players[otherIdx].latest() as Extract<ClientPayload, { role: "player" }>;
    expect(mine.me.card?.id).not.toBe(theirs.me.card?.id);
    expect(JSON.stringify(mine)).not.toContain(theirs.me.card!.motive);

    // Phone drops and comes back with the saved token: same player, same private card, session still valid.
    players[targetIdx].socket.close();
    const back = client();
    const resumed = await back.emit<{ role: string; playerId: string }>(EVENTS.sessionResume, { code, token: joined[targetIdx].token });
    expect(resumed).toMatchObject({ ok: true, role: "player", playerId: joined[targetIdx].playerId });
    const restored = await waitFor(() => (back.latest() as Extract<ClientPayload, { role: "player" }> | null)?.me);
    expect(restored.id).toBe(joined[targetIdx].playerId);
    expect(restored.card?.id).toBe(mine.me.card?.id);
    expect(restored.isMyTurn).toBe(true);

    const answered = await back.emit<{ transcript: string }>(EVENTS.agentAnswer, { conversationId: granted.conversationId, segments: ["Back online, I was in the dining car."], timedOut: false });
    expect(answered.ok).toBe(true);
    expect(answered.transcript).toBe("Back online, I was in the dining car.");
    const after = await waitFor(() => {
      const p = host.latest();
      return p && p.view.transcript.length === 1 ? p.view : null;
    });
    expect(after.transcript[0].answer).toBe("Back online, I was in the dining car.");
    expect(new Set(after.players.map((p) => p.id)).size).toBe(3); // no duplicate players after the reconnect
  });

  it("rejects a bad or foreign session token", async () => {
    const c = client();
    const res = await c.emit(EVENTS.sessionResume, { code: "ZZZZ", token: "nope" });
    expect(res.ok).toBe(false);
  });
});
