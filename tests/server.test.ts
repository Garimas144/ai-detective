import { afterEach, describe, expect, it, vi } from "vitest";
import { getCase } from "@/lib/cases";
import { GAME } from "@/lib/config";
import { createMockClient } from "@/lib/llm/mock";
import type { ClientPayload } from "@/lib/protocol";
import { Rooms, type Room } from "@/server/rooms";
import { hostView, playerView, publicView } from "@/server/views";
import { fakeVoice } from "./fakeVoice";

const noVoice = fakeVoice("text");

function setup(players = 4) {
  const rooms = new Rooms({ llm: createMockClient(), voice: noVoice, publicUrl: null, broadcast: () => {} });
  const { code, token: hostToken } = rooms.create();
  const room = rooms.get(code)!;
  const joined = ["Ana", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal"].slice(0, players).map((n) => rooms.join(code, n));
  return { rooms, room, code, hostToken, joined };
}

async function toAlibis(rooms: Rooms, room: Room) {
  await rooms.hostAction(room, { type: "selectCase", caseId: "museum-heist" });
  await rooms.hostAction(room, { type: "start" });
  for (const p of room.state.players) await rooms.playerAction(room, p.id, { type: "ready" });
}

/** Every private string on every character card of the room's case. */
function privateStrings(room: Room) {
  const c = getCase(room.state.caseId!);
  return {
    truth: [c.truth, ...c.evidence.map((e) => e.explanation)],
    byCharacter: new Map(
      c.characters.map((ch) => [
        ch.id,
        [ch.background, ch.relationship, ch.reasonPresent, ch.motive, ch.suspicious, ...(ch.secret ? [ch.secret] : []), ...ch.knows, ...(ch.whatYouDid ?? []), ...(ch.looseEnds ?? [])],
      ]),
    ),
  };
}

afterEach(() => vi.useRealTimers());

describe("rooms and sessions", () => {
  it("creates a short room code and joins players", () => {
    const { room, code, joined } = setup(3);
    expect(code).toMatch(new RegExp(`^[A-Z]{${GAME.roomCodeLength}}$`));
    expect(room.state.phase).toBe("LOBBY");
    expect(joined).toHaveLength(3);
  });

  it("resuming with a saved token restores the same player instead of adding a duplicate", () => {
    const { rooms, code, joined, hostToken } = setup(3);
    const again = rooms.resume(code.toLowerCase(), joined[1].token);
    expect(again.role).toBe("player");
    expect(again.playerId).toBe(joined[1].playerId);
    expect(rooms.get(code)!.state.players).toHaveLength(3);
    expect(rooms.resume(code, hostToken).role).toBe("host");
    expect(() => rooms.resume(code, "not-a-token")).toThrow(/Session not found/);
    expect(() => rooms.join(code, "ana")).toThrow(/taken/);
  });

  it("enforces 3 to 8 players and no joining after the game starts", async () => {
    const { rooms, room, code } = setup(8);
    expect(() => rooms.join(code, "Ivy")).toThrow(/At most 8/);
    await rooms.hostAction(room, { type: "selectCase", caseId: "stolen-prototype" });
    await rooms.hostAction(room, { type: "start" });
    expect(room.state.phase).toBe("ROLE_REVEAL");
    expect(() => rooms.join(code, "Late")).toThrow(/already started/);

    const small = setup(2);
    await small.rooms.hostAction(small.room, { type: "selectCase", caseId: "stolen-prototype" });
    await expect(small.rooms.hostAction(small.room, { type: "start" })).rejects.toThrow(/at least 3/);
  });

  it("tracks presence as devices connect and disconnect", () => {
    const { rooms, room, joined } = setup(3);
    rooms.attach(room, { id: "s1", role: "player", playerId: joined[0].playerId });
    expect(room.state.players[0].connected).toBe(true);
    rooms.detach(room, "s1");
    expect(room.state.players[0].connected).toBe(false);
  });
});

describe("payload separation", () => {
  it("each player sees only their own card; the shared screen sees no cards, alibis or detective state", async () => {
    const { rooms, room, joined } = setup(8);
    await toAlibis(rooms, room);
    for (const p of room.state.players) await rooms.playerAction(room, p.id, { type: "alibi", text: `ALIBI-OF-${p.id} I was in the Egyptian wing at 20:10.` });
    await rooms.hostAction(room, { type: "begin" });
    expect(room.state.phase).toBe("INTERROGATION");

    const ctx = rooms.viewContext(room);
    const { truth, byCharacter } = privateStrings(room);
    const allPrivate = [...truth, ...[...byCharacter.values()].flat()];

    const shared = JSON.stringify(hostView(ctx));
    for (const s of allPrivate) expect(shared, `shared screen leaked: ${s.slice(0, 60)}`).not.toContain(s);
    expect(shared).not.toContain("ALIBI-OF-");
    expect(shared).not.toMatch(/"(contradictions|corroborations|claims|profiles|roundQueue|characterId|culpritPlayerId)"/);
    expect(publicView(ctx).reveal).toBeNull();

    for (const { playerId } of joined) {
      const payload = playerView(ctx, playerId) as Extract<ClientPayload, { role: "player" }>;
      const json = JSON.stringify(payload);
      const mine = room.secrets!.characterOf[playerId];
      expect(payload.me.card?.id).toBe(mine);
      expect(json).toContain(`ALIBI-OF-${playerId}`);
      for (const [charId, strings] of byCharacter) {
        if (charId === mine) continue;
        for (const s of strings) expect(json, `${playerId} saw another card: ${s.slice(0, 60)}`).not.toContain(s);
      }
      for (const other of joined.filter((j) => j.playerId !== playerId)) expect(json).not.toContain(`ALIBI-OF-${other.playerId}`);
      for (const s of truth) expect(json).not.toContain(s);
    }
  });

  it("everything is revealed after the reveal", async () => {
    const { rooms, room } = setup(3);
    await toAlibis(rooms, room);
    await rooms.hostAction(room, { type: "devFillAlibis" });
    await rooms.hostAction(room, { type: "begin" });
    await rooms.hostAction(room, { type: "endNow" });
    expect(room.state.phase).toBe("ACCUSATION");
    expect(publicView(rooms.viewContext(room)).accusation).not.toBeNull();
    await rooms.hostAction(room, { type: "reveal" });
    const view = publicView(rooms.viewContext(room));
    expect(view.reveal?.characters).toHaveLength(3);
    expect(view.reveal?.truth).toBe(getCase("museum-heist").truth);
    await rooms.hostAction(room, { type: "finish" });
    expect(room.state.phase).toBe("FINISHED");
  });
});

describe("turns and timers", () => {
  it("only the questioned player can answer", async () => {
    const { rooms, room } = setup(3);
    await toAlibis(rooms, room);
    await rooms.hostAction(room, { type: "devFillAlibis" });
    await rooms.hostAction(room, { type: "begin" });
    const target = room.state.current!.targetPlayerId;
    const other = room.state.players.find((p) => p.id !== target)!.id;
    await expect(rooms.playerAction(room, other, { type: "answer", text: "It was me, I'm answering for them." })).rejects.toThrow(/isn't for you/);
    await rooms.playerAction(room, target, { type: "answer", text: "I was in the workshop at 20:10." });
    expect(room.state.turns.filter((t) => t.kind === "answer")).toHaveLength(1);
  });

  it("the server records no answer when the time limit (plus grace) passes", async () => {
    vi.useFakeTimers();
    const { rooms, room } = setup(3);
    await toAlibis(rooms, room);
    await rooms.hostAction(room, { type: "devFillAlibis" });
    await rooms.hostAction(room, { type: "begin" });
    const first = room.state.current!;
    await vi.advanceTimersByTimeAsync((room.state.settings.answerSeconds + GAME.answerGraceSeconds) * 1000 + 100);
    const turn = room.state.turns.find((t) => t.kind === "answer")!;
    expect(turn.playerId).toBe(first.targetPlayerId);
    expect(turn.timedOut).toBe(true);
    expect(room.state.current?.askedAt).not.toBe(first.askedAt);
  });
});
