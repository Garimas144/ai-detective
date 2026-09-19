"use client";

// One player's spoken turn through an ElevenLabs Conversational AI (Agents) session, over WebRTC.
//
// The game server decides the question and issues a single-use conversation token for THIS player and THIS
// question. The agent speaks that one question and then only acknowledges ("Mm-hm."). Everything the player
// says is captured as a user transcript and sent back to the game server, which stores it as testimony.
// The ElevenLabs API key never reaches this component: it only ever holds the short-lived token.

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { emitAck } from "@/lib/client/useGame";
import { EVENTS } from "@/lib/protocol";
import { explainMicError, micSupport } from "./mic";

export interface AgentResult {
  conversationId?: string;
  segments: string[];
}

interface Props {
  secondsLeft: number | null;
  /** Called once with everything the player said. */
  onDone: (result: AgentResult, timedOut: boolean) => void;
  /** Called when a session can't be used at all (no speech captured), so the parent can fall back. */
  onFail: (message: string) => void;
}

const SETTLE_MS = 1400; // let the last recognized words arrive before closing the session

export default function AgentTurn(props: Props) {
  return (
    <ConversationProvider>
      <Inner {...props} />
    </ConversationProvider>
  );
}

function Inner({ secondsLeft, onDone, onFail }: Props) {
  const segments = useRef<string[]>([]);
  const conversationId = useRef<string | undefined>();
  const finished = useRef(false);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "finishing">("idle");
  const [heard, setHeard] = useState<string[]>([]);

  const finish = useCallback(
    (timedOut: boolean) => {
      if (finished.current) return;
      finished.current = true;
      setPhase("finishing");
      onDone({ conversationId: conversationId.current, segments: [...segments.current] }, timedOut);
    },
    [onDone],
  );

  const fail = useCallback(
    (message: string) => {
      if (finished.current) return;
      // If the player already spoke, keep their words instead of throwing the turn away.
      if (segments.current.length) return finish(false);
      finished.current = true;
      onFail(message);
    },
    [finish, onFail],
  );

  const conversation = useConversation({
    onConnect: ({ conversationId: id }) => {
      conversationId.current = id;
      setPhase("live");
    },
    onMessage: (m) => {
      // Only the player's own recognized speech counts as testimony. The agent's replies are ignored.
      if (m.role === "user" && m.message.trim()) {
        segments.current.push(m.message.trim());
        setHeard([...segments.current]);
      }
    },
    onError: (message) => fail(explainMicError(message) || `Voice connection problem: ${message}`),
    onDisconnect: (details) => {
      if (finished.current) return;
      if (details.reason === "error") fail(explainMicError(details.message) || `Voice connection lost: ${details.message}`);
      else finish(false); // the agent or the player ended the call
    },
  });

  const start = async () => {
    const support = micSupport();
    if (!support.ok) return onFail(support.message);
    setPhase("starting");
    const res = await emitAck<{ token: string; conversationId?: string; question: string }>(EVENTS.agentToken, {}, 20_000);
    if (!res.ok) {
      setPhase("idle");
      return onFail(res.error);
    }
    conversationId.current = res.conversationId;
    try {
      // The tap is a real user gesture, which iOS Safari requires for the microphone. The agent stays silent until you speak.
      conversation.startSession({ conversationToken: res.token, connectionType: "webrtc", dynamicVariables: { question: res.question } });
    } catch (err) {
      onFail(explainMicError(err) || (err instanceof Error ? err.message : "Couldn't start the voice session."));
    }
  };

  const done = (timedOut: boolean) => {
    setPhase("finishing");
    setTimeout(() => {
      try {
        conversation.endSession();
      } catch {}
      finish(timedOut);
    }, SETTLE_MS);
  };

  // Time limit: stop listening and send whatever was said.
  const timeUp = useRef(false);
  useEffect(() => {
    if (secondsLeft === 0 && !timeUp.current && !finished.current) {
      timeUp.current = true;
      if (phase === "idle") {
        finished.current = true;
        onDone({ segments: [] }, true);
      } else done(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  // Leaving the screen ends the session so the mic is released.
  useEffect(
    () => () => {
      try {
        conversation.endSession();
      } catch {}
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const speaking = conversation.isSpeaking;
  const label = phase === "idle" ? "Tap to answer" : phase === "starting" ? "Connecting…" : phase === "finishing" ? "Sending…" : speaking ? "Mm-hm…" : "Speak now";

  return (
    <div className="stack">
      <button
        className={`mic ${phase === "live" && !speaking ? "rec" : ""}`}
        disabled={phase === "starting" || phase === "finishing" || phase === "live"}
        onClick={start}
        aria-label={label}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
        </svg>
        {label}
      </button>
      {phase === "idle" && <p className="small muted" style={{ textAlign: "center", margin: 0 }}>Listen to the question on the main speaker. Tap the mic only when you are ready to answer.</p>}
      {heard.length > 0 && <p className="quote small" style={{ margin: 0 }}>You said: “{heard.join(" ")}”</p>}
      {phase === "live" && (
        <button className="btn-xl primary" onClick={() => done(false)}>
          I'm done answering
        </button>
      )}
    </div>
  );
}
