import { describe, expect, it } from "vitest";
import { getCase } from "@/lib/cases";
import { verifyReveal, quotedInTestimony } from "@/lib/game/revealCheck";
import { buildRevealFacts, buildRevealRequest } from "@/lib/prompts/reveal";
import { playGame } from "./helpers";

async function setup() {
  const g = await playGame({ caseId: "night-train", players: 5, alibi: (_s, id) => `ALIBI-${id} I was sleeping, fast asleep, in car eight the whole night.`, answer: () => "Yes, I was in car eight, I think sleeping, the whole night." });
  const c = getCase("night-train");
  const facts = buildRevealFacts(g.state, c, g.secrets);
  return { ...g, c, facts };
}

describe("reveal never states a guess as a fact", () => {
  it("keeps a lie only when it quotes real testimony and cites a real case-file fact, and shows that fact", async () => {
    const { state, facts } = await setup();
    const p = state.players[0].id;
    const secretFact = facts.find((f) => f.text.startsWith("Secret:"))!;
    const out = verifyReveal(
      {
        summary: "s",
        importantLies: [
          { playerId: p, statement: "I was in car eight, I think sleeping", truth: "The case file says otherwise.", factIds: [secretFact.id] }, // grounded
          { playerId: p, statement: "I was in car eight, I think sleeping", truth: "She secretly visited Viktor.", factIds: ["F999"] }, // cites a fact that does not exist
          { playerId: p, statement: "I never went near the dining car", truth: "Made up.", factIds: [secretFact.id] }, // quote never said
          { playerId: p, statement: "I was in car eight, I think sleeping", truth: "No citation.", factIds: [] }, // no basis
        ],
        misleadingTestimony: [
          { playerId: p, statement: "Yes, I was in car eight, I think sleeping", effect: "Real quote." },
          { playerId: p, statement: "At 23:45 Viktor told you he was expecting a visitor", effect: "Copied from a private card, never said." },
        ],
      },
      state,
      facts,
    );
    expect(out.importantLies).toHaveLength(1);
    expect(out.importantLies[0].truth).toBe("The case file says otherwise.");
    expect(out.importantLies[0].sources).toEqual([secretFact.text]); // the real case-file wording is shown, not the model's paraphrase
    expect(out.misleadingTestimony).toHaveLength(1);
    expect(out.misleadingTestimony[0].effect).toBe("Real quote.");
  });

  it("matches quotes despite trimmed punctuation and small edits, but not fabrications", async () => {
    const { state } = await setup();
    const p = state.players[0].id;
    expect(quotedInTestimony(state, p, "\u201cI was in car eight, I think sleeping\u201d")).toBe(true);
    expect(quotedInTestimony(state, p, "i was in car eight i think sleeping the whole night")).toBe(true);
    expect(quotedInTestimony(state, p, "I was in the bar car playing cards")).toBe(false);
    expect(quotedInTestimony(state, p, "Yes")).toBe(false);
  });

  it("the narrator is told it may only use numbered case-file facts and must not quote private cards", async () => {
    const { state, secrets, c, facts } = await setup();
    const req = buildRevealRequest(state, c, secrets, { accusedPlayerId: state.players[0].id, confidence: 0.5, reasoning: "r", keyPoints: ["k"], source: "model" });
    expect(req.system).toMatch(/the only things you may treat as true|and nothing else, as the truth/);
    expect(req.system).toMatch(/Do NOT invent events, motives, movements or reasons/);
    expect(req.system).toMatch(/a player's private card is not testimony/);
    expect(req.user).toContain("FACTS (the only things you may treat as true)");
    expect(facts.length).toBeGreaterThan(10);
    for (const f of facts.slice(0, 5)) expect(req.user).toContain(`[${f.id}]`);
  });
});
