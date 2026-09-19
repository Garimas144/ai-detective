"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCountdown } from "@/components/useCountdown";
import type { AgentResult } from "@/components/AgentTurn";
import { explainMicError, micSupport } from "@/components/mic";
import { useRecorder } from "@/components/useRecorder";
import { emitAck, useGame } from "@/lib/client/useGame";
import { EVENTS, type PlayerPrivate, type PublicView } from "@/lib/protocol";
import type { CaseCharacter } from "@/lib/types";

export default function Play({ params }: { params: { code: string } }) {
  const code = params.code.toUpperCase();
  const game = useGame(code, "player");
  const { payload, status, error } = game;

  if (status === "no-session" || status === "kicked") {
    return (
      <div className="mobile stack">
        <Head code={code} status={status} />
        <div className="panel">{status === "kicked" ? "The host removed you from this game." : error ?? "You haven't joined this game on this device."}</div>
        <Link className="btn btn-xl primary" style={{ textAlign: "center", lineHeight: "40px" }} href={`/join?code=${code}`}>Join room {code}</Link>
      </div>
    );
  }
  if (!payload || payload.role !== "player") return <div className="mobile"><Head code={code} status={status} /><p className="muted">Connecting…</p></div>;

  const { view, me } = payload;
  return (
    <div className="mobile">
      <Head code={code} status={status} name={me.name} />
      {view.llmProvider === "mock" && <div className="mock-banner small" role="alert"><b>MOCK detective</b>: not Nebius.</div>}
      {status === "offline" && <div className="notice small" style={{ marginBottom: 12 }}>Connection lost. Reconnecting… you'll pick up right where you left off.</div>}
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <PhaseScreen view={view} me={me} game={game} />
    </div>
  );
}

type Game = ReturnType<typeof useGame>;

function Head({ code, status, name }: { code: string; status: string; name?: string }) {
  return (
    <div className="mobile-head">
      <span className={`dot ${status === "live" ? "on" : status === "offline" ? "off" : ""}`} title={status} />
      <span className="room">{code}</span>
      <div className="spacer" />
      {name && <b>{name}</b>}
      {status === "offline" && <span className="small muted">reconnecting…</span>}
    </div>
  );
}

function PhaseScreen({ view, me, game }: { view: PublicView; me: PlayerPrivate; game: Game }) {
  switch (view.phase) {
    case "LOBBY":
      return (
        <div className="stack">
          <h1>You're in.</h1>
          <p className="muted">Waiting for the host to start. {view.players.length} of {view.minPlayers}–{view.maxPlayers} players.</p>
          <div className="pill-list">{view.players.map((p) => <span key={p.id} className="pill"><span className={`dot ${p.connected ? "on" : ""}`} />{p.name}</span>)}</div>
          {view.case && <CaseBrief view={view} />}
        </div>
      );
    case "ROLE_REVEAL":
      return (
        <>
          {me.card && <RoleCard card={me.card} />}
          <div className="action-bar">
            {view.players.find((p) => p.id === me.id)?.ready ? (
              <div className="panel" style={{ textAlign: "center" }}>Ready. Waiting for the others…</div>
            ) : (
              <button className="btn-xl primary" onClick={() => game.playerAction({ type: "ready" })}>I've read my character</button>
            )}
          </div>
        </>
      );
    case "ALIBI_ENTRY":
      return <AlibiEntry view={view} me={me} game={game} />;
    case "INTERROGATION":
      return me.isMyTurn && view.current ? <MyTurn key={view.current.askedAt} view={view} game={game} /> : <Watching view={view} me={me} />;
    case "ROUND_ANALYSIS":
      return (
        <div className="stack">
          <div className="panel thinking" style={{ fontSize: 20, textAlign: "center", padding: 28 }}>The detective is reviewing the testimony…</div>
          {me.card && <RoleDrawer card={me.card} alibi={me.alibi} />}
        </div>
      );
    case "ACCUSATION":
      return (
        <div className="stack" style={{ textAlign: "center" }}>
          <div className="tiny">The detective accuses</div>
          <div className="role-name" style={{ color: "var(--guilty)" }}>{nameOf(view, view.accusation?.accusedPlayerId)}</div>
          <p className="muted">{view.accusation?.accusedPlayerId === me.id ? "That's you." : "Watch the main screen for the reveal."}</p>
        </div>
      );
    case "REVEAL":
    case "FINISHED":
      return <MyResult view={view} me={me} />;
  }
}

const nameOf = (view: PublicView, id?: string | null) => {
  const p = view.players.find((x) => x.id === id);
  return p ? p.characterName ?? p.name : "";
};

function CaseBrief({ view }: { view: PublicView }) {
  if (!view.case) return null;
  return (
    <div className="panel">
      <div className="tiny">{view.case.setting}</div>
      <h2 style={{ margin: "4px 0" }}>{view.case.title}</h2>
      <p className="small" style={{ margin: 0 }}>{view.case.description}</p>
    </div>
  );
}

function Evidence({ view }: { view: PublicView }) {
  return (
    <details className="panel">
      <summary>Public evidence ({view.evidence.length})</summary>
      {view.evidence.map((e) => <div key={e.id} className="evidence-item small"><b>{e.id}. {e.title}</b><span className="muted">{e.text}</span></div>)}
    </details>
  );
}

function RoleCard({ card }: { card: CaseCharacter }) {
  return (
    <div className="stack">
      <div className="tiny" style={{ textAlign: "center" }}>Your secret character. Don't show anyone.</div>
      {card.culprit ? <div className="culprit-banner" style={{ fontSize: 20 }}>YOU ARE THE CULPRIT</div> : <div className="innocent-banner" style={{ fontSize: 20 }}>YOU ARE INNOCENT</div>}
      <div>
        <div className="role-name">{card.name}</div>
        <div className="muted">{card.blurb}</div>
      </div>
      <p className="small" style={{ margin: 0 }}>
        {card.culprit
          ? "You did it. Invent your own story, stay consistent with your alibi, and get the detective to accuse someone else."
          : "You didn't do it. Convince the detective. If you're accused, you lose. You may still want to hide your secret."}
      </p>
      <CardDetails card={card} />
    </div>
  );
}

function CardDetails({ card }: { card: CaseCharacter }) {
  const rows: [string, string | null][] = [
    ["Background", card.background],
    ["Relationships", card.relationship],
    ["Why you're here", card.reasonPresent],
    ["Your possible motive", card.motive],
    ["What looks suspicious", card.suspicious],
    ["Your secret", card.secret],
  ];
  return (
    <div className="panel stack" style={{ gap: 10 }}>
      {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><div className="tiny">{k}</div><div>{v}</div></div>)}
      <div><div className="tiny">What you saw or know</div><ul className="fact-list" style={{ paddingLeft: 18, margin: "4px 0 0" }}>{card.knows.map((k, i) => <li key={i}>{k}</li>)}</ul></div>
      {card.whatYouDid && <div><div className="tiny">What you actually did</div><ul className="fact-list" style={{ paddingLeft: 18, margin: "4px 0 0" }}>{card.whatYouDid.map((k, i) => <li key={i}>{k}</li>)}</ul></div>}
      {card.looseEnds && <div><div className="tiny">Loose ends that could expose you</div><ul className="fact-list" style={{ paddingLeft: 18, margin: "4px 0 0" }}>{card.looseEnds.map((k, i) => <li key={i}>{k}</li>)}</ul></div>}
    </div>
  );
}

