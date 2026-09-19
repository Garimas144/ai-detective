// Difficulty check: can the detective name the culprit from the public case and evidence ALONE, with no
// alibis and no testimony? If it can, the case is too easy: testimony should be needed to solve it.
//
//   npm run difficulty                 every case, 6 runs each, with the real Nebius reasoning model
//   npm run difficulty -- blackwood-manor 10
//
// Lower is better. A good case is NOT solved from the evidence alone (roughly at chance or below).

import { loadEnvConfig } from "@next/env";
import { CASES } from "../lib/cases";
import { seededRng } from "../lib/game/deal";
import { addPlayer, computeProfiles, createGame, deal, selectCase } from "../lib/game/engine";
import { buildDetectiveView } from "../lib/game/detectiveView";
import { getCase } from "../lib/cases";
import { callJson } from "../lib/llm/json";
import { getLLM } from "../lib/llm/provider";
import { accusationSchema, buildAccusationRequest } from "../lib/prompts/accusation";

loadEnvConfig(process.cwd());

async function one(caseId: string, seed: number, players: number) {
  const rng = seededRng(seed);
  const state = createGame(`D${seed}`);
  selectCase(state, caseId);
  ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, players).forEach((n) => addPlayer(state, n));
  const secrets = deal(state, rng);
  const req = buildAccusationRequest(buildDetectiveView(state, getCase(caseId)), computeProfiles(state));
  const out = await callJson(getLLM(), req, accusationSchema);
  return { correct: out.accusedPlayerId === secrets.culpritPlayerId, confidence: out.confidence };
}

async function main() {
  if (getLLM().provider !== "nebius") throw new Error("Needs NEBIUS_API_KEY (the mock can't judge difficulty).");
  const only = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
  const runs = Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a)) ?? 6);
  const cases = CASES.filter((c) => !only || c.id === only);
  console.log(`Evidence-only difficulty (${runs} runs per case, 5 players, real Nebius reasoning model)\n`);
  let total = 0;
  let solved = 0;
  for (const c of cases) {
    const results = await Promise.all(Array.from({ length: runs }, (_, i) => one(c.id, 100 + i, 5).catch(() => null)));
    const ok = results.filter((r): r is { correct: boolean; confidence: number } => !!r);
    const right = ok.filter((r) => r.correct).length;
    total += ok.length;
    solved += right;
    const conf = ok.length ? (ok.reduce((s, r) => s + r.confidence, 0) / ok.length).toFixed(2) : "n/a";
    console.log(`  ${c.title.padEnd(30)} solved from evidence alone: ${right}/${ok.length}   (avg confidence ${conf})`);
  }
  console.log(`\nOverall: ${solved}/${total} solved with NO testimony (chance with 5 suspects is about 1 in 5).`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
