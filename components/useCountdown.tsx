"use client";

import { useEffect, useState } from "react";

/** Seconds left until `deadline` (server clock), corrected by the server/client clock offset. */
export function useCountdown(deadline: number | null | undefined, clockOffsetMs: number): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!deadline) return setLeft(null);
    const tick = () => setLeft(Math.max(0, Math.ceil((deadline - (Date.now() + clockOffsetMs)) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [deadline, clockOffsetMs]);
  return left;
}

export function Timer({ seconds, total }: { seconds: number | null; total: number }) {
  if (seconds === null) return null;
  const pct = Math.max(0, Math.min(100, (seconds / total) * 100));
  return (
    <div className="timer">
      <div className={`timer-num ${seconds <= 10 ? "low" : ""}`}>{seconds}s</div>
      <div className="bar"><i style={{ width: `${pct}%`, background: seconds <= 10 ? "var(--guilty)" : "var(--accent)" }} /></div>
    </div>
  );
}
