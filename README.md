# AI Detective

A multiplayer social deduction game for 3 to 8 players, played like Kahoot. One player is secretly the culprit. An AI detective questions everyone out loud and must accuse exactly one person. The culprit wins if someone else is accused; an innocent player loses only if they are the one accused.

## What runs where

```
                        ┌────────────────────────── host laptop ──────────────────────────┐
Player phone ──HTTPS──▶ │ tunnel ─▶ one Node process (server/index.ts)                    │
   │ mic / audio        │            ├─ Next.js: React pages (host screen, phone views)   │
   │                    │            ├─ Socket.IO: realtime sync, authoritative game state │
   │                    │            ├─ Nebius: ALL detective reasoning ───────────────────┼─▶ Nebius Token Factory
   │                    │            └─ ElevenLabs API key (never leaves this process) ────┼─▶ ElevenLabs API
   │                    └────────────────────────────────────────────────────────────────┘
   └─ WebRTC voice session (token from our server) ─────────────────────────────────────────▶ ElevenLabs Conversational AI agent
```

**Responsibilities (kept strictly apart)**

| Component | Owns |
|---|---|
| Game server (`lib/game/engine.ts`, `server/rooms.ts`) | Rooms, phases, roles, the hidden culprit, alibis, question count, timers, scoring, testimony history, winners, the reveal. Never delegated to a browser or an LLM. |
| **Nebius** (`lib/prompts/*`, `lib/llm/nebius.ts`) | Claim extraction, contradictions, corroborations, open questions, between-round reasoning, question allocation, early-end decision, the final accusation and its reasoning, the reveal narration. |
| **ElevenLabs** | The live voice layer: the phone microphone, the spoken conversation, the detective's voice. |

### Voice modes (the server picks one at startup and shows it on the host screen)

| Mode | What it is | When |
|---|---|---|
| **`agent`** | A real **ElevenLabs Conversational AI (Agents)** session on the player's phone, over WebRTC (`@elevenlabs/react`). | `ELEVENLABS_API_KEY` works **and** `ELEVENLABS_AGENT_ID` is a reachable agent. This is the demo path. |
| `stt-tts` | Fallback. Phone records audio, the server transcribes it with ElevenLabs Scribe, the host screen speaks the question with ElevenLabs TTS. **Not** the Conversational AI product. | Key works, no agent configured or reachable. Also the phone's automatic fallback if an agent session fails to connect. |
| `text` | Players type. | No working ElevenLabs key, or the phone's microphone is blocked. |

Each phone also degrades on its own: agent → recorder → typing, and it says why (e.g. "Microphone access is blocked. On iPhone: tap aA, Website Settings…").

### How one spoken turn works ("one question means one question")

1. The engine (from Nebius's plan) picks the question and the player. It is public text.
2. Only that player's phone can ask the server for a **single-use conversation token** for that question. The server calls ElevenLabs with the API key and returns only the short-lived token. The phone never sees the API key.
3. The phone starts a WebRTC session (`startSession({ conversationToken, dynamicVariables: { question } })`). The agent's first message is exactly `{{question}}`.
4. The agent is a **constrained voice, not an investigator** (`lib/agentConfig.ts`): it cannot ask questions of its own, only acknowledges ("Mm-hm.", "Go on."), max 24 tokens per reply. The question budget stays with the game engine.
5. The player answers out loud. The phone collects the player's **user transcripts** (the agent's words are ignored) and sends them to the server when the player taps done or time is up.
6. The server accepts them only for the session it issued for that player and question, once. It cross-checks against ElevenLabs' own record of the conversation when available and prefers that; otherwise it uses what the phone reported. The exact wording (fillers included) is stored as **testimony** with metadata (`Turn.voice`: mode, transcript source, conversation id, raw segments, answer time).
7. Nebius extracts claims from that testimony and reasons over it. The game advances by exactly one question.

The server also enforces the answer clock: if the time (plus a short grace) passes with no answer, it records "no answer" and moves on.

### Evidence, testimony, inference

Only the five case evidence items are objective. Everything a player writes or says is testimony and is stored as "X says …" (the engine re-adds the attribution if a model drops it). Nebius's conclusions are inference. Strong signals (contradictions with evidence, the written alibi, earlier statements, other players) outweigh weak ones (evasiveness, implausibility); hesitation and filler words are preserved in the transcript but never drive a ruling.

### Four levels of information

| Level | Contains | Built by |
|---|---|---|
| Public | case, 5 evidence items, players, round, current question, public transcript | `server/views.ts` → `publicView` |
| Player-private | that player's own card, role, secrets, their own alibi | `playerPrivate` |
| Engine-only truth | culprit, hidden explanation, evidence explanations, all cards | `Secrets` + case files (revealed only at the reveal) |
| Detective-visible | public evidence, alibis, testimony, prior questions, contradictions, corroborations, suspicion state | `lib/game/detectiveView.ts` |

Nebius never receives the culprit's identity or private cards (enforced by tests). Character names and one-line descriptions are a public cast list (`GAME.publicCast`, on by default): players' testimony refers to characters by name, and the detective can only connect "Dr. Finch" to a player if it knows the cast. A player's guilty/innocent status stays private. Set `publicCast: false` in `lib/config.ts` to hide even that, at the cost of weaker cross-player reasoning.

## Run it (demo)

