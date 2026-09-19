import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS } from "@/lib/config";
import { buildProfiles, suspicionCurve, topSuspect, type ScoringInput } from "@/lib/scoring";
import type { Contradiction, Corroboration } from "@/lib/types";

const x = (over: Partial<Contradiction>): Contradiction => ({
  id: "X1", kind: "vs_evidence", claimIds: ["C1"], evidenceId: "E1", playerIds: ["a"], severity: 1, explanation: "", round: 1, ...over,
});
const k = (over: Partial<Corroboration>): Corroboration => ({
  id: "K1", claimIds: ["C1", "C2"], evidenceId: null, playerIds: ["a", "b"], strength: 1, explanation: "", round: 1, ...over,
});
const input = (over: Partial<ScoringInput>): ScoringInput => ({
  playerIds: ["a", "b"], contradictions: [], corroborations: [], turns: [], claims: [], questionsByPlayer: { a: 3, b: 3 }, ...over,
});

describe("suspicion scoring", () => {
  it("maps the documented curve points", () => {
    expect(suspicionCurve(0, 1)).toBe(0);
    expect(suspicionCurve(1, 1)).toBe(63);
    expect(suspicionCurve(2, 1)).toBe(86);
  });

  it("weights an alibi change above a plain self contradiction", () => {
    const [a] = buildProfiles(input({ contradictions: [x({ kind: "vs_alibi", evidenceId: null, claimIds: ["C1", "C2"] })] }), DEFAULT_WEIGHTS);
    const [b] = buildProfiles(input({ contradictions: [x({ kind: "self", evidenceId: null, claimIds: ["C1", "C2"] })] }), DEFAULT_WEIGHTS);
    expect(a.suspicionScore).toBeGreaterThan(b.suspicionScore);
    expect(a.storyChanges).toBe(1);
  });

  it("corroboration lowers suspicion but can only offset half", () => {
    const base = buildProfiles(input({ contradictions: [x({})] }), DEFAULT_WEIGHTS)[0];
    const helped = buildProfiles(input({ contradictions: [x({})], corroborations: [k({}), k({ id: "K2" }), k({ id: "K3" }), k({ id: "K4" })] }), DEFAULT_WEIGHTS)[0];
    expect(helped.suspicionScore).toBeLessThan(base.suspicionScore);
    expect(helped.components.corroboration).toBeCloseTo(0.5);
  });

  it("charges cross-player contradictions to both, or splits them", () => {
    const i = input({ contradictions: [x({ kind: "vs_other_player", evidenceId: null, claimIds: ["C1", "C2"], playerIds: ["a", "b"] })] });
    expect(buildProfiles(i, DEFAULT_WEIGHTS)[1].components.crossPlayer).toBe(0.5);
    expect(buildProfiles(i, { ...DEFAULT_WEIGHTS, crossSplit: "split" })[1].components.crossPlayer).toBe(0.25);
  });

  it("ranks players and picks the top suspect", () => {
    const profiles = buildProfiles(input({ contradictions: [x({ playerIds: ["b"] })] }), DEFAULT_WEIGHTS);
    expect(profiles.find((p) => p.playerId === "b")!.rank).toBe(1);
    expect(topSuspect(profiles)).toBe("b");
  });
});
