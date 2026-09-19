// The ElevenLabs Conversational AI agent used for spoken turns.
//
// Design: the agent is a CONSTRAINED VOICE, not an investigator. The game server (and Nebius behind it) decides
// every question. For each turn the phone starts a session with the one question as a dynamic variable; the agent
// speaks it as its first message and then only acknowledges. It can't add questions, so the question budget
// stays with the game engine. The final user transcript goes back to the server as testimony.

import { NEBIUS_BASE_URL, MODELS, VOICE } from "./config";

export const AGENT_FIRST_MESSAGE = "{{question}}";

export const AGENT_PROMPT = `You are the voice of a detective in a party game. The game's software decides every question. You never decide what to ask.

Your first message already asked the player this question: "{{question}}". That is the ONLY question this turn.

Rules you must follow, always:
1. Never ask a question of your own. No follow-ups, no clarifications, no "anything else?".
2. While the player answers, stay quiet. When they finish, reply with at most three words, chosen only from: "Mm-hm." "Go on." "I see." "Noted."
3. Never comment on, judge, summarize or react to what they said. Never say whether you believe them.
4. Never guess or discuss who is guilty or anything about the case beyond the question above.
5. If the player asks you something, say only: "Just answer the question."
6. If the player says they are finished, say only "Noted." and stop talking.`;

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
