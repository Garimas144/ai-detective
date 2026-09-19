// Round-trips one short phrase through ElevenLabs TTS and STT to confirm the key and models work.
// Usage: npm run voice:check   (uses ELEVENLABS_API_KEY from .env.local; costs a few credits)
import { loadEnvConfig } from "@next/env";
import { createVoiceService } from "../server/voice";
loadEnvConfig(process.cwd());
async function main() {
  const v = createVoiceService();
  console.log("enabled:", v.enabled);
  const t0 = Date.now();
  const { audio, mimeType } = await v.speak("Dr. Finch, where were you at ten o'clock?");
  console.log("TTS:", mimeType, audio.length, "bytes in", Date.now() - t0, "ms");
  const t1 = Date.now();
  const text = await v.transcribe(audio, "audio/mpeg");
  console.log("STT:", JSON.stringify(text), "in", Date.now() - t1, "ms");
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