```bash
npm install
cp .env.example .env.local     # then fill in the keys (see below)
npm run setup:agent            # once: creates the ElevenLabs agent and saves ELEVENLABS_AGENT_ID
npm run preflight              # checks everything, prints no keys
npm run demo                   # like `npm run dev`, but refuses to start on the mock detective
```

In a second terminal, start the HTTPS tunnel (phone microphones need HTTPS):

```bash
npm run tunnel                 # Cloudflare quick tunnel if installed (brew install cloudflared), otherwise ngrok
```

Open the **https tunnel URL** on the host laptop, click "Host a game on this screen", and have phones scan the QR code. The QR code uses the URL you opened, so it is automatically the tunnel URL. `PUBLIC_URL` overrides it. If you open the host page on `localhost`, a red warning says phones can't use it. Phones do not need to be on the same Wi-Fi.

`npm run dev` is the same server without the strict Nebius guard (it runs on the mock detective if there is no key, and says so loudly).

## Environment variables (`.env.local`, server only, see `.env.example`)

| Variable | Needed | Purpose |
|---|---|---|
| `NEBIUS_API_KEY` | yes | Detective reasoning. Missing = **mock detective**, with a red banner on every screen and a console banner. |
| `ELEVENLABS_API_KEY` | yes | ElevenLabs. Must be the full secret key shown when a key is created (not its ID). Checked with ElevenLabs at startup. |
| `ELEVENLABS_AGENT_ID` | for `agent` mode | Written by `npm run setup:agent`. |
| `PUBLIC_URL` | optional | Tunnel URL for the QR code. |
| `ELEVENLABS_DETECTIVE_VOICE_ID` | optional | Detective voice (TTS and the agent). |
| `NEBIUS_MODEL_EXTRACT`, `_EXTRACT_FALLBACK`, `_REASONING`, `_REASONING_FALLBACK` | optional | Override Nebius model IDs without editing code. |
| `LLM_PROVIDER=mock`, `REQUIRE_NEBIUS=1`, `DEBUG_HOST=1` | dev switches | Force the mock; refuse the mock; show raw state on the host screen. |
| `ELEVENLABS_NEBIUS_SECRET_ID` | only for `setup:agent -- --nebius-llm` | See below. The runtime never reads it. |

Never give a secret a `NEXT_PUBLIC_`, `VITE_` or `REACT_APP_` prefix. `.env` and `.env*.local` are gitignored. Browser storage only ever holds a random session token.

## Nebius models

Configured in `lib/config.ts` (overridable by env). Per-answer **extraction** uses a fast model (`Qwen/Qwen3-235B-A22B-Instruct-2507`, fallback `Qwen/Qwen3-30B-A3B-Instruct-2507`). **Reasoning** (between rounds and the accusation) uses `deepseek-ai/DeepSeek-V4.1-Flash` (fallback `Qwen/Qwen3-235B-A22B-Instruct-2507`). `npm run preflight` calls each model and tells you which are missing on your account; `npm run models` lists everything available.

## Optional: Nebius as the agent's own LLM

Not required. By default the agent's LLM only voices the question and acknowledges, and all reasoning is Nebius via the game server. If you also want the agent's LLM to be Nebius, ElevenLabs can authenticate to Nebius with a **Workspace Secret**, so the Nebius key still never reaches a browser:

```bash
npm run setup:elevenlabs           # stores NEBIUS_API_KEY as an ElevenLabs Workspace Secret (reuses it if it exists)
npm run setup:agent -- --nebius-llm
```

## One-time ElevenLabs dashboard checks

`npm run setup:agent` configures the agent (constrained prompt, first message `{{question}}`, private/authenticated, patient turn-taking, 180 s cap). If you'd rather configure it by hand, `npm run setup:agent -- --print` prints the exact configuration. In the dashboard, confirm that the agent has **authentication enabled**, that its voice is what you want, and that your API key has Agents access.

## Commands

| | |
|---|---|
| `npm run dev` / `npm run demo` | Start the game (Next.js + Socket.IO on port 3000; `PORT` to change) |
| `npm run tunnel` / `tunnel:ngrok` | HTTPS tunnel to the game |
| `npm run preflight [-- --speak]` | Pre-demo checks (Nebius, models, ElevenLabs, agent, public URL, secrets) |
| `npm run setup:agent` | Create/update the ElevenLabs agent |
| `npm run setup:elevenlabs` | Optional: Nebius key as an ElevenLabs Workspace Secret |
| `npm run models`, `npm run voice:check` | List Nebius models; TTS→STT round trip |
| `npm test`, `npm run typecheck`, `npm run build` | Tests, types, production build (don't run `build` while `dev` is running: they share `.next`) |

## Layout

- `server/`: `index.ts` (entry), `rooms.ts` (rooms, sessions, agent tokens, timers), `socket.ts` (Socket.IO), `views.ts` (per-audience payloads), `voice.ts` (ElevenLabs, voice modes)
- `lib/game/`: engine, dealing, detective view. `lib/cases/`: 5 cases. `lib/prompts/`: Nebius prompts. `lib/llm/`: Nebius client, mock, provider selection
- `lib/agentConfig.ts`: the ElevenLabs agent's prompt and configuration. `lib/protocol.ts`: shared event names and payload types
- `app/`: `/` landing, `/join`, `/play/[code]` (phone), `/host/[code]` (shared screen). `components/AgentTurn.tsx`: the ElevenLabs session on the phone
- `tests/`: isolation, rules, scoring, Nebius wiring (against a local Nebius look-alike), voice/agent, Socket.IO integration
