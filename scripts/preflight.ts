// Demo preflight: run this before a demo. It checks the real services, never prints a key, and exits 1 if
// something that would ruin the demo is wrong.
//
//   npm run preflight              checks keys, Nebius models, ElevenLabs, voice mode, public URL
//   npm run preflight -- --speak   also does one short ElevenLabs text-to-speech + speech-to-text round trip

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import OpenAI from "openai";
import { NEBIUS_BASE_URL, RUNTIME_MODELS } from "../lib/config";
import { selectLLM } from "../lib/llm/provider";
import { createVerifiedVoiceService } from "../server/voice";

loadEnvConfig(process.cwd());

let failures = 0;
let warnings = 0;
const ok = (label: string, detail = "") => console.log(`  ✓ ${label.padEnd(30)} ${detail}`);
const bad = (label: string, detail: string) => (failures++, console.log(`  ✗ ${label.padEnd(30)} ${detail}`));
const warn = (label: string, detail: string) => (warnings++, console.log(`  ! ${label.padEnd(30)} ${detail}`));
const section = (t: string) => console.log(`\n${t}`);

const nebiusKey = process.env.NEBIUS_API_KEY?.trim() ?? "";
const elevenKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
const publicUrl = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "") ?? "";
const secrets = [nebiusKey, elevenKey].filter((s) => s.length >= 8);
const scrub = (t: string) => secrets.reduce((acc, s) => acc.split(s).join("[redacted]"), t);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
}

async function checkNebius() {
  section("Nebius (detective reasoning)");
  const choice = selectLLM();
  if (choice.provider === "mock") return bad("Mock LLM", `WOULD BE USED: ${choice.reason}. The demo would run on canned heuristics, not Nebius.`);
  ok("Mock LLM", "OFF (Nebius will be used)");
  const client = new OpenAI({ apiKey: nebiusKey, baseURL: NEBIUS_BASE_URL, maxRetries: 1, timeout: 30_000 });
  let available = new Set<string>();
  try {
    const [list, ms] = await timed(() => client.models.list());
    available = new Set(list.data.map((m) => m.id));
    ok("Nebius endpoint", `live (${ms} ms, ${available.size} models)`);
  } catch (err) {
    return bad("Nebius endpoint", scrub(err instanceof Error ? err.message : String(err)));
  }
  for (const { role, id } of RUNTIME_MODELS) {
    if (!available.has(id)) {
      const primary = !/fallback/i.test(role);
      (primary ? bad : warn)(role, `${id} is NOT available on your account. Set NEBIUS_MODEL_* in .env.local to one from \`npm run models\`.`);
      continue;
    }
    try {
      const [, ms] = await timed(() => client.chat.completions.create({ model: id, messages: [{ role: "user", content: "Reply with the single word: ready" }], max_tokens: 64 }));
      ok(role, `${id} (${ms} ms)`);
    } catch (err) {
      (/fallback/i.test(role) ? warn : bad)(role, `${id} is listed but a test call failed: ${scrub(err instanceof Error ? err.message : String(err)).slice(0, 160)}`);
    }
  }
}

