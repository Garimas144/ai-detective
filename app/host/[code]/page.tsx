"use client";

// Shared display (laptop / TV / projector). Only ever receives the public view: no private roles,
// alibis, or detective internals until the reveal.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { JoinQr } from "@/components/JoinQr";
import { Reveal } from "@/components/Reveal";
import { Timer, useCountdown } from "@/components/useCountdown";
import { emitAck, useGame } from "@/lib/client/useGame";
import { EVENTS, type HostAction, type PublicView } from "@/lib/protocol";

const STEPS: { label: string; phases: PublicView["phase"][] }[] = [
  { label: "Lobby", phases: ["LOBBY"] },
  { label: "Roles", phases: ["ROLE_REVEAL"] },
  { label: "Alibis", phases: ["ALIBI_ENTRY"] },
  { label: "Interrogation", phases: ["INTERROGATION", "ROUND_ANALYSIS"] },
  { label: "Accusation", phases: ["ACCUSATION"] },
  { label: "Reveal", phases: ["REVEAL", "FINISHED"] },
];

type Act = (a: HostAction) => Promise<unknown>;

export default function Host({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const game = useGame(code, "host");
  const { payload, status, error } = game;
  const [pending, setPending] = useState(false);
  const act: Act = async (a) => {
    setPending(true);
    await game.hostAction(a);
    setPending(false);
  };

  if (status === "no-session") {
    return (
      <div className="wrap">
        <div className="panel">
          <h2>This screen isn't the host of room {code}</h2>
          <p className="muted">{error ?? "The host session was created in a different browser."}</p>
          <Link className="btn primary" href="/">Host a new game</Link>
        </div>
      </div>
    );
  }
  if (!payload || payload.role !== "host") return <div className="wrap muted">Connecting…</div>;
  const view = payload.view;
  const stepIdx = STEPS.findIndex((s) => s.phases.includes(view.phase));
  const busy = pending || view.busy;

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">AI <span>Detective</span></div>
        <div className="steps">
          {STEPS.map((s, i) => <span key={s.label} className={`step ${i === stepIdx ? "on" : i < stepIdx ? "done" : ""}`}>{s.label}</span>)}
        </div>
        <div className="row">
          <span className="room" style={{ fontWeight: 800, letterSpacing: "0.12em", color: "var(--accent)" }}>{view.code}</span>
          <VoiceBadge mode={view.voiceMode} />
          <span className={`badge ${view.llmProvider === "nebius" ? "live" : "mock"}`}>{view.llmProvider === "nebius" ? "Nebius live" : "MOCK detective"}</span>
          {status === "offline" && <span className="badge mock">Reconnecting…</span>}
        </div>
      </div>
      {view.llmProvider === "mock" && <MockBanner />}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {view.error && <div className="notice small" style={{ marginBottom: 12 }}>A detective model call had a problem, so a fallback was used: {view.error}</div>}

      {view.phase === "LOBBY" && <Lobby view={view} act={act} busy={busy} />}
      {view.phase === "ROLE_REVEAL" && <RoleReveal view={view} act={act} busy={busy} />}
      {view.phase === "ALIBI_ENTRY" && <Alibis view={view} act={act} busy={busy} />}
      {(view.phase === "INTERROGATION" || view.phase === "ROUND_ANALYSIS") && <Interrogation view={view} act={act} busy={busy} clockOffset={game.clockOffset} />}
      {view.phase === "ACCUSATION" && <Accusation view={view} act={act} busy={busy} />}
      {(view.phase === "REVEAL" || view.phase === "FINISHED") && view.reveal && (
        <>
          <Reveal view={view} reveal={view.reveal} />
          <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
            {view.phase === "REVEAL" ? <button className="primary" onClick={() => act({ type: "finish" })}>Finish game</button> : <Link className="btn primary" href="/">Host a new game</Link>}
          </div>
        </>
      )}
      {payload.debug ? <details className="panel" style={{ marginTop: 14 }}><summary>DEBUG_HOST: raw game state (never show players)</summary><pre className="small" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(payload.debug, null, 1).slice(0, 20000)}</pre></details> : null}
    </div>
  );
}

function MockBanner() {
  return (
    <div className="mock-banner" role="alert">
      <b>MOCK DETECTIVE: this is NOT Nebius.</b> Questions and rulings are canned heuristics. Set NEBIUS_API_KEY, restart, and run <code>npm run preflight</code> before demoing.
    </div>
  );
}

