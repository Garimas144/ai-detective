import { z } from "zod";
import { MODELS } from "../config";
import type { LLMRequest } from "../llm/types";
import { renderCase, TESTIMONY_RULE, type DetectiveView } from "../game/detectiveView";

export const extractorSchema = z.object({
  claims: z
    .array(
      z.object({
        subject: z.string(),
        location: z.string().nullish(),
        timeStart: z.string().nullish(),
        timeEnd: z.string().nullish(),
        aboutPlayerIds: z.array(z.string()).nullish(),
        statement: z.string(),
      }),
    )
    .max(12),
  evasive: z.boolean(),
});
export type ExtractorOutput = z.infer<typeof extractorSchema>;

const SYSTEM = `You are the Recorder on an AI detective's team. You turn one piece of testimony (a written alibi or a spoken answer) into atomic claims.

${TESTIMONY_RULE}

Record things such as: claimed locations, claimed times, who the speaker says they saw, events they claim happened, statements about other people, explanations for evidence, and anything that changes their earlier story.

Rules:
- One checkable assertion per claim. Split compound sentences.
- "statement" MUST be phrased as testimony in third person: "Marcus says he was in the stairwell from 21:05 to 21:20." Never state it as fact.
- Record implausible or absurd statements exactly as said ("Jess says she flew to the moon at 22:00"). Do not correct or reinterpret them.
- "subject" is who the claim is about. Use character names.
- Times in 24-hour HH:MM when given or clearly implied, otherwise null. "location" is a short place name or null.
- "aboutPlayerIds" lists the ids of OTHER people being questioned whom this claim is about, or [].
- "evasive" is true only for a spoken answer that dodges or refuses what was asked.

Reply with JSON only:
{"claims":[{"subject":string,"location":string|null,"timeStart":"HH:MM"|null,"timeEnd":"HH:MM"|null,"aboutPlayerIds":[string],"statement":string}],"evasive":boolean}`;

export function buildExtractorRequest(
  view: DetectiveView,
  speaker: { id: string; character: string },
  kind: "alibi" | "answer",
  question: string | null,
  text: string,
): LLMRequest {
  const user = `${renderCase(view)}

SPEAKER: ${speaker.character} (id ${speaker.id})
${kind === "alibi" ? "THIS IS THEIR WRITTEN ALIBI, submitted before questioning." : `QUESTION ASKED: "${question}"`}
TESTIMONY: "${text}"

Record the claims.`;
  return {
    purpose: "extractor",
    model: MODELS.detectiveTurn,
    system: SYSTEM,
    user,
    json: true,
    temperature: 0.1,
    maxTokens: 1200,
    mockData: { speakerName: speaker.character, speakerId: speaker.id, players: view.players, question, answer: text, kind },
  };
}
