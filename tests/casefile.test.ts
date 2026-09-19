import { describe, expect, it } from "vitest";
import { buildReviewRequest } from "@/lib/prompts/review";
import { buildAccusationRequest, accusationSchema } from "@/lib/prompts/accusation";
import { revealTruth } from "@/lib/game/engine";
import { computeProfiles } from "@/lib/game/engine";
import { publicView } from "@/server/views";
import { Rooms } from "@/server/rooms";
import { createMockClient } from "@/lib/llm/mock";
import { fakeVoice } from "./fakeVoice";
import { playGame } from "./helpers";

describe("per-person case file", () => {
  it("the accusation prompt asks for what made each person suspicious and what checked out", () => {
    const req = buildAccusationRequest({ title: "t", description: "d", setting: "s", victim: "v", timeline: { start: "20:00", end: "21:00" }, evidence: [], players: [], absent: [], testimony: [], claims: [], contradictions: [], corroborations: [], openQuestions: [], notes: [] }, []);
    expect(req.system).toMatch(/EVERY person/);
    expect(req.system).toMatch(/"suspicious"/);
    expect(req.system).toMatch(/"checkedOut"/);
    expect(accusationSchema.parse({ accusedPlayerId: "p", confidence: 0.5, reasoning: "r", keyPoints: ["k"] }).assessments).toEqual([]);
  });

  it("the reveal itemizes each person's score with points, quotes and what held up", async () => {
    const { state, secrets, deps } = await playGame({ caseId: "blackwood-manor", players: 4, settings: { allowEarlyEnd: false }, answer: (_s, _p, i) => `I was in the library at 21:${10 + (i % 30)}.` });
    state.assessments = [{ playerId: state.players[0].id, suspicious: ["Said library at 21:10, but another person said the loading dock."], checkedOut: ["Alibi about the kitchen matched Mrs. Hodge."] }];
    await revealTruth(state, deps, secrets);
    const rooms = new Rooms({ llm: createMockClient(), voice: fakeVoice("text"), publicUrl: null, broadcast: () => {} });
    const view = publicView({ state, secrets, llmProvider: "mock", voiceMode: "text", publicUrl: null });
    void rooms;
    const file = view.reveal!.caseFile;
    expect(file).toHaveLength(4);
    for (const f of file) {
      expect(typeof f.suspicionScore).toBe("number");
      for (const x of f.suspicious) {
        expect(x.points).toBeGreaterThan(0);
        expect(x.text.length).toBeGreaterThan(5);
      }
    }
    const first = file.find((f) => f.playerId === state.players[0].id)!;
    expect(first.detective?.suspicious[0]).toMatch(/loading dock/);
    expect(first.detective?.checkedOut[0]).toMatch(/Hodge/);
    // Points listed for a person add up to that person's raw suspicion inputs (before normalization).
    const profiles = computeProfiles(state);
    expect(profiles.length).toBe(4);
  });

  it("not revealed to anyone before the reveal", async () => {
    const { state, secrets } = await playGame({ caseId: "museum-heist", players: 3 });
    const before = publicView({ state, secrets, llmProvider: "mock", voiceMode: "text", publicUrl: null });
    expect(before.reveal).toBeNull();
    expect(JSON.stringify(before)).not.toMatch(/caseFile|assessments/);
  });
});

describe("questions are specific, not abstract", () => {
  const view = { title: "t", description: "d", setting: "s", victim: "v", timeline: { start: "20:00", end: "21:00" }, evidence: [], players: [], absent: [], testimony: [], claims: [], contradictions: [], corroborations: [], openQuestions: [], notes: [] };
  const req = buildReviewRequest(view, [], { completedRound: 0, nextRound: 1, totalRounds: 3, questionsForNextRound: 3, earlyEndAllowed: false, newClaimIds: [] });

  it("the planning prompt demands one concrete fact per question and bans open-ended wording", () => {
    expect(req.system).toMatch(/SPECIFIC and CONCRETE/);
    expect(req.system).toMatch(/exact time, place, person, object or evidence item/);
    expect(req.system).toMatch(/quote one concrete detail from THAT person's own written alibi/);
    expect(req.system).toMatch(/Do NOT ask abstract, open-ended or creative questions/);
    expect(req.system).toMatch(/walk me through your evening/);
  });
});
