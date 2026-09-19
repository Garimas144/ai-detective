# AI Detective

A multiplayer social deduction game for 3 to 8 players, played like Kahoot. One player is secretly the culprit. An AI detective (Nebius) questions everyone out loud (ElevenLabs) and must accuse exactly one person. The culprit wins if someone else is accused; an innocent player loses only if they are the one accused.

## Architecture

```
Host laptop ── one Node process (server/index.ts)
               ├─ Next.js: React pages (host screen + phone views)
               ├─ Socket.IO: realtime sync, server-authoritative game state
               ├─ Nebius: detective reasoning (server only)
               └─ ElevenLabs: detective speech + answer transcription (server only)
   │
HTTPS tunnel (cloudflared / ngrok)
   │
Phones (scan QR, enter name) · shared display (TV / projector)
```

- **Server-authoritative.** All rules run in `lib/game/engine.ts` on the host. Clients send intents; the server validates identity (from the socket's session, never the payload), applies them, and pushes views.
- **Four kinds of information, kept apart:**
  - Public: `server/views.ts` → `publicView` (case, evidence, players, current question, transcript)
  - Private: `server/views.ts` → `playerPrivate` (only that player's own card and alibi)
  - Engine truth: `Secrets` + case files (culprit, card details, evidence explanations), only in the reveal
  - AI-visible: `lib/game/detectiveView.ts` (public case + evidence + testimony + the detective's own inferences)
- **Phases:** `LOBBY → ROLE_REVEAL → ALIBI_ENTRY → INTERROGATION ⇄ ROUND_ANALYSIS → ACCUSATION → REVEAL → FINISHED`
- **Sessions:** creating or joining returns a random token saved on the device. Refresh or reconnect presents it again, so the same player (and their private card) is restored, never duplicated.
- **Timers are server-side.** If the questioned player's time plus a short grace runs out, the server records "no answer" and moves on.

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
```

Then expose it to phones over HTTPS (phone microphones need a secure context):

```bash
npm run tunnel         # Cloudflare quick tunnel; or: npm run tunnel:ngrok
```

Open the **tunnel URL** on the laptop, click "Host a game on this screen", and have players scan the QR code. Alternatively set `PUBLIC_URL` in `.env.local` to the tunnel URL so the QR code always points there.

## Keys (.env.local, server only)

| Variable | Purpose |
|---|---|
| `NEBIUS_API_KEY` | Detective reasoning. Empty = offline mock detective (flow testing only). |
| `ELEVENLABS_API_KEY` | Our ElevenLabs credential (the full secret key shown when the key is created, not its ID). Checked with ElevenLabs at startup; missing or rejected = voice off, players type. |
| `ELEVENLABS_DETECTIVE_VOICE_ID` | Optional detective voice. |
| `ELEVENLABS_NEBIUS_SECRET_ID` | Written by `npm run setup:elevenlabs`. The ID (`sec_…`) of the ElevenLabs Workspace Secret that holds the Nebius key. Not a credential. |
| `PUBLIC_URL` | Optional tunnel URL for the join QR code. |
| `DEBUG_HOST` | `1` shows raw state on the host screen (development only). |

All secrets are server-only: never give them a `NEXT_PUBLIC_`, `VITE_` or `REACT_APP_` prefix. `.env` and `.env*.local` are gitignored.

### ElevenLabs agent with Nebius as its Custom LLM

The ElevenLabs agent authenticates to Nebius using an ElevenLabs **Workspace Secret**, so the Nebius key never reaches a browser:

```
Player browser --voice--> ElevenLabs agent --Custom LLM request (workspace secret)--> Nebius
```

One-time setup (safe to re-run; it reuses the existing secret instead of creating duplicates):

```bash
npm run setup:elevenlabs              # create or reuse the NEBIUS_API_KEY workspace secret
npm run setup:elevenlabs -- --update  # after rotating the Nebius key
```

It prints and saves the secret's ID (`sec_…`) as `ELEVENLABS_NEBIUS_SECRET_ID`, never the key itself.

Check the external services:

```bash
npm run models         # lists Nebius models and flags missing IDs
npm run voice:check    # one short ElevenLabs TTS -> STT round trip
```

## Tests

```bash
npm test
```

Covers: no private data in detective prompts (all 5 cases, 8 players), no other player's card or alibi in any player's payload, nothing private on the shared screen before the reveal, session resume without duplicates, only the questioned player can answer, server-side timeouts, round structure, win/lose rules, and case content rules.

## Layout

- `server/`: `index.ts` (entry), `rooms.ts` (rooms, sessions, actions, timers), `socket.ts` (Socket.IO wiring), `views.ts` (payloads per audience), `voice.ts` (ElevenLabs)
- `lib/game/`: engine, dealing, detective view
- `lib/cases/`: the 5 cases (8 characters each, 5 evidence items with hidden explanations, the truth)
- `lib/prompts/`: extractor (per answer), review (between rounds), accusation, reveal narrator
- `lib/llm/`: Nebius client, offline mock, JSON validation
- `lib/protocol.ts`: shared event names and payload types
- `app/`: `/` landing, `/join`, `/play/[code]` (phone), `/host/[code]` (shared display)
