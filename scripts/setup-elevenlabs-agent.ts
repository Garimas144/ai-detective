// Creates (or updates) the constrained ElevenLabs Conversational AI agent and saves ELEVENLABS_AGENT_ID.
//
//   npm run setup:agent                       create the agent, or update the one in ELEVENLABS_AGENT_ID
//   npm run setup:agent -- --nebius-llm       also use Nebius as the agent's own LLM (needs setup:elevenlabs first)
//   npm run setup:agent -- --print            print the agent configuration (no keys) for manual dashboard setup
//
// Docs: https://elevenlabs.io/docs/api-reference/agents/create

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { buildAgentConfig } from "../lib/agentConfig";

loadEnvConfig(process.cwd());
const ENV_LOCAL = resolve(process.cwd(), ".env.local");
// ELEVENLABS_API_BASE (an origin, no /v1) exists only so tests can point at a local fake.
const API = `${(process.env.ELEVENLABS_API_BASE?.trim() || "https://api.elevenlabs.io").replace(/\/+$/, "")}/v1`;

const args = new Set(process.argv.slice(2));
const apiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const existingId = process.env.ELEVENLABS_AGENT_ID?.trim() ?? "";
const secretId = process.env.ELEVENLABS_NEBIUS_SECRET_ID?.trim() ?? "";

function fail(message: string): never {
  console.error(`\n✗ ${apiKey ? message.split(apiKey).join("[redacted]") : message}\n`);
  process.exit(1);
}

function saveEnv(name: string, value: string) {
  const line = `${name}=${value}`;
  const current = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(ENV_LOCAL, re.test(current) ? current.replace(re, line) : `${current.replace(/\n*$/, "\n")}${line}\n`);
}

async function main() {
  if (args.has("--nebius-llm") && !secretId) fail("--nebius-llm needs ELEVENLABS_NEBIUS_SECRET_ID. Run `npm run setup:elevenlabs` first (it stores your Nebius key as an ElevenLabs Workspace Secret).");
  const config = buildAgentConfig({ voiceId: process.env.ELEVENLABS_DETECTIVE_VOICE_ID?.trim() || undefined, customLlmSecretId: args.has("--nebius-llm") ? secretId : undefined });
  if (args.has("--print")) return console.log(JSON.stringify(config, null, 2));

  if (!apiKey) fail("ELEVENLABS_API_KEY is missing. Add it to .env.local (server only).");
  const method = existingId ? "PATCH" : "POST";
  const path = existingId ? `/convai/agents/${encodeURIComponent(existingId)}` : "/convai/agents/create";
  console.log(existingId ? `Updating agent ${existingId}…` : "Creating the agent…");
  const res = await fetch(`${API}${path}`, { method, headers: { "xi-api-key": apiKey, "Content-Type": "application/json" }, body: JSON.stringify(config) });
  const text = await res.text();
  let json: { agent_id?: string; detail?: unknown } | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const detail = JSON.stringify(json?.detail ?? text).slice(0, 600);
    const hint = /api_key_id_used_as_api_key/.test(detail) ? "\n  ELEVENLABS_API_KEY holds the key's ID, not the key itself. Create or rotate a key (Settings > API Keys) and copy the full secret value shown at creation." : "";
    fail(`ElevenLabs ${method} ${path} failed (HTTP ${res.status}): ${detail}${hint}`);
  }
  const agentId = json?.agent_id ?? existingId;
  if (!agentId) fail("ElevenLabs did not return an agent_id.");
  saveEnv("ELEVENLABS_AGENT_ID", agentId);
  console.log(`✓ Agent ${existingId ? "updated" : "created"}: ${agentId}`);
  console.log("  Saved as ELEVENLABS_AGENT_ID in .env.local. Restart `npm run dev`, then run `npm run preflight`.");
  console.log(`  LLM: ${args.has("--nebius-llm") ? "Nebius (Custom LLM, via workspace secret)" : "ElevenLabs-hosted (it only voices the question and acknowledges; all reasoning is Nebius via the game server)"}`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