function VoiceBadge({ mode }: { mode: PublicView["voiceMode"] }) {
  const map = {
    agent: ["live", "Voice: ElevenLabs agent", "Players speak to a live ElevenLabs Conversational AI session."],
    "stt-tts": ["mock", "Voice: fallback (recorder + TTS)", "No conversational agent: phones record, the server transcribes, this screen speaks. Set ELEVENLABS_AGENT_ID for the real thing."],
    text: ["mock", "Voice: OFF (typing)", "ElevenLabs is not configured or the key was rejected. See the server log."],
  } as const;
  const [cls, label, tip] = map[mode];
  return <span className={`badge ${cls}`} title={tip}>{label}</span>;
}

const nameOf = (view: PublicView, id?: string | null) => {
  const p = view.players.find((x) => x.id === id);
  return p ? p.characterName ?? p.name : "";
};

function CasePanel({ view, compact }: { view: PublicView; compact?: boolean }) {
  if (!view.case) return null;
  return (
    <div className="panel">
      <div className="tiny">{view.case.setting}</div>
      <h2 style={{ marginTop: 4 }}>{view.case.title}</h2>
      {!compact && <p className="small">{view.case.description}</p>}
      <div className="tiny" style={{ marginTop: 10 }}>Public evidence</div>
      {view.evidence.map((e) => <div key={e.id} className="evidence-item small"><b>{e.id}. {e.title}</b><span className="muted">{e.text}</span></div>)}
    </div>
  );
}

function PlayerChips({ view, show }: { view: PublicView; show: (p: PublicView["players"][number]) => string | null }) {
  return (
    <div className="pill-list">
      {view.players.map((p) => (
        <span key={p.id} className="pill"><span className={`dot ${p.connected ? "on" : "off"}`} />{p.name}{p.characterName ? <span className="muted"> · {p.characterName}</span> : null}{show(p) && <b> {show(p)}</b>}</span>
      ))}
    </div>
  );
}

