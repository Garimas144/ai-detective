#!/usr/bin/env node
// Starts an HTTPS tunnel to the game server so phones can join from anywhere (no shared Wi-Fi needed).
// Phones need HTTPS: browsers only offer the microphone on secure origins.
//
//   npm run tunnel              Cloudflare quick tunnel (no account needed) if `cloudflared` is installed, else ngrok
//   npm run tunnel -- ngrok     force ngrok
//   npm run tunnel -- cloudflared
//
// Then open the https URL it prints ON THE HOST LAPTOP, so the QR code uses it. (Or set PUBLIC_URL in .env.local.)

import { spawn, spawnSync } from "node:child_process";

const port = process.env.PORT || "3000";
const has = (bin) => spawnSync("which", [bin], { encoding: "utf8" }).status === 0;
const choice = process.argv[2] || (has("cloudflared") ? "cloudflared" : has("ngrok") ? "ngrok" : "");
if (!process.argv[2] && choice === "ngrok") {
  console.log("cloudflared is not installed, so falling back to ngrok. ngrok needs a free account token;");
  console.log("the easier route is:  brew install cloudflared   then run this command again.\n");
}

if (!choice || !has(choice)) {
  console.error(`
No tunnel tool found${choice ? ` (${choice} is not installed)` : ""}. Install one:
  brew install cloudflared     (recommended, no account)
  brew install ngrok           (then: ngrok config add-authtoken <token>)
`);
  process.exit(1);
}

const cmd = choice === "cloudflared" ? ["cloudflared", ["tunnel", "--url", `http://localhost:${port}`]] : ["ngrok", ["http", port]];
console.log(`Starting ${choice} -> http://localhost:${port}  (is \`npm run dev\` running?)\n`);
if (choice === "ngrok") console.log("ngrok shows its https URL in its own screen, or at http://127.0.0.1:4040\n");
if (choice === "cloudflared") console.log("Look for the https://….trycloudflare.com line below.\n");
const child = spawn(cmd[0], cmd[1], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
