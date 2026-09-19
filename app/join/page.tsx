"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { emitAck, loadSession, saveSession } from "@/lib/client/useGame";
import { EVENTS, type SessionInfo } from "@/lib/protocol";

export default function Join() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SessionInfo | null>(null);

  useEffect(() => {
    const c = new URL(window.location.href).searchParams.get("code")?.toUpperCase() ?? "";
    setCode(c);
    if (!c) return;
    // Already joined in this tab: go straight back in. Joined earlier on this device: offer to rejoin.
    if (loadSession(c, "player", { tabOnly: true })) router.replace(`/play/${c}`);
    else setSaved(loadSession(c, "player"));
  }, [router]);

  const canJoin = code.trim().length >= 4 && name.trim().length > 0 && !busy;
  const join = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canJoin) return;
    setBusy(true);
    setError(null);
    const res = await emitAck<{ code: string; playerId: string; token: string }>(EVENTS.playerJoin, { code, name }, 15_000);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    saveSession({ code: res.code, role: "player", token: res.token, playerId: res.playerId, name: name.trim() });
    router.push(`/play/${res.code}`);
  };

  return (
    <form className="mobile" onSubmit={join}>
      <div className="mobile-head"><div className="brand">AI <span>Detective</span></div></div>
      <div className="stack grow">
        <h1 style={{ marginBottom: 0 }}>Join a game</h1>
        <label className="stack" style={{ gap: 6 }}>
          <span className="tiny">Room code</span>
          <input className="big-input code-input" type="text" inputMode="text" autoCapitalize="characters" autoComplete="off" maxLength={6}
            value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} placeholder="ABCD" />
        </label>
        <label className="stack" style={{ gap: 6 }}>
          <span className="tiny">Your name</span>
          <input className="big-input" type="text" autoComplete="nickname" maxLength={24} value={name}
            onChange={(e) => setName(e.target.value)} enterKeyHint="go" placeholder="e.g. Garima" />
        </label>
        {error && <div className="error">{error}</div>}
        {saved && (
          <button type="button" className="btn-xl" onClick={() => { saveSession(saved); router.push(`/play/${saved.code}`); }}>
            Rejoin room {saved.code}{saved.name ? ` as ${saved.name}` : ""}
          </button>
        )}
      </div>
      <div className="action-bar">
        <button type="submit" className="btn-xl primary" disabled={!canJoin}>{busy ? "Joining…" : "Join"}</button>
      </div>
    </form>
  );
}