function Lobby({ view, act, busy }: { view: PublicView; act: Act; busy: boolean }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);
  const base = view.publicUrl ?? origin;
  const joinUrl = `${base}/join?code=${view.code}`;
  const insecure = base.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(base);
  const localOnly = /localhost|127\.0\.0\.1/.test(base);
  const isHttps = base.startsWith("https://");
  const s = view.settings;
  const patch = (p: Partial<typeof s>) => act({ type: "settings", patch: p });
  const n = view.players.length;
  const canStart = !!view.case && n >= view.minPlayers && n <= view.maxPlayers;
  return (
    <div className="split">
      <div className="stack">
        <div className="panel row" style={{ gap: 24, alignItems: "center" }}>
          <JoinQr url={joinUrl} />
          <div>
            <div className="tiny">Room code</div>
            <div className="room-code">{view.code}</div>
            <div className="small muted" style={{ marginTop: 8 }}>Scan, or open <b>{base || "…"}/join</b></div>
            {localOnly && <div className="error small" style={{ marginTop: 8 }}><b>Phones can't use this address.</b> You opened the host page on localhost, so the QR code points at localhost. Start the tunnel (<code>npm run tunnel</code>) and open the https tunnel URL on this laptop instead, or set PUBLIC_URL.</div>}
            {insecure && <div className="error small" style={{ marginTop: 8 }}><b>This is plain http.</b> Phone microphones only work over https. Use the https tunnel URL.</div>}
            {isHttps && <div className="small muted" style={{ marginTop: 8 }}>✓ https: phone microphones will work.</div>}
          </div>
        </div>
        <div className="panel">
          <h2>Players ({n}/{view.maxPlayers})</h2>
          {n === 0 && <p className="muted">Waiting for players to join…</p>}
          {view.players.map((p) => (
            <div key={p.id} className="player-row">
              <span className={`dot ${p.connected ? "on" : "off"}`} />
              <span className="name">{p.name}</span>
              <div className="spacer" />
              <button className="danger small" onClick={() => act({ type: "kick", playerId: p.id })}>Remove</button>
            </div>
          ))}
          <p className="small muted">{view.minPlayers} to {view.maxPlayers} players. One of them will secretly be the culprit.</p>
        </div>
      </div>
      <div className="stack">
        <div className="panel">
          <h2>Choose a case</h2>
          <div className="stack" style={{ gap: 8 }}>
            {view.cases.map((c) => (
              <div key={c.id} className={`panel case-option ${view.case?.id === c.id ? "selected" : ""}`} style={{ margin: 0 }} onClick={() => act({ type: "selectCase", caseId: c.id })}>
                <b>{c.title}</b>
                <div className="small muted">{c.description}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h3>Settings</h3>
          <div className="grid" style={{ gap: 10 }}>
            <label className="row small">Rounds: <b>{s.rounds}</b><input type="range" min={1} max={5} value={s.rounds} onChange={(e) => patch({ rounds: Number(e.target.value) })} /></label>
            <label className="row small">Answer time: <b>{s.answerSeconds}s</b><input type="range" min={15} max={90} step={5} value={s.answerSeconds} onChange={(e) => patch({ answerSeconds: Number(e.target.value) })} /></label>
            <label className="row small">
              <input type="checkbox" checked={s.maxQuestions !== null} onChange={(e) => patch({ maxQuestions: e.target.checked ? Math.max(3, n * s.rounds) : null })} />
              Cap total questions{s.maxQuestions !== null && <>: <b>{s.maxQuestions}</b><input type="range" min={3} max={40} value={s.maxQuestions} onChange={(e) => patch({ maxQuestions: Number(e.target.value) })} /></>}
            </label>
            <label className="row small"><input type="checkbox" checked={s.allowEarlyEnd} onChange={(e) => patch({ allowEarlyEnd: e.target.checked })} />Let the detective accuse early if it's confident</label>
          </div>
          <button className="primary btn-xl" style={{ marginTop: 14 }} disabled={busy || !canStart} onClick={() => act({ type: "start" })}>
            {!view.case ? "Pick a case to start" : n < view.minPlayers ? `Need ${view.minPlayers - n} more player(s)` : "Start: deal secret characters"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleReveal({ view, act, busy }: { view: PublicView; act: Act; busy: boolean }) {
  const ready = view.players.filter((p) => p.ready).length;
  return (
    <div className="split">
      <div className="panel" style={{ textAlign: "center", padding: 32 }}>
        <h1>Check your phones</h1>
        <p className="muted">Everyone has a secret character. One of you is the culprit. Read your card, then tap Ready.</p>
        <div className="big-stat">{ready} / {view.players.length}</div>
        <div className="muted">ready</div>
        <div style={{ marginTop: 16 }}><PlayerChips view={view} show={(p) => (p.ready ? "✓" : null)} /></div>
        <button style={{ marginTop: 20 }} disabled={busy} onClick={() => act({ type: "openAlibis" })}>Continue without waiting</button>
      </div>
      <CasePanel view={view} />
    </div>
  );
}

function Alibis({ view, act, busy }: { view: PublicView; act: Act; busy: boolean }) {
  const locked = view.players.filter((p) => p.alibiLocked).length;
  const all = locked === view.players.length;
  return (
    <div className="split">
      <div className="panel" style={{ textAlign: "center", padding: 32 }}>
        <h1>Write your alibis</h1>
        <p className="muted">On your phone: where were you, when, and with whom? Once submitted it's locked, and the detective will hold you to it.</p>
        <div className="big-stat">{locked} / {view.players.length}</div>
        <div className="muted">alibis locked</div>
        <div style={{ marginTop: 16 }}><PlayerChips view={view} show={(p) => (p.alibiLocked ? "✓" : null)} /></div>
        <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
          <button className="primary btn-xl" style={{ maxWidth: 360 }} disabled={busy || !all} onClick={() => act({ type: "begin" })}>
            {busy ? <span className="thinking">The detective is reading the alibis…</span> : "Begin interrogation"}
          </button>
        </div>
        {!all && <button className="linkish" disabled={busy} onClick={() => act({ type: "devFillAlibis" })}>Dev: fill placeholder alibis</button>}
      </div>
      <CasePanel view={view} />
    </div>
  );
}

/**
 * Plays detective speech on the shared screen with ElevenLabs text-to-speech. Browsers need one click first to allow audio.
 * In agent mode the player's phone speaks each question through the agent, so this screen only speaks the accusation.
 */
function useDetectiveVoice(view: PublicView) {
  const [on, setOn] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const spoken = useRef<string | null>(null);
  const say = async (kind: "question" | "accusation", key: string) => {
    if (!on || view.voiceMode === "text" || spoken.current === key) return;
    if (kind === "question" && view.voiceMode === "agent") return;
    spoken.current = key;
    const res = await emitAck<{ audio: ArrayBuffer; mimeType: string }>(EVENTS.tts, { kind }, 30_000);
    if (!res.ok) return;
    audio.current?.pause();
    audio.current = new Audio(URL.createObjectURL(new Blob([res.audio], { type: res.mimeType })));
    audio.current.play().catch(() => {});
  };
  return { on, setOn, say, available: view.voiceMode !== "text" };
}

function VoiceToggle({ voice }: { voice: ReturnType<typeof useDetectiveVoice> }) {
  if (!voice.available) return null;
  return <button onClick={() => voice.setOn(!voice.on)}>{voice.on ? "🔊 Detective voice on" : "🔈 Turn on detective voice (accusation)"}</button>;
}

function Interrogation({ view, act, busy, clockOffset }: { view: PublicView; act: Act; busy: boolean; clockOffset: number }) {
  const q = view.current;
  const left = useCountdown(q?.deadline, clockOffset);
  const voice = useDetectiveVoice(view);
  const analyzing = view.phase === "ROUND_ANALYSIS" || !q;
  const target = q ? view.players.find((p) => p.id === q.targetPlayerId) : null;
  useEffect(() => {
    if (q) voice.say("question", `q:${q.askedAt}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.askedAt, voice.on]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollTo, and an effect must not return one.
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [view.transcript.length]);

  return (
    <div className="split">
      <div className="stack">
        <div className="panel row">
          <div>
            <div className="tiny">Round</div>
            <div className="budget">{Math.max(1, view.round)}<span className="muted" style={{ fontSize: 24 }}> / {view.settings.rounds}</span></div>
          </div>
          <div className="spacer" />
          <div className="stack" style={{ alignItems: "flex-end", gap: 8 }}>
            <span className="small muted">Questions {view.questionsAsked} of {view.maxQuestions}</span>
            <VoiceToggle voice={voice} />
          </div>
        </div>
        <div className="panel" style={{ minHeight: 260 }}>
          {analyzing ? (
            <div style={{ textAlign: "center", padding: 40 }}>
              <div className="host-q thinking">The detective is reviewing the testimony…</div>
              <p className="muted">Comparing every answer against the alibis, the evidence, and each other.</p>
            </div>
          ) : (
            <>
              <div className="row">
                <div>
                  <div className="tiny">Now questioning</div>
                  <div className="speaker">{target?.characterName ?? target?.name}</div>
                  {target?.characterName && <div className="muted">{target.name}</div>}
                </div>
                <div className="spacer" />
                <Timer seconds={left} total={view.settings.answerSeconds} />
              </div>
              <div className="host-q">“{q!.text}”</div>
              <div className="row">
                <span className="small muted">{target?.name}, answer on your phone.</span>
                <div className="spacer" />
                {left === 0 && <button disabled={busy} onClick={() => act({ type: "skipAnswer" })}>Move on (no answer)</button>}
                <button className="danger" disabled={busy} onClick={() => act({ type: "endNow" })}>End investigation now</button>
              </div>
            </>
          )}
        </div>
        <div className="panel">
          <h3>Transcript</h3>
          <div className="transcript" ref={transcriptRef}>
            {view.transcript.length === 0 && <div className="small muted">No answers yet.</div>}
            {view.transcript.map((t) => (
              <div key={t.id} className="line small">
                <div className="q">Round {t.round} · Detective → {nameOf(view, t.playerId)}: {t.question}</div>
                <div><span className="who">{nameOf(view, t.playerId)}:</span> {t.answer}{t.timedOut && <span className="muted"> (out of time)</span>}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <CasePanel view={view} compact />
    </div>
  );
}

function Accusation({ view, act, busy }: { view: PublicView; act: Act; busy: boolean }) {
  const a = view.accusation;
  const voice = useDetectiveVoice(view);
  useEffect(() => {
    voice.say("accusation", "accusation");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.on]);
  const why = { rounds: "All rounds complete.", budget: "Question limit reached.", early: "The detective was confident enough to stop early.", host: "The host ended the investigation." };
  const accused = view.players.find((p) => p.id === a?.accusedPlayerId);
  return (
    <div className="panel" style={{ textAlign: "center", padding: "40px 24px" }}>
      <div className="tiny">{view.endReason ? why[view.endReason] : ""} The detective accuses</div>
      <div className="accuse-name">{accused?.characterName ?? accused?.name}</div>
      {accused?.characterName && <div className="muted">played by {accused.name}</div>}
      <p className="ruling-line" style={{ maxWidth: 780, margin: "20px auto" }}>“{a?.reasoning}”</p>
      <div className="row" style={{ justifyContent: "center", marginBottom: 20 }}>{a?.keyPoints.map((k, i) => <span key={i} className="badge">{k}</span>)}</div>
      <div className="row" style={{ justifyContent: "center" }}>
        <VoiceToggle voice={voice} />
        <button className="primary btn-xl" style={{ maxWidth: 320 }} disabled={busy} onClick={() => act({ type: "reveal" })}>
          {busy ? <span className="thinking">Preparing the reveal…</span> : "Reveal the truth"}
        </button>
      </div>
    </div>
  );
}
