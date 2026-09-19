#!/usr/bin/env node
// OPTIONAL setup. Stores the Nebius API key as an ElevenLabs Workspace Secret named NEBIUS_API_KEY.
//
// The running game does NOT need this: the game server calls Nebius directly with NEBIUS_API_KEY for all
// reasoning. The workspace secret is only used if you want the ElevenLabs agent's own LLM to be Nebius too
// (`npm run setup:agent -- --nebius-llm`), so that ElevenLabs can authenticate to Nebius without the key ever
// reaching a browser. Skip this script otherwise.
//
//   npm run setup:elevenlabs            create the secret, or reuse it if it already exists
//   npm run setup:elevenlabs -- --update   overwrite the existing secret's value with the current NEBIUS_API_KEY
//
// Reads ELEVENLABS_API_KEY and NEBIUS_API_KEY from the environment, .env.local or .env (server side only).
// Never prints either key. Saves the returned secret_id to .env.local as ELEVENLABS_NEBIUS_SECRET_ID.
// Docs: https://elevenlabs.io/docs/api-reference/workspace/secrets/create

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SECRET_NAME = "NEBIUS_API_KEY";
const ENV_LOCAL = resolve(process.cwd(), ".env.local");
const API_BASE = (process.env.ELEVENLABS_API_BASE || "https://api.elevenlabs.io").replace(/\/+$/, "");

// ---------- env loading (real environment wins over files) ----------

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const fileEnv = { ...parseEnvFile(resolve(process.cwd(), ".env")), ...parseEnvFile(ENV_LOCAL) };
const env = (name) => (process.env[name] ?? fileEnv[name] ?? "").trim();

const elevenKey = env("ELEVENLABS_API_KEY");
const nebiusKey = env("NEBIUS_API_KEY");

/** Belt and braces: scrub both keys from anything we print. */
function redact(text) {
  let s = String(text);
  for (const k of [elevenKey, nebiusKey]) if (k && k.length >= 6) s = s.split(k).join("[redacted]");
  return s;
}
function fail(message) {
  console.error(`\n✗ ${redact(message)}\n`);
  process.exit(1);
}

// ---------- ElevenLabs calls ----------

async function eleven(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "xi-api-key": elevenKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const d = json?.detail;
    const status = typeof d === "object" && d ? d.status || d.code : null;
    let msg = typeof d === "string" ? d : d?.message || (Array.isArray(d) ? d.map((x) => x.msg).join("; ") : text.slice(0, 300));
    if (status === "api_key_id_used_as_api_key")
      msg += "\n  ELEVENLABS_API_KEY currently holds the key's ID, not the key itself. Create or rotate a key in ElevenLabs (Settings → API Keys) and copy the full secret value shown at creation.";
    if (res.status === 401 || res.status === 403)
      msg += "\n  Check that the ElevenLabs key is valid and has permission to manage workspace secrets (Agents / ConvAI write access).";
    throw new Error(`ElevenLabs ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
  }
  return json;
}

/** All workspace secrets whose name is exactly SECRET_NAME (follows pagination). */
async function findExisting() {
  const found = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ search: SECRET_NAME, page_size: "100" });
    if (cursor) qs.set("cursor", cursor);
    const data = await eleven("GET", `/v1/convai/secrets?${qs}`);
    for (const s of data?.secrets ?? []) if (s.name === SECRET_NAME) found.push(s);
    cursor = data?.next_cursor;
    if (!cursor) break;
  }
  return found;
}

function saveSecretId(secretId) {
  const line = `ELEVENLABS_NEBIUS_SECRET_ID=${secretId}`;
  const current = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : "";
  const next = /^ELEVENLABS_NEBIUS_SECRET_ID=.*$/m.test(current)
    ? current.replace(/^ELEVENLABS_NEBIUS_SECRET_ID=.*$/m, line)
    : `${current.replace(/\n*$/, "\n")}# ElevenLabs Workspace Secret holding the Nebius key (an ID, not a credential)\n${line}\n`;
  writeFileSync(ENV_LOCAL, next);
}

// ---------- main ----------

async function main() {
  const update = process.argv.includes("--update");
  const missing = [];
  if (!elevenKey) missing.push("ELEVENLABS_API_KEY is missing");
  if (!nebiusKey) missing.push("NEBIUS_API_KEY is missing");
  if (missing.length) fail(`${missing.join("\n✗ ")}\n  Add it to .env.local (server only; never use a NEXT_PUBLIC_, VITE_ or REACT_APP_ prefix).`);

  console.log(`Checking ElevenLabs for an existing workspace secret named ${SECRET_NAME}…`);
  const existing = await findExisting();
  if (existing.length > 1)
    console.warn(`! Found ${existing.length} secrets named ${SECRET_NAME} (${existing.map((s) => s.secret_id).join(", ")}). Using the first; consider deleting the others in the ElevenLabs dashboard.`);

  let secretId;
  if (existing.length) {
    secretId = existing[0].secret_id;
    if (update) {
      await eleven("PATCH", `/v1/convai/secrets/${encodeURIComponent(secretId)}`, { type: "update", name: SECRET_NAME, value: nebiusKey });
      console.log(`✓ Workspace secret ${SECRET_NAME} updated with the current NEBIUS_API_KEY: ${secretId}`);
    } else {
      console.log(`✓ Workspace secret ${SECRET_NAME} already exists: ${secretId}`);
      console.log(`  (Not changed. Run \`npm run setup:elevenlabs -- --update\` to replace its value with your current NEBIUS_API_KEY.)`);
    }
  } else {
    const created = await eleven("POST", "/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: nebiusKey });
    secretId = created?.secret_id;
    if (!secretId) throw new Error("ElevenLabs did not return a secret_id.");
    console.log(`✓ Workspace secret ${SECRET_NAME} created successfully: ${secretId}`);
  }

  saveSecretId(secretId);
  console.log(`  Saved as ELEVENLABS_NEBIUS_SECRET_ID in .env.local.`);
  console.log(`\nNext (optional): npm run setup:agent -- --nebius-llm   to make the agent's own LLM Nebius, using this secret.`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
