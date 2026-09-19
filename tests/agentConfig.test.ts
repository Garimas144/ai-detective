import { describe, expect, it } from "vitest";
import { AGENT_FIRST_MESSAGE, AGENT_PROMPT, buildAgentConfig } from "@/lib/agentConfig";
import { NEBIUS_BASE_URL, MODELS } from "@/lib/config";

describe("ElevenLabs agent configuration", () => {
  it("is a constrained voice: it speaks the supplied question and can't ask its own", () => {
    expect(AGENT_FIRST_MESSAGE).toBe("{{question}}");
    expect(AGENT_PROMPT).toContain("{{question}}");
    expect(AGENT_PROMPT).toMatch(/Never ask a question of your own/);
    expect(AGENT_PROMPT).toMatch(/ONLY question this turn/);
    expect(AGENT_PROMPT).toMatch(/at most three words/);
    expect(AGENT_PROMPT).toMatch(/Never guess or discuss who is guilty/);
    const cfg = buildAgentConfig();
    expect(cfg.conversation_config.agent.first_message).toBe("{{question}}");
    expect(cfg.conversation_config.agent.prompt.max_tokens).toBeLessThanOrEqual(30); // it physically can't monologue or interrogate
  });

  it("is a private agent: sessions need a token our server issues", () => {
    expect(buildAgentConfig().platform_settings.auth.enable_auth).toBe(true);
  });

  it("uses no credentials, and only references Nebius through a workspace secret ID", () => {
    const plain = JSON.stringify(buildAgentConfig());
    expect(plain).not.toMatch(/api[_-]?key|sk_|nebius/i);
    const withNebius = buildAgentConfig({ customLlmSecretId: "sec_abc123" });
    const prompt = withNebius.conversation_config.agent.prompt as { llm: string; custom_llm: { url: string; model_id: string; api_key: { secret_id: string } } };
    expect(prompt.llm).toBe("custom-llm");
    expect(prompt.custom_llm.url).toBe(NEBIUS_BASE_URL.replace(/\/+$/, ""));
    expect(prompt.custom_llm.model_id).toBe(MODELS.detectiveTurn);
    expect(prompt.custom_llm.api_key).toEqual({ secret_id: "sec_abc123" });
    expect(JSON.stringify(withNebius)).not.toMatch(/nebius_|Bearer/);
  });
});
