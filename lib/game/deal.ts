import { GAME } from "../config";
import type { Case, Player, Secrets } from "../types";

export type Rng = () => number;

/** Deterministic seeded RNG (mulberry32) so sim games can be replayed. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Picks which characters are in play and who plays them.
 * - The culprit character is always in play.
 * - About 40% of the innocents in play (at least one) have a real secret, per the design target of 30-50%.
 */
export function dealCharacters(gameId: string, c: Case, players: Player[], rng: Rng) {
  if (players.length < GAME.minPlayers || players.length > GAME.maxPlayers)
    throw new Error(`Need ${GAME.minPlayers} to ${GAME.maxPlayers} players.`);
  const culprit = c.characters.find((x) => x.culprit)!;
  const innocents = c.characters.filter((x) => !x.culprit);
  const withSecret = shuffle(innocents.filter((x) => x.secret), rng);
  const without = shuffle(innocents.filter((x) => !x.secret), rng);

  const n = players.length - 1;
  const secretTarget = Math.min(withSecret.length, Math.max(1, Math.round(n * 0.4)));
  const chosenInnocents = [...withSecret.slice(0, secretTarget), ...without.slice(0, n - secretTarget)];
  // Top up from whichever pool still has characters if one ran short.
  const leftovers = [...withSecret.slice(secretTarget), ...without.slice(n - secretTarget)];
  while (chosenInnocents.length < n && leftovers.length) chosenInnocents.push(leftovers.shift()!);

  const inPlay = shuffle([culprit, ...chosenInnocents], rng);
  const characterOf: Record<string, string> = {};
  players.forEach((p, i) => (characterOf[p.id] = inPlay[i].id));
  const culpritPlayerId = players.find((p) => characterOf[p.id] === culprit.id)!.id;
  const used = new Set(inPlay.map((x) => x.id));

  const secrets: Secrets = { gameId, culpritPlayerId, characterOf };
  return {
    secrets,
    absent: c.characters.filter((x) => !used.has(x.id)).map((x) => ({ name: x.name, blurb: x.blurb })),
  };
}
