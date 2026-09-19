// Checks the post-game narrator's output against ground truth so the reveal never states a guess as a fact.
//   - A "lie" survives only if the quoted words really appear in that player's own testimony AND it cites
//     at least one real fact from the case files (which is then shown next to it).
//   - "Misleading testimony" survives only if the quoted words really appear in that player's testimony.
// Pure functions, no AI.

import type { RevealOutput, RevealFact } from "../prompts/reveal";
import { normalizeTimes } from "../time";
import type { GameState, RevealAnalysis } from "../types";

// Times are compared in 12-hour form on both sides, so "21:10" typed by a player matches "9:10 PM" in a quote.
const norm = (s: string) =>
  normalizeTimes(s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** True if the quoted words really appear in something this player wrote or said. Tolerates trimmed quotes and minor edits. */
export function quotedInTestimony(state: GameState, playerId: string, statement: string): boolean {
  const q = norm(statement.replace(/^["'“”\s]+|["'“”\s]+$/g, "").replace(/\.\.\./g, " "));
  if (q.split(" ").filter(Boolean).length < 2) return false;
  const mine = state.turns.filter((t) => t.playerId === playerId).map((t) => norm(t.answer));
  if (mine.some((t) => t.includes(q))) return true;
  // Allow small edits: nearly every word of the quote must appear, in order, within one of the player's statements.
  const words = q.split(" ");
  return mine.some((t) => {
    const hay = t.split(" ");
    let at = 0;
    let hit = 0;
    for (const w of words) {
      const i = hay.indexOf(w, at);
      if (i !== -1) {
        hit++;
        at = i + 1;
      }
    }
    return hit / words.length >= 0.9;
  });
}

export function verifyReveal(out: RevealOutput, state: GameState, facts: RevealFact[]): RevealAnalysis {
  const validPlayer = new Set(state.players.map((p) => p.id));
  const factById = new Map(facts.map((f) => [f.id, f]));

  const importantLies = out.importantLies
    .filter((l) => validPlayer.has(l.playerId) && quotedInTestimony(state, l.playerId, l.statement))
    .map((l) => ({ ...l, sources: [...new Set(l.factIds)].map((id) => factById.get(id)?.text).filter((t): t is string => !!t) }))
    .filter((l) => l.sources.length > 0)
    .map(({ playerId, statement, truth, sources }) => ({ playerId, statement, truth, sources }));

  const misleadingTestimony = out.misleadingTestimony.filter((m) => validPlayer.has(m.playerId) && quotedInTestimony(state, m.playerId, m.statement));

  return { summary: out.summary, importantLies, misleadingTestimony };
}
