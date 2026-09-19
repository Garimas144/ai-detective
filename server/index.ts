// Host machine entry point: one Node process serving the React app (Next.js) and realtime game sync
// (Socket.IO). Expose it to phones through an HTTPS tunnel (see README), since phone microphones need HTTPS.

import { createServer } from "node:http";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd()); // load .env.local before anything reads process.env

async function main() {
  const { default: next } = await import("next");
  const { Server } = await import("socket.io");
  const { VOICE } = await import("../lib/config");
  const { getLLM, mockBanner, selectLLM } = await import("../lib/llm/provider");
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

  const llm = getLLM(); // throws if REQUIRE_NEBIUS=1 and the mock would be used
  const voice = await createVerifiedVoiceService();
  const rooms: InstanceType<typeof Rooms> = new Rooms({
    llm,
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
    if (llm.provider === "mock") console.warn(mockBanner(selectLLM().reason));
    else console.log("  Detective model: Nebius (live)");
    console.log(`  Voice mode: ${voice.mode === "agent" ? "agent (ElevenLabs Conversational AI)" : voice.mode === "stt-tts" ? "stt-tts fallback (recorder + text-to-speech)" : "text (players type)"}`);
    for (const note of voice.notes) console.log(`    - ${note}`);
    console.log(`  Public URL: ${process.env.PUBLIC_URL?.trim() || "(none set; open the host page through your HTTPS tunnel URL)"}`);
    console.log("  Phones need HTTPS for the microphone: run `npm run tunnel` in another terminal.");
    console.log("  Before a demo: npm run preflight\n");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