function RoleDrawer({ card, alibi }: { card: CaseCharacter; alibi: string | null }) {
  return (
    <details className="panel">
      <summary>My character: {card.name}</summary>
      <div style={{ marginTop: 10 }}>
        {alibi && <p className="quote">Your alibi: “{alibi}”</p>}
        <CardDetails card={card} />
      </div>
    </details>
  );
}

function AlibiEntry({ view, me, game }: { view: PublicView; me: PlayerPrivate; game: Game }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const locked = view.players.filter((p) => p.alibiLocked).length;
  if (me.alibi) {
    return (
      <div className="stack">
        <h2>Alibi locked</h2>
        <p className="quote" style={{ fontSize: 17 }}>“{me.alibi}”</p>
        <p className="muted">It can't be changed. The detective will hold you to it. Waiting for the others ({locked}/{view.players.length}).</p>
        {me.card && <RoleDrawer card={me.card} alibi={null} />}
      </div>
    );
  }
  const submit = async () => {
    setSending(true);
    await game.playerAction({ type: "alibi", text });
    setSending(false);
  };
  return (
    <>
      <div className="stack">
        <h2 style={{ marginBottom: 0 }}>Write your alibi</h2>
        <p className="small muted" style={{ margin: 0 }}>Where were you, when, and with whom? Once you submit it's locked, and the detective will compare everything you say against it.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="From 21:00 I was in the drawing room playing cards with…" />
        {me.card && <RoleDrawer card={me.card} alibi={null} />}
        <Evidence view={view} />
      </div>
      <div className="action-bar">
        <button className="btn-xl primary" disabled={sending || text.trim().length < 10} onClick={submit}>{sending ? "Locking in…" : "Lock in my alibi"}</button>
      </div>
    </>
  );
}

