import { afterEach, describe, expect, it, vi } from "vitest";
import { GAME, VOICE } from "@/lib/config";
import { createMockClient } from "@/lib/llm/mock";
import type { LLMRequest } from "@/lib/llm/types";
import { Rooms, type Room } from "@/server/rooms";
import { hostView, playerView, publicView } from "@/server/views";
import { createVerifiedVoiceService } from "@/server/voice";
import { FAKE_ELEVEN_KEY, fakeVoice, type FakeVoice } from "./fakeVoice";

function setup(voice: FakeVoice = fakeVoice("agent"), players = 3) {
  const requests: LLMRequest[] = [];
  const inner = createMockClient();
  const llm = { provider: "mock" as const, complete: (r: LLMRequest) => (requests.push(r), inner.complete(r)) };
  const rooms = new Rooms({ llm, voice, publicUrl: null, broadcast: () => {} });
  const { code, token: hostToken } = rooms.create();
  const room = rooms.get(code)!;
  const joined = ["Ana", "Ben", "Cy", "Dee"].slice(0, players).map((n) => rooms.join(code, n));
  return { rooms, room, code, hostToken, joined, voice, requests };
}

async function toInterrogation(rooms: Rooms, room: Room) {
  await rooms.hostAction(room, { type: "selectCase", caseId: "museum-heist" });
  await rooms.hostAction(room, { type: "start" });
  await rooms.hostAction(room, { type: "openAlibis" });
  await rooms.hostAction(room, { type: "devFillAlibis" });
  await rooms.hostAction(room, { type: "begin" });
  expect(room.state.phase).toBe("INTERROGATION");
}

const targetId = (room: Room) => room.state.current!.targetPlayerId;
const otherThan = (room: Room, id: string) => room.state.players.find((p) => p.id !== id)!.id;

afterEach(() => vi.useRealTimers());

