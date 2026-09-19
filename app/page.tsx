"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { emitAck, saveSession } from "@/lib/client/useGame";
import { EVENTS } from "@/lib/protocol";

export default function Landing() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = async () => {
    setBusy(true);
    setError(null);
    const res = await emitAck<{ code: string; token: string }>(EVENTS.hostCreate, {}, 15_000);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    saveSession({ code: res.code, role: "host", token: res.token });
    router.push(`/host/${res.code}`);
  };

  return (
    <div className="mobile" style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <div className="stack" style={{ textAlign: "center" }}>
        <div className="brand" style={{ fontSize: 40 }}>AI <span>Detective</span></div>
        <p className="muted">3 to 8 players. One of you did it. Everyone else has to convince the detective they didn't.</p>
        {error && <div className="error">{error}</div>}
        <button className="btn-xl primary" onClick={() => router.push("/join")}>Join a game</button>
        <button className="btn-xl" disabled={busy} onClick={host}>{busy ? "Creating…" : "Host a game on this screen"}</button>
        <p className="small muted">Host on the laptop or TV everyone can see. Players join on their phones.</p>
      </div>
    </div>
  );
}
