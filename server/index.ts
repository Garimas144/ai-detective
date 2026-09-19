// Host machine entry point: one Node process serving the React app (Next.js) and realtime game sync
// (Socket.IO). Expose it to phones through an HTTPS tunnel (see README), since phone microphones need HTTPS.

import { createServer } from "node:http";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd()); // load .env.local before anything reads process.env

async function main() {
  const { default: next } = await import("next");
  const { Server } = await import("socket.io");
  const { VOICE } = await import("../lib/config");
  const { getLLM } = await import("../lib/llm/provider");
  const { Rooms } = await import("./rooms");
  const { attachSockets, broadcastRoom } = await import("./socket");
  const { createVerifiedVoiceService } = await import("./voice");

  const dev = process.env.NODE_ENV !== "production";
  const portArg = process.argv.indexOf("--port");
  const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT ?? 3000);
  const app = next({ dev, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();

  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, { maxHttpBufferSize: VOICE.maxAudioBytes + 64 * 1024, destroyUpgrade: false });

  const voice = await createVerifiedVoiceService();
  const rooms: InstanceType<typeof Rooms> = new Rooms({
    llm: getLLM(),
    voice,
    publicUrl: process.env.PUBLIC_URL?.trim() || null,
    broadcast: (room) => broadcastRoom(io, rooms, room),
    onKick: (room, playerId) => {
      for (const c of room.connections.values()) if (c.playerId === playerId) io.to(c.id).emit("kicked");
    },
  });
  attachSockets(io, rooms);

  // Next.js dev hot reload uses its own websocket; Socket.IO handles /socket.io.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/socket.io")) nextUpgrade(req, socket, head);
  });

  server.listen(port, () => {
    console.log(`\n  AI Detective running on http://localhost:${port}`);
    console.log(`  Detective model: ${getLLM().provider === "mock" ? "offline MOCK (set NEBIUS_API_KEY)" : "Nebius"}`);
    console.log(`  Voice: ${voice.enabled ? "ElevenLabs" : "off (ELEVENLABS_API_KEY missing or rejected); players type answers"}`);
    console.log(`  Phones: run a tunnel, e.g.  cloudflared tunnel --url http://localhost:${port}\n`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
