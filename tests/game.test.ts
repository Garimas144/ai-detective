import { describe, expect, it } from "vitest";
import { CASES, getCase } from "@/lib/cases";
import { dealCharacters, seededRng } from "@/lib/game/deal";
import { addPlayer, beginInterrogation, computeResults, createGame, deal, selectCase, setReady, submitAlibi } from "@/lib/game/engine";
import { createMockClient } from "@/lib/llm/mock";
import { playGame } from "./helpers";

describe("cases", () => {
  for (const c of CASES) {
    it(`${c.id} follows the content rules`, () => {
      expect(c.evidence).toHaveLength(5);
      const kinds = c.evidence.map((e) => e.kind).sort();
      expect(kinds).toEqual(["ambiguous", "key", "key", "odd", "red_herring"]);
      expect(c.evidence.every((e) => e.explanation.length > 10)).toBe(true);
      expect(c.characters).toHaveLength(8);
      expect(c.characters.filter((x) => x.culprit)).toHaveLength(1);
      const culprit = c.characters.find((x) => x.culprit)!;
      expect(culprit.whatYouDid?.length).toBeGreaterThan(0);
      const innocents = c.characters.filter((x) => !x.culprit);
      expect(innocents.filter((x) => x.secret)).toHaveLength(3);
      // At least two innocents know something involving another character.
      const nameParts = (name: string) => name.replace(/^(Dr|Mr|Mrs|Ms|Lady|Lord|Colonel)\.?\s+/, "").split(" ").filter((w) => w.length > 2);
      const linked = innocents.filter((x) =>
        x.knows.some((k) => c.characters.some((o) => o.id !== x.id && nameParts(o.name).some((n) => k.includes(n)))),
      );
      expect(linked.length).toBeGreaterThanOrEqual(2);
      expect(c.description.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
    });
  }
});

describe("dealing", () => {
  it("always puts the culprit in play and gives about 40% of innocents a secret", () => {
    for (const c of CASES) {
      for (let n = 3; n <= 8; n++) {
        for (let seed = 1; seed <= 20; seed++) {
          const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}` }) as never);
          const { secrets } = dealCharacters("g", c, players, seededRng(seed));
          const dealt = Object.values(secrets.characterOf).map((id) => c.characters.find((x) => x.id === id)!);
          expect(dealt.filter((x) => x.culprit)).toHaveLength(1);
          const withSecret = dealt.filter((x) => !x.culprit && x.secret).length;
          expect(withSecret).toBe(Math.max(1, Math.round((n - 1) * 0.4)));
          if (n - 1 >= 3) {
            expect(withSecret / (n - 1)).toBeGreaterThanOrEqual(0.3);
            expect(withSecret / (n - 1)).toBeLessThanOrEqual(0.5);
          }
          expect(new Set(dealt.map((x) => x.id)).size).toBe(n);
        }
      }
    }
  });
});

describe("game flow", () => {
  it("requires every alibi before questioning, and alibis are immutable", async () => {
    const rng = seededRng(3);
    const deps = { llm: createMockClient(), rng };
    const state = createGame("g");
    selectCase(state, "night-train");
    ["A", "B", "C"].forEach((n) => addPlayer(state, n));
    deal(state, rng);
    expect(state.phase).toBe("ROLE_REVEAL");
    await expect(submitAlibi(state, deps, state.players[0].id, "Too early to write this alibi.")).rejects.toThrow(/phase/);
    state.players.forEach((p) => setReady(state, p.id));
    expect(state.phase).toBe("ALIBI_ENTRY");
    await submitAlibi(state, deps, state.players[0].id, "I was in the dining car from 00:00 to 01:00.");
    await expect(submitAlibi(state, deps, state.players[0].id, "Actually I was somewhere else.")).rejects.toThrow(/locked/);
    await expect(beginInterrogation(state, deps)).rejects.toThrow(/Waiting for alibis/);
  });

  it("round 1 asks everyone exactly once, then runs 3 rounds and accuses exactly one player", async () => {
    const { state } = await playGame({ caseId: "stolen-prototype", players: 5, settings: { allowEarlyEnd: false } });
    const round1 = state.turns.filter((t) => t.kind === "answer" && t.round === 1).map((t) => t.playerId);
    expect(new Set(round1).size).toBe(5);
    expect(round1).toHaveLength(5);
    expect(state.round).toBe(3);
    expect(state.questionsAsked).toBeLessThanOrEqual(15);
    expect(state.phase).toBe("ACCUSATION");
    expect(state.endReason).toBe("rounds");
    expect(state.players.map((p) => p.id)).toContain(state.accusation!.accusedPlayerId);
    expect(state.profiles).toHaveLength(5);
  });

  it("supports 8 players", async () => {
    const { state } = await playGame({ caseId: "night-train", players: 8, settings: { allowEarlyEnd: false } });
    expect(state.players).toHaveLength(8);
    expect(new Set(state.turns.filter((t) => t.round === 1).map((t) => t.playerId)).size).toBe(8);
    expect(state.phase).toBe("ACCUSATION");
  });

  it("stops at the question limit", async () => {
    const { state } = await playGame({ caseId: "museum-heist", players: 4, settings: { maxQuestions: 6 } });
    expect(state.questionsAsked).toBe(6);
    expect(state.endReason).toBe("budget");
    expect(state.accusation).not.toBeNull();
  });

  it("culprit wins unless accused; an accused innocent loses", async () => {
    const { state, secrets } = await playGame({ caseId: "lakeside-cabin", players: 4 });
    const culprit = secrets.culpritPlayerId;
    const innocent = state.players.find((p) => p.id !== culprit)!.id;

    state.accusation = { ...state.accusation!, accusedPlayerId: culprit };
    let results = computeResults(state, secrets);
    expect(results.find((r) => r.playerId === culprit)!.outcome).toBe("lose");
    expect(results.filter((r) => r.outcome === "win")).toHaveLength(3);

    state.accusation = { ...state.accusation!, accusedPlayerId: innocent };
    results = computeResults(state, secrets);
    expect(results.find((r) => r.playerId === culprit)!.outcome).toBe("win");
    expect(results.find((r) => r.playerId === innocent)!.outcome).toBe("lose");
    expect(results.filter((r) => r.outcome === "lose")).toHaveLength(1);
  });

  it("claims are always stored as testimony, never as fact", async () => {
    const { state } = await playGame({ caseId: "blackwood-manor", players: 3, answer: () => "I flew to heaven at 22:00." });
    const heaven = state.claims.filter((c) => /heaven/i.test(c.statement));
    expect(heaven.length).toBeGreaterThan(0);
    for (const c of heaven) expect(c.statement).toMatch(/says/);
    expect(getCase("blackwood-manor").evidence.map((e) => e.text).join(" ")).not.toMatch(/heaven/);
  });
});

describe("testimony framing", () => {
  it("adds attribution when a model states testimony as fact", async () => {
    const { asTestimony } = await import("@/lib/game/engine");
    expect(asTestimony("Was in the library at 22:00.", "Mrs. Hodge")).toBe("Mrs. Hodge says: Was in the library at 22:00.");
    expect(asTestimony("Jasper claims he never left.", "Jasper")).toBe("Jasper claims he never left.");
  });
});

describe("12-hour clock everywhere", () => {
  it("no case text uses 24-hour times, and every time reads like 9:14 PM or 12:30 AM", async () => {
    const { CASES } = await import("@/lib/cases");
    for (const c of CASES) {
      const blob = JSON.stringify(c);
      expect(blob, c.id).not.toMatch(/\b(?:[01]\d|2[0-3]):[0-5]\d\b(?!\s?[AP]M)/);
      expect(blob, c.id).toMatch(/\b\d{1,2}:\d{2} (?:AM|PM)\b/);
      expect(c.timeline.start).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    }
  });

  it("converts 24-hour times written by a model, leaves 12-hour times alone, and parses both", async () => {
    const { normalizeTimes, to12h, toMinutes } = await import("@/lib/time");
    expect(to12h(21, 14)).toBe("9:14 PM");
    expect(to12h(0, 30)).toBe("12:30 AM");
    expect(to12h(12, 5)).toBe("12:05 PM");
    expect(normalizeTimes("Finch left at 21:50 and returned at 00:35, not 9:05 PM or 10:00.")).toBe("Finch left at 9:50 PM and returned at 12:35 AM, not 9:05 PM or 10:00.");
    expect(normalizeTimes("at 01:05 and 13:00")).toBe("at 1:05 AM and 1:00 PM");
    expect(toMinutes("9:14 PM")).toBe(21 * 60 + 14);
    expect(toMinutes("21:14")).toBe(21 * 60 + 14);
    expect(toMinutes("12:30 AM")).toBe(30);
  });

  it("model output is normalized before it is stored, but the player's own words are kept exactly", async () => {
    const { state } = await playGame({ caseId: "blackwood-manor", players: 3, answer: () => "I left the study at 22:05 exactly." });
    const answer = state.turns.filter((t) => t.kind === "answer")[0];
    expect(answer.answer).toBe("I left the study at 22:05 exactly."); // testimony untouched
    expect(state.claims.some((c) => /10:05 PM/.test(c.statement))).toBe(true); // shown to people in 12-hour form
    expect(state.claims.some((c) => /22:05/.test(c.statement))).toBe(false);
  });
});
