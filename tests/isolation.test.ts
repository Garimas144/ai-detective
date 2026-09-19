import { describe, expect, it } from "vitest";
import { CASES } from "@/lib/cases";
import { revealTruth } from "@/lib/game/engine";
import { DETECTIVE_PURPOSES } from "@/lib/llm/types";
import { playGame, recordingClient } from "./helpers";

describe("detective isolation", () => {
  for (const c of CASES) {
    it(`no secret or private data reaches detective prompts (${c.id})`, async () => {
      const { llm, requests } = recordingClient();
      const { state, secrets, deps } = await playGame({ caseId: c.id, players: 8, llm });
      await revealTruth(state, deps, secrets);

      const detective = requests.filter((r) => DETECTIVE_PURPOSES.includes(r.purpose));
      expect(detective.length).toBeGreaterThan(20);

      const privateStrings = [
        c.truth,
        ...c.evidence.map((e) => e.explanation),
        ...c.characters.flatMap((ch) => [
          ch.background, ch.relationship, ch.reasonPresent, ch.motive, ch.suspicious,
          ...(ch.secret ? [ch.secret] : []), ...ch.knows, ...(ch.whatYouDid ?? []), ...(ch.looseEnds ?? []),
        ]),
        ...c.chain.map((l) => l.description),
      ];
      for (const req of detective) {
        const blob = JSON.stringify(req);
        expect(blob).not.toMatch(/culprit"?\s*:\s*true/i);
        expect(blob).not.toContain("culpritPlayerId");
        expect(blob).not.toContain("characterOf");
        expect(blob).not.toMatch(/"kind":"(key|ambiguous|red_herring|odd)"/);
        for (const s of privateStrings) expect(blob, `leaked into ${req.purpose}: ${s.slice(0, 70)}`).not.toContain(s);
      }

      // The post-game narrator is allowed the truth, and only runs after the accusation.
      const revealIdx = requests.findIndex((r) => r.purpose === "reveal");
      const accuseIdx = requests.findIndex((r) => r.purpose === "accusation");
      expect(accuseIdx).toBeGreaterThan(-1);
      expect(revealIdx).toBeGreaterThan(accuseIdx);
    });
  }

  it("detective sees alibis as testimony", async () => {
    const { llm, requests } = recordingClient();
    await playGame({ caseId: "blackwood-manor", players: 3, llm, alibi: (_s, id) => `ALIBI-MARK-${id} I was in the library at 21:40.` });
    const review = requests.find((r) => r.purpose === "review")!;
    expect(review.user).toContain("ALIBI-MARK-");
    expect(review.user).toContain("WRITTEN ALIBI");
  });
});