describe("agent voice: session tokens", () => {
  it("only the player being questioned can get a token, and only once per question", async () => {
    const { rooms, room, voice } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    await expect(rooms.agentToken(room, otherThan(room, target))).rejects.toThrow(/isn't for you/);
    expect(voice.tokensIssued).toBe(0);
    const t = await rooms.agentToken(room, target);
    expect(t.token).toMatch(/^conv_token_/);
    expect(t.question).toBe(room.state.current!.text);
    await expect(rooms.agentToken(room, target)).rejects.toThrow(/already started/);
    expect(voice.tokensIssued).toBe(1);
  });

  it("the token response never contains the ElevenLabs API key or any private data", async () => {
    const { rooms, room, voice } = setup();
    await toInterrogation(rooms, room);
    const res = await rooms.agentToken(room, targetId(room));
    const json = JSON.stringify(res);
    expect(json).not.toContain(FAKE_ELEVEN_KEY);
    expect(Object.keys(res).sort()).toEqual(["conversationId", "deadline", "question", "token"]);
    // The question sent to ElevenLabs is the same public text everyone can already see.
    expect(res.question).toBe(publicView(rooms.viewContext(room)).current!.text);
    expect(voice.notes.join(" ")).not.toContain(FAKE_ELEVEN_KEY);
  });

  it("agent tokens are refused unless the server is really in agent mode", async () => {
    for (const mode of ["stt-tts", "text"] as const) {
      const { rooms, room } = setup(fakeVoice(mode));
      await toInterrogation(rooms, room);
      await expect(rooms.agentToken(room, targetId(room))).rejects.toThrow(/not available/);
    }
  });

  it("the answer clock leaves time for the question to be read and the session to connect", async () => {
    const { rooms, room } = setup(fakeVoice("agent"));
    await toInterrogation(rooms, room);
    const q = room.state.current!;
    expect(q.deadline - q.askedAt).toBeGreaterThan(room.state.settings.answerSeconds * 1000 + VOICE.agentConnectMs);
    const typed = setup(fakeVoice("text"));
    await toInterrogation(typed.rooms, typed.room);
    const tq = typed.room.state.current!;
    expect(tq.deadline - tq.askedAt).toBe(typed.room.state.settings.answerSeconds * 1000);
  });
});

describe("agent voice: spoken words become testimony", () => {
  it("stores the final transcript exactly as spoken and passes it to the detective as testimony", async () => {
    const { rooms, room, requests, voice } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    voice.official.set(conversationId!, null); // ElevenLabs' record isn't ready: fall back to what the phone reported
    const text = await rooms.agentAnswer(room, target, { conversationId, segments: ["Um, I was, like, near the", "east wing at 20:10."], timedOut: false });

    expect(text).toBe("Um, I was, like, near the east wing at 20:10.");
    const turn = room.state.turns.filter((t) => t.kind === "answer").at(-1)!;
    expect(turn.answer).toBe(text); // fillers and hesitations preserved
    expect(turn.voice).toMatchObject({ mode: "agent", transcriptSource: "client-reported", conversationId, segments: ["Um, I was, like, near the", "east wing at 20:10."] });
    expect(turn.voice!.answerMs).toBeGreaterThanOrEqual(0);
    expect(room.state.claims.some((c) => c.statement.includes("east wing at 20:10") && /says/.test(c.statement))).toBe(true);
    // Nebius (the extractor call) received the words, framed as testimony.
    const extractor = requests.filter((r) => r.purpose === "extractor").at(-1)!;
    expect(extractor.user).toContain("Um, I was, like, near the east wing at 20:10.");
    expect(extractor.system).toMatch(/TESTIMONY/);
  });

  it("prefers ElevenLabs' own record of the user's speech over what the phone reported", async () => {
    const { rooms, room, voice } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    voice.official.set(conversationId!, ["I was in the workshop."]);
    const text = await rooms.agentAnswer(room, target, { conversationId, segments: ["I was nowhere near the workshop, honest."], timedOut: false });
    expect(text).toBe("I was in the workshop.");
    expect(room.state.turns.at(-1)!.voice!.transcriptSource).toBe("elevenlabs-api");
  });

  it("an agent's own words never become testimony: only user speech segments are stored", async () => {
    const { rooms, room, voice } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    voice.official.set(conversationId!, ["I was in the library."]);
    await rooms.agentAnswer(room, target, { conversationId, segments: [], timedOut: false });
    expect(room.state.turns.at(-1)!.answer).toBe("I was in the library.");
  });
});

describe("one question means one question", () => {
  it("each answer consumes exactly one question and a session can't be reused", async () => {
    const { rooms, room, voice } = setup();
    await toInterrogation(rooms, room);
    const before = room.state.questionsAsked;
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    await rooms.agentAnswer(room, target, { conversationId, segments: ["I was at the bar."], timedOut: false });
    expect(room.state.turns.filter((t) => t.kind === "answer")).toHaveLength(1);
    expect(room.state.questionsAsked).toBe(before + 1);
    // Replaying the same session for the next question fails: it's single use and tied to one question.
    await expect(rooms.agentAnswer(room, target, { conversationId, segments: ["Sneaking in a second answer."], timedOut: false })).rejects.toThrow();
    expect(voice.tokensIssued).toBe(1);
    expect(room.state.turns.filter((t) => t.kind === "answer")).toHaveLength(1);
  });

  it("nobody can answer without a session we issued, or for someone else", async () => {
    const { rooms, room } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const other = otherThan(room, target);
    await expect(rooms.agentAnswer(room, target, { segments: ["No session was started."], timedOut: false })).rejects.toThrow(/No voice session/);
    await rooms.agentToken(room, target);
    await expect(rooms.agentAnswer(room, other, { segments: ["I'm answering for them."], timedOut: false })).rejects.toThrow(/isn't for you/);
    await expect(rooms.agentAnswer(room, target, { conversationId: "conv_someone_elses", segments: ["Wrong session."], timedOut: false })).rejects.toThrow(/isn't for this question/);
  });

  it("a typed answer after an agent answer can't consume a second question", async () => {
    const { rooms, room } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    await rooms.agentAnswer(room, target, { conversationId, segments: ["Spoken answer."], timedOut: false });
    const next = room.state.current!;
    if (next.targetPlayerId === target) {
      // Same player asked again: a leftover typed answer for the OLD question can't be submitted twice.
      await rooms.playerAction(room, target, { type: "answer", text: "Typed answer to the new question." });
      expect(room.state.turns.filter((t) => t.kind === "answer")).toHaveLength(2);
    } else {
      await expect(rooms.playerAction(room, target, { type: "answer", text: "Typed answer, not my turn." })).rejects.toThrow(/isn't for you/);
    }
    // Exactly one question is pending at any moment: answers so far + the one currently being asked.
    expect(room.state.questionsAsked).toBe(room.state.turns.filter((t) => t.kind === "answer").length + 1);
  });

  it("a rejected submission (detective busy) doesn't burn the player's session", async () => {
    const { rooms, room } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const { conversationId } = await rooms.agentToken(room, target);
    room.state.busy = true;
    await expect(rooms.agentAnswer(room, target, { conversationId, segments: ["First try."], timedOut: false })).rejects.toThrow(/still thinking/);
    room.state.busy = false;
    await rooms.agentAnswer(room, target, { conversationId, segments: ["Second try."], timedOut: false });
    expect(room.state.turns.filter((t) => t.kind === "answer")).toHaveLength(1);
    expect(room.state.turns.at(-1)!.answer).toBe("Second try.");
  });

  it("the question timer still moves the game on when a voice session goes silent", async () => {
    vi.useFakeTimers();
    const { rooms, room } = setup();
    await toInterrogation(rooms, room);
    const first = room.state.current!;
    await rooms.agentToken(room, first.targetPlayerId); // a session started, but the phone never reports back
    await vi.advanceTimersByTimeAsync(first.deadline - Date.now() + GAME.answerGraceSeconds * 1000 + 200);
    const turn = room.state.turns.find((t) => t.kind === "answer")!;
    expect(turn.playerId).toBe(first.targetPlayerId);
    expect(turn.timedOut).toBe(true);
    expect(room.state.current?.askedAt).not.toBe(first.askedAt);
  });

  it("a reconnecting phone can still finish its agent turn (the session belongs to the player, not the socket)", async () => {
    const { rooms, room, joined } = setup();
    await toInterrogation(rooms, room);
    const target = targetId(room);
    const me = joined.find((j) => j.playerId === target)!;
    rooms.attach(room, { id: "sock1", role: "player", playerId: target });
    const { conversationId } = await rooms.agentToken(room, target);
    rooms.detach(room, "sock1"); // phone loses connection mid-answer
    expect(room.state.players.find((p) => p.id === target)!.connected).toBe(false);
    const again = rooms.resume(room.code, me.token); // page refresh: same token
    expect(again.playerId).toBe(target);
    expect(room.state.players).toHaveLength(3); // no duplicate
    await rooms.agentAnswer(room, target, { conversationId, segments: ["Sorry, my signal dropped."], timedOut: false });
    expect(room.state.turns.at(-1)!.answer).toBe("Sorry, my signal dropped.");
  });
});

describe("host speech", () => {
  it("in agent mode the phone speaks questions, so the host may only speak the accusation", async () => {
    const { rooms, room, voice } = setup(fakeVoice("agent"));
    await toInterrogation(rooms, room);
    await expect(rooms.tts(room, "question")).rejects.toThrow(/on the player's phone/);
    await rooms.hostAction(room, { type: "endNow" });
    await rooms.tts(room, "accusation");
    expect(voice.spoken).toHaveLength(1);
  });

  it("in stt-tts fallback the host speaks the question", async () => {
    const { rooms, room, voice } = setup(fakeVoice("stt-tts"));
    await toInterrogation(rooms, room);
    await rooms.tts(room, "question");
    expect(voice.spoken[0]).toBe(room.state.current!.text);
  });
});

describe("no secret keys in any client payload", () => {
  it("scans every payload for a whole game", async () => {
    const saved = { e: process.env.ELEVENLABS_API_KEY, n: process.env.NEBIUS_API_KEY };
    process.env.ELEVENLABS_API_KEY = FAKE_ELEVEN_KEY;
    process.env.NEBIUS_API_KEY = "nebius_test_SECRET_9876543210";
    try {
      const { rooms, room, joined } = setup();
      const payloads: string[] = [];
      const snap = () => {
        const ctx = rooms.viewContext(room);
        payloads.push(JSON.stringify(hostView(ctx)));
        for (const j of joined) payloads.push(JSON.stringify(playerView(ctx, j.playerId)));
      };
      snap();
      await toInterrogation(rooms, room);
      snap();
      const target = targetId(room);
      const t = await rooms.agentToken(room, target);
      payloads.push(JSON.stringify(t));
      await rooms.agentAnswer(room, target, { conversationId: t.conversationId, segments: ["I was nearby."], timedOut: false });
      snap();
      await rooms.hostAction(room, { type: "endNow" });
      await rooms.hostAction(room, { type: "reveal" });
      snap();
      for (const p of payloads) {
        expect(p).not.toContain(FAKE_ELEVEN_KEY);
        expect(p).not.toContain("nebius_test_SECRET");
        expect(p).not.toMatch(/xi-api-key|apiKey|API_KEY/i);
      }
      expect(payloads.length).toBeGreaterThan(8);
    } finally {
      process.env.ELEVENLABS_API_KEY = saved.e;
      process.env.NEBIUS_API_KEY = saved.n;
    }
  });
});

describe("voice mode detection", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchWith = (routes: Record<string, () => Response>) =>
    (async (url: string | URL | Request) => {
      const u = String(url);
      const hit = Object.keys(routes).find((k) => u.includes(k));
      return hit ? routes[hit]() : json({ detail: "not found" }, 404);
    }) as typeof fetch;

  it("text when there is no key, or ElevenLabs rejects it", async () => {
    expect((await createVerifiedVoiceService({ apiKey: "" })).mode).toBe("text");
    const rejected = fetchWith({ "/user": () => json({ detail: { message: "API key ID used as API key" } }, 400) });
    const v = await createVerifiedVoiceService({ apiKey: FAKE_ELEVEN_KEY, fetchFn: rejected });
    expect(v.mode).toBe("text");
    expect(v.notes.join(" ")).toMatch(/rejected/);
    expect(v.notes.join(" ")).not.toContain(FAKE_ELEVEN_KEY);
  });

  it("stt-tts when the key works but no agent is configured or the agent isn't reachable", async () => {
    const ok = fetchWith({ "/user": () => json({}), "/convai/agents/": () => json({ detail: "not found" }, 404) });
    expect((await createVerifiedVoiceService({ apiKey: FAKE_ELEVEN_KEY, agentId: "", fetchFn: ok })).mode).toBe("stt-tts");
    const missing = await createVerifiedVoiceService({ apiKey: FAKE_ELEVEN_KEY, agentId: "agent_gone", fetchFn: ok });
    expect(missing.mode).toBe("stt-tts");
    expect(missing.notes.join(" ")).toMatch(/isn't usable/);
  });

  it("agent when the key works and the agent exists; it issues tokens by calling ElevenLabs server-side", async () => {
    const calls: { url: string; key: string | null }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, key: (init?.headers as Record<string, string> | undefined)?.["xi-api-key"] ?? null });
      if (u.includes("/convai/conversation/token")) return json({ token: "tok_abc", conversation_id: "conv_1" });
      return json({});
    }) as typeof fetch;
    const v = await createVerifiedVoiceService({ apiKey: FAKE_ELEVEN_KEY, agentId: "agent_abc", fetchFn: f });
    expect(v.mode).toBe("agent");
    expect(await v.getConversationToken()).toEqual({ token: "tok_abc", conversationId: "conv_1" });
    const tokenCall = calls.find((c) => c.url.includes("/conversation/token"))!;
    expect(tokenCall.url).toContain("agent_id=agent_abc");
    expect(tokenCall.key).toBe(FAKE_ELEVEN_KEY); // the key is used only in this server-to-ElevenLabs request
  });
});
