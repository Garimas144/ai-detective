// The ElevenLabs Conversational AI agent used for spoken turns (the phone microphone side).
//
// Design: the agent is a CONSTRAINED LISTENER, not an investigator. The game server (and Nebius behind it) decides
// every question, and the host screen speaks it aloud automatically. The phone microphone button only opens the
// agent session to capture the answer: the agent stays silent until the player speaks, then only acknowledges.
// It can't add questions, so the question budget stays with the game engine. The final user transcript goes back
// to the server as testimony.

import { NEBIUS_BASE_URL, MODELS, VOICE } from "./config";

/** Empty on purpose: the question is spoken out loud by the host screen, and the agent waits for the player to speak. */
export const AGENT_FIRST_MESSAGE = "";

export const AGENT_PROMPT = `You are the voice of a detective in a party game. The game's software decides every question and asks it out loud on the main speaker. You never decide what to ask, and you never speak first.

The question the player is answering right now is: "{{question}}". That is the ONLY question this turn.

Rules you must follow, always:
1. Say nothing until the player has spoken.
2. Never ask a question of your own. No follow-ups, no clarifications, no "anything else?".
3. When the player finishes, reply with at most three words, chosen only from: "Mm-hm." "Go on." "I see." "Noted."
4. Never comment on, judge, summarize or react to what they said. Never say whether you believe them.
5. Never guess or discuss who is guilty or anything about the case.
6. If the player asks you something, say only: "Just answer the question."
7. If the player says they are finished, say only "Noted." and stop talking.`;

export interface AgentConfigOptions {
  voiceId?: string;
  /** Use Nebius as the agent's own LLM via an ElevenLabs Workspace Secret. Optional, see README. */
  customLlmSecretId?: string;
}

/** Body for POST /v1/convai/agents/create and PATCH /v1/convai/agents/{id}. Contains no credentials. */
export function buildAgentConfig(opts: AgentConfigOptions = {}) {
  const useNebius = !!opts.customLlmSecretId;
  return {
    name: "AI Detective (constrained voice)",
    conversation_config: {
      agent: {
        first_message: AGENT_FIRST_MESSAGE,
        language: "en",
        dynamic_variables: { dynamic_variable_placeholders: { question: "Tell me exactly where you were tonight." } },
        prompt: {
          prompt: AGENT_PROMPT,
          ...(useNebius
            ? { llm: "custom-llm", custom_llm: { url: NEBIUS_BASE_URL.replace(/\/+$/, ""), model_id: MODELS.detectiveTurn, api_key: { secret_id: opts.customLlmSecretId } } }
            : { llm: "gemini-2.5-flash" }),
          temperature: 0.2,
          max_tokens: 24,
        },
      },
      tts: { voice_id: opts.voiceId || VOICE.defaultDetectiveVoiceId, model_id: VOICE.agentTtsModel },
      turn: { turn_timeout: 20, turn_eagerness: "patient" },
      conversation: { max_duration_seconds: 180 },
    },
    // Private agent: sessions need a token our server issues, so a leaked agent ID can't be used to spend credits.
    platform_settings: { auth: { enable_auth: true } },
  };
}
