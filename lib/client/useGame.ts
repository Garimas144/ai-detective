"use client";

// One Socket.IO connection per browser tab. On every (re)connect the saved session token is presented
// again, so refreshing the page restores the same player (and their private card) instead of creating
// a duplicate.

import { useCallback, useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { EVENTS, sessionKey, type Ack, type ClientPayload, type HostAction, type PlayerAction, type SessionInfo } from "../protocol";

let socket: Socket | null = null;
export function getSocket(): Socket {
  if (!socket) socket = io({ transports: ["websocket", "polling"] });
  return socket;
}

/** Emits with an acknowledgement. Detective steps can take a while, so the timeout is generous. */
export function emitAck<T extends object = object>(event: string, payload: unknown, timeoutMs = 180_000): Promise<Ack<T>> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(timeoutMs)
      .emit(event, payload, (err: Error | null, res: Ack<T>) =>
        resolve(err ? { ok: false, error: "No response from the game host. Check your connection." } : res),
      );
  });
}

// Sessions are saved per tab (sessionStorage, so several test players can share one browser) and also
// in localStorage (so a phone that closed the tab can rejoin as the same player).
export function saveSession(s: SessionInfo) {
  const raw = JSON.stringify(s);
  try {
    sessionStorage.setItem(sessionKey(s.code, s.role), raw);
  } catch {}
  try {
    localStorage.setItem(sessionKey(s.code, s.role), raw);
  } catch {}
}
export function loadSession(code: string, role: "host" | "player", opts: { tabOnly?: boolean } = {}): SessionInfo | null {
  const read = (store: Storage) => {
    try {
      const raw = store.getItem(sessionKey(code, role));
      return raw ? (JSON.parse(raw) as SessionInfo) : null;
    } catch {
      return null;
    }
  };
  if (typeof window === "undefined") return null;
  return read(sessionStorage) ?? (opts.tabOnly ? null : read(localStorage));
}
export function clearSession(code: string, role: "host" | "player") {
  for (const store of [sessionStorage, localStorage]) {
    try {
      store.removeItem(sessionKey(code, role));
    } catch {}
  }
}
export type ConnStatus = "connecting" | "live" | "offline" | "no-session" | "kicked";

export function useGame(code: string, role: "host" | "player") {
  const [payload, setPayload] = useState<ClientPayload | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [clockOffset, setClockOffset] = useState(0);

  useEffect(() => {
    const s = getSocket();
    const resume = async () => {
      const saved = loadSession(code, role);
      if (!saved) return setStatus("no-session");
      const res = await emitAck(EVENTS.sessionResume, { code, token: saved.token }, 15_000);
      if (res.ok) {
        setStatus("live");
        setError(null);
      } else {
        if (/not found|no longer exists/i.test(res.error)) clearSession(code, role);
        setError(res.error);
        setStatus("no-session");
      }
    };
    const onState = (p: ClientPayload) => {
      setPayload(p);
      setClockOffset(p.view.serverNow - Date.now());
    };
    const onDisconnect = () => setStatus("offline");
    const onKicked = () => {
      clearSession(code, role);
      setStatus("kicked");
    };
    s.on("connect", resume);
    s.on(EVENTS.state, onState);
    s.on("disconnect", onDisconnect);
    s.on(EVENTS.kicked, onKicked);
    if (s.connected) resume();
    return () => {
      s.off("connect", resume);
      s.off(EVENTS.state, onState);
      s.off("disconnect", onDisconnect);
      s.off(EVENTS.kicked, onKicked);
    };
  }, [code, role]);

  const run = useCallback(async (event: string, action: unknown) => {
    setError(null);
    const res = await emitAck(event, action);
    if (!res.ok) setError(res.error);
    return res;
  }, []);

  return {
    payload,
    status,
    error,
    setError,
    clockOffset,
    hostAction: (a: HostAction) => run(EVENTS.hostAction, a),
    playerAction: (a: PlayerAction) => run(EVENTS.playerAction, a),
  };
}
