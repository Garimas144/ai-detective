// Lists Nebius models so the IDs and prices in lib/config.ts can be checked.
// Usage: npm run models   (reads NEBIUS_API_KEY from .env.local)

import { readFileSync } from "node:fs";
import { MODELS, NEBIUS_BASE_URL } from "../lib/config";

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}

async function main() {
  loadEnv();
  const key = process.env.NEBIUS_API_KEY;
  if (!key) throw new Error("NEBIUS_API_KEY is empty in .env.local");
  const res = await fetch(`${NEBIUS_BASE_URL}models?verbose=true`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
  const wanted = new Set<string>(Object.values(MODELS));
  for (const m of data.sort((a, b) => a.id.localeCompare(b.id))) {
    const price = m.pricing ? `  in $${(Number(m.pricing.prompt) * 1e6).toFixed(2)}/M  out $${(Number(m.pricing.completion) * 1e6).toFixed(2)}/M` : "";
    console.log(`${wanted.has(m.id) ? "*" : " "} ${m.id}${price}`);
  }
  const ids = new Set(data.map((m) => m.id));
  const missing = [...wanted].filter((id) => !ids.has(id));
  console.log(missing.length ? `\nMISSING from your account: ${missing.join(", ")}` : "\nAll configured models are available.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