async function checkElevenLabs() {
  section("ElevenLabs (voice)");
  if (!elevenKey) return bad("ElevenLabs API", "ELEVENLABS_API_KEY is missing");
  const voice = await createVerifiedVoiceService();
  if (voice.mode === "text") return bad("ElevenLabs API", voice.notes.join(" "));
  ok("ElevenLabs API", "key accepted");
  if (voice.mode === "agent") {
    ok("ElevenLabs Agent", `${process.env.ELEVENLABS_AGENT_ID} reachable`);
    try {
      const [, ms] = await timed(() => voice.getConversationToken());
      ok("Agent session token", `issued (${ms} ms). Players can start a conversation.`);
    } catch (err) {
      bad("Agent session token", scrub(err instanceof Error ? err.message : String(err)) + "  (is 'Enable authentication' on for the agent? run `npm run setup:agent`)");
    }
  } else {
    warn("ElevenLabs Agent", voice.notes.join(" ") + "  Run `npm run setup:agent`.");
  }
  ok("Voice mode", voice.mode === "agent" ? "agent (conversational)" : "stt-tts fallback (NOT the conversational agent)");
  if (process.argv.includes("--speak")) {
    try {
      const [{ audio }, tts] = await timed(() => voice.speak("Where were you at ten o'clock?"));
      const [text, stt] = await timed(() => voice.transcribe(audio, "audio/mpeg"));
      ok("TTS + STT round trip", `spoke ${audio.length} bytes (${tts} ms), heard "${text}" (${stt} ms)`);
    } catch (err) {
      bad("TTS + STT round trip", scrub(err instanceof Error ? err.message : String(err)));
    }
  }
}

async function checkPublicUrl() {
  section("Phones / tunnel");
  let url = publicUrl;
  if (!url) {
    // ngrok exposes its live tunnels on a local API; use it if it is running.
    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1500) });
      const json = (await res.json()) as { tunnels?: { public_url?: string }[] };
      url = json.tunnels?.map((t) => t.public_url ?? "").find((u) => u.startsWith("https://")) ?? "";
      if (url) ok("ngrok tunnel detected", url);
    } catch {}
  }
  if (!url) return warn("Public URL", "PUBLIC_URL is not set and no ngrok tunnel was found. Start a tunnel (npm run tunnel) and open the https URL on the host laptop; the QR code then uses it automatically.");
  if (publicUrl) ok("Public URL", publicUrl);
  if (!url.startsWith("https://")) bad("Secure microphone origin", `${url} is not https. Phone microphones will be blocked.`);
  else ok("Secure microphone origin", "https");
  try {
    const [res, ms] = await timed(() => fetch(`${url}/socket.io/?EIO=4&transport=polling`, { signal: AbortSignal.timeout(8000) }));
    const body = await res.text();
    if (res.ok && body.includes("sid")) ok("Socket.IO through the tunnel", `reachable (${ms} ms)`);
    else warn("Socket.IO through the tunnel", `HTTP ${res.status}. Is \`npm run dev\` running and the tunnel pointed at it?`);
  } catch (err) {
    warn("Socket.IO through the tunnel", `not reachable: ${err instanceof Error ? err.message : err}. Start \`npm run dev\` and the tunnel.`);
  }
}

function checkClientExposure() {
  section("Secrets stay on the server");
  const envNames = Object.keys(process.env).filter((n) => /^(NEXT_PUBLIC_|VITE_|REACT_APP_)/.test(n) && /KEY|SECRET|TOKEN/i.test(n));
  if (envNames.length) bad("Client-exposed variables", `${envNames.join(", ")} would be shipped to browsers. Rename them without the public prefix.`);
  else ok("Client-exposed variables", "none");
  const dir = join(process.cwd(), ".next", "static");
  if (!existsSync(dir)) return ok("Browser bundle scan", "no build found (run `npm run build` to scan)");
  let leaked = 0;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|css|html|json|map)$/.test(f)) {
        const text = readFileSync(p, "utf8");
        if (secrets.some((s) => text.includes(s))) leaked++;
      }
    }
  };
  walk(dir);
  if (leaked) bad("Browser bundle scan", `${leaked} browser file(s) contain an API key value!`);
  else ok("Browser bundle scan", "no key values in any browser file");
}

async function main() {
  console.log("AI Detective preflight (no keys are printed)");
  await checkNebius();
  await checkElevenLabs();
  await checkPublicUrl();
  checkClientExposure();
  console.log(failures ? `\n✗ ${failures} problem(s) to fix before a demo${warnings ? `, ${warnings} warning(s)` : ""}.\n` : `\n✓ Ready${warnings ? ` (with ${warnings} warning(s) above)` : ""}.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("Preflight crashed:", scrub(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
