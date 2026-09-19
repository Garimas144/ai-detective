import type { Case, PublicEvidence } from "../types";
import { blackwoodManor } from "./blackwood-manor";
import { lakesideCabin } from "./lakeside-cabin";
import { museumHeist } from "./museum-heist";
import { nightTrain } from "./night-train";
import { stolenPrototype } from "./stolen-prototype";

export const CASES: Case[] = [stolenPrototype, museumHeist, blackwoodManor, lakesideCabin, nightTrain];

export function getCase(id: string): Case {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown case: ${id}`);
  return c;
}

/** Public case card info only. Safe for any screen. */
export function caseCards() {
  return CASES.map(({ id, title, description, setting }) => ({ id, title, description, setting }));
}

/** Evidence without its hidden kind and explanation. */
export function publicEvidence(c: Case): PublicEvidence[] {
  return c.evidence.map(({ id, title, text }) => ({ id, title, text }));
}