function Watching({ view, me }: { view: PublicView; me: PlayerPrivate }) {
  const q = view.current;
  return (
    <div className="stack">
      <div className="tiny">Round {view.round} of {view.settings.rounds}</div>
      {q ? (
        <div className="panel">
          <div className="tiny">Now questioning</div>
          <div className="role-name" style={{ fontSize: 26 }}>{nameOf(view, q.targetPlayerId)}</div>
          <p className="small" style={{ marginBottom: 0 }}>“{q.text}”</p>
        </div>
      ) : (
        <div className="panel thinking">The detective is thinking…</div>
      )}
      <p className="small muted" style={{ textAlign: "center" }}>Listen to the main screen. Your phone will buzz when it's your turn.</p>
      {me.card && <RoleDrawer card={me.card} alibi={me.alibi} />}
    </div>
  );
}

const MicIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" /></svg>
);

// The ElevenLabs SDK touches browser-only APIs, so it is only loaded in the browser and only when needed.
const AgentTurn = dynamic(() => import("@/components/AgentTurn"), { ssr: false, loading: () => <p className="muted">Loading voice…</p> });

type AnswerMode = "agent" | "recorder" | "text";

function MyTurn({ view, game }: { view: PublicView; game: Game }) {
  const q = view.current!;
  const left = useCountdown(q.deadline, game.clockOffset);
  const mic = micSupport();
  // Best available mode first: real conversational agent, then recorder + server transcription, then typing.
  const initial: AnswerMode = view.voiceMode === "agent" && mic.ok ? "agent" : view.voiceMode !== "text" && mic.ok ? "recorder" : "text";
  const [mode, setMode] = useState<AnswerMode>(initial);
  const [notice, setNotice] = useState<string | null>(view.voiceMode !== "text" && !mic.ok ? mic.message : null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const sent = useRef(false);
  const rec = useRecorder();

  useEffect(() => {
    if ("vibrate" in navigator) navigator.vibrate?.(200);
  }, []);

  /** Sends the answer exactly once, whichever mode produced it. */
  const submit = useCallback(
    async (run: () => Promise<{ ok: true; transcript?: string } | { ok: false; error: string }>) => {
      if (sent.current) return;
      sent.current = true;
      setSending(true);
      const res = await run();
      if (res.ok) setHeard(res.transcript ?? null);
      else {
        game.setError(res.error);
        sent.current = false;
      }
      setSending(false);
    },
    [game],
  );

  const sendText = (timedOut: boolean) => submit(async () => ({ ...(await game.playerAction({ type: "answer", text, timedOut })) }) as never);

  const sendAgent = useCallback(
    (result: AgentResult, timedOut: boolean) =>
      submit(async () => (await emitAck<{ transcript: string }>(EVENTS.agentAnswer, { conversationId: result.conversationId, segments: result.segments, timedOut })) as never),
    [submit],
  );

  const sendRecording = (timedOut: boolean) =>
    submit(async () => {
      const out = await rec.stop();
      if (!out) return { ok: false as const, error: "Nothing was recorded." };
      return (await emitAck<{ transcript: string }>(EVENTS.voiceAnswer, { audio: await out.blob.arrayBuffer(), mimeType: out.mimeType, timedOut })) as never;
    });

  // Recorder / text modes: when the clock hits zero, send what we have. (Agent mode handles its own clock.)
  useEffect(() => {
    if (left !== 0 || sent.current) return;
    if (mode === "recorder" && rec.recording) sendRecording(true);
    else if (mode === "text" && text.trim()) sendText(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const fallBack = useCallback(
    (message: string) => {
      // If the microphone itself is the problem, the recorder can't help either: go straight to typing.
      const micProblem = explainMicError(message) !== "" || /microphone|https|secure/i.test(message);
      const next: AnswerMode = mode === "agent" && mic.ok && !micProblem && view.voiceMode !== "text" ? "recorder" : "text";
      setNotice(`${message} ${next === "recorder" ? "Switching to the simple recorder." : "You can type your answer instead."}`);
      setMode(next);
    },
    [mic.ok, mode, view.voiceMode],
  );

  const toggleMic = async () => {
    if (rec.recording) return sendRecording(false);
    try {
      await rec.start();
    } catch (err) {
      setNotice(`${explainMicError(err) || "Couldn't use the microphone."} You can type your answer instead.`);
      setMode("text");
    }
  };

  const modeLabel = mode === "agent" ? "Live voice" : mode === "recorder" ? "Voice (recorder)" : "Typing";
  const working = sending || heard !== null;

  return (
    <>
      <div className="stack">
        <div className="turn-banner">YOUR TURN</div>
        <div className={`huge-timer ${left !== null && left <= 10 ? "low" : ""}`}>{left ?? ""}</div>
        <div className="hero-q">“{q.text}”</div>
        {notice && <div className="notice small">{notice}</div>}
        {sending && <div className="panel thinking" style={{ textAlign: "center" }}>Sending your answer…</div>}
        {heard !== null && <p className="small muted">The detective heard: “{heard || "(nothing)"}”</p>}

        {!working && mode === "agent" && <AgentTurn secondsLeft={left} onDone={sendAgent} onFail={fallBack} />}

        {!working && mode === "recorder" && (
          <button className={`mic ${rec.recording ? "rec" : ""}`} onClick={toggleMic}>
            <MicIcon />
            {rec.recording ? "Tap to finish" : "Tap to answer"}
          </button>
        )}

        {!working && mode === "text" && (
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer, in character" />
        )}

        {!working && (
          <div className="row" style={{ justifyContent: "center", gap: 4 }}>
            <span className="tiny">{modeLabel}</span>
            {mode !== "text" && <button className="linkish" onClick={() => setMode("text")}>Type instead</button>}
            {mode === "text" && view.voiceMode !== "text" && mic.ok && <button className="linkish" onClick={() => setMode(view.voiceMode === "agent" ? "agent" : "recorder")}>Speak instead</button>}
          </div>
        )}
      </div>
      {mode === "text" && !working && (
        <div className="action-bar">
          <button className="btn-xl primary" disabled={!text.trim()} onClick={() => sendText(false)}>Send answer</button>
        </div>
      )}
    </>
  );
}

function MyResult({ view, me }: { view: PublicView; me: PlayerPrivate }) {
  const r = me.result;
  const culprit = view.reveal ? nameOf(view, view.reveal.culpritPlayerId) : "";
  if (!r) return <p className="muted">Revealing…</p>;
  return (
    <div className="stack" style={{ textAlign: "center" }}>
      <div className="big-stat" style={{ color: r.outcome === "win" ? "var(--innocent)" : "var(--guilty)", marginTop: 20 }}>YOU {r.outcome === "win" ? "WIN" : "LOSE"}</div>
      <p className="muted" style={{ fontSize: 18 }}>
        {r.culprit && !r.accused && "You got away with it."}
        {r.culprit && r.accused && "The detective caught you."}
        {!r.culprit && r.accused && "You were wrongly accused."}
        {!r.culprit && !r.accused && "The detective believed you."}
      </p>
      <div className="panel">
        <div className="tiny">The culprit was</div>
        <div className="role-name" style={{ fontSize: 26 }}>{culprit}</div>
      </div>
      <p className="small muted">The full story is on the main screen.</p>
      {view.phase === "FINISHED" && <Link className="btn btn-xl" style={{ lineHeight: "40px" }} href="/join">Join another game</Link>}
    </div>
  );
}
