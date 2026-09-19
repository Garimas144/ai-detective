"use client";

import type { PublicView, RevealData } from "@/lib/protocol";
import type { CaseEvidence, SuspicionProfile } from "@/lib/types";

const KIND_LABEL: Record<CaseEvidence["kind"], string> = { key: "key clue", ambiguous: "ambiguous", red_herring: "red herring", odd: "just weird" };

export function Reveal({ view, reveal }: { view: PublicView; reveal: RevealData }) {
  const player = (id: string) => view.players.find((p) => p.id === id)!;
  const cardOf = (id: string) => reveal.characters.find((c) => c.playerId === id)!.card;
  const who = (id: string) => cardOf(id)?.name ?? player(id).name;
  const claimById = new Map(reveal.claims.map((c) => [c.id, c]));
  const accusedId = reveal.accusation.accusedPlayerId;
  const correct = accusedId === reveal.culpritPlayerId;
  const profiles = [...reveal.profiles].sort((a, b) => a.rank - b.rank);

  return (
    <div className="stack">
      <div className="panel" style={{ textAlign: "center", padding: 32 }}>
        <div className="tiny">{reveal.title}</div>
        <div className="tiny" style={{ marginTop: 16 }}>The detective accused {who(accusedId)}. The culprit was</div>
        <div className="accuse-name">{who(reveal.culpritPlayerId)}</div>
        <div className="muted">played by {player(reveal.culpritPlayerId).name}</div>
        <div className="big-stat" style={{ fontSize: 40, marginTop: 18, color: correct ? "var(--innocent)" : "var(--guilty)" }}>
          {correct ? "The detective got it right" : "The detective got it wrong"}
        </div>
      </div>

      <div className="panel">
        <h2>Results</h2>
        {reveal.results.map((r) => (
          <div key={r.playerId} className="player-row">
            <span className="who-chip">{who(r.playerId)} <span>({player(r.playerId).name})</span></span>
            {r.culprit ? <span className="badge culprit">culprit</span> : <span className="badge innocent">innocent</span>}
            {r.accused && <span className="badge accused">accused</span>}
            <span className="small muted">{r.culprit && !r.accused && "Got away with it"}{!r.culprit && r.accused && "Wrongly accused"}</span>
            <div className="spacer" />
            <span className={`badge ${r.outcome}`}>{r.outcome}</span>
          </div>
        ))}
      </div>

      <div className="panel">
        <h2>What really happened</h2>
        <p>{reveal.truth}</p>
        {reveal.analysis?.summary && reveal.analysis.summary !== reveal.truth && <p className="ruling-line">{reveal.analysis.summary}</p>}
      </div>

      <div className="panel">
        <h2>The evidence, explained</h2>
        {reveal.evidence.map((e) => (
          <div key={e.id} className="evidence-item">
            <b>{e.id}. {e.title}<span className={`kind ${e.kind}`}>{KIND_LABEL[e.kind]}</span></b>
            <div className="small muted">{e.text}</div>
            <div className="small" style={{ marginTop: 4 }}>{e.explanation}</div>
          </div>
        ))}
      </div>

      <div className="split">
        <div className="panel">
          <h2>Major lies</h2>
          {!reveal.analysis?.importantLies.length && <div className="small muted">None identified.</div>}
          {reveal.analysis?.importantLies.map((l, i) => (
            <div key={i} className="contradiction" style={{ marginBottom: 8 }}>
              <div className="meta">{who(l.playerId)}</div>
              <div className="quote small">“{l.statement}”</div>
              <div className="small">Truth: {l.truth}</div>
            </div>
          ))}
        </div>
        <div className="panel">
          <h2>Testimony that misled the detective</h2>
          {!reveal.analysis?.misleadingTestimony.length && <div className="small muted">None identified.</div>}
          {reveal.analysis?.misleadingTestimony.map((m, i) => (
            <div key={i} className="contradiction" style={{ marginBottom: 8, borderLeftColor: "var(--warn)" }}>
              <div className="meta">{who(m.playerId)}</div>
              <div className="quote small">“{m.statement}”</div>
              <div className="small">{m.effect}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>Everyone's secret character</h2>
        <div className="grid cols-3">
          {reveal.characters.map(({ playerId, card }) => (
            <div key={playerId} className={`card ${card.culprit ? "guilty" : ""}`}>
              <div className="row"><b>{card.name}</b>{card.culprit && <span className="badge culprit">culprit</span>}</div>
              <div className="small muted">{card.blurb} · played by {player(playerId).name}</div>
              <div className="small" style={{ marginTop: 8 }}><b>Motive:</b> {card.motive}</div>
              <div className="small"><b>Suspicious:</b> {card.suspicious}</div>
              {card.secret && <div className="small"><b>Secret:</b> {card.secret}</div>}
              <div className="small muted" style={{ marginTop: 6 }}><b>Alibi:</b> “{reveal.alibis.find((a) => a.playerId === playerId)?.text}”</div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2>The detective's reasoning</h2>
        <p className="ruling-line">“{reveal.accusation.reasoning}”</p>
        <div className="row">{reveal.accusation.keyPoints.map((k, i) => <span key={i} className="badge">{k}</span>)}</div>
        {reveal.reviewLog.map((r) => (
          <p key={r.round} className="small muted"><b>After {r.round === 0 ? "reading the alibis" : `round ${r.round}`}:</b> {r.reasoning}</p>
        ))}
      </div>

      <div className="panel">
        <h2>Hidden suspicion profiles</h2>
        <p className="small muted">What the detective was tracking during the game. Nobody saw this until now.</p>
        <div className="grid cols-3">
          {profiles.map((p) => <ProfileCard key={p.playerId} p={p} name={who(p.playerId)} culprit={p.playerId === reveal.culpritPlayerId} accused={p.playerId === accusedId} />)}
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <h2>Major contradictions</h2>
          {[...reveal.contradictions].sort((a, b) => b.severity - a.severity).slice(0, 10).map((c) => (
            <div key={c.id} className="contradiction" style={{ marginBottom: 8 }}>
              <div className="meta">{c.kind.replace(/_/g, " ")} · {c.playerIds.map(who).join(" vs ")} · severity {c.severity.toFixed(2)}</div>
              {c.claimIds.map((id) => <div key={id} className="quote small">{claimById.get(id)?.statement}</div>)}
              <div className="small">{c.explanation}</div>
            </div>
          ))}
          {!reveal.contradictions.length && <div className="small muted">None found.</div>}
        </div>
        <div className="panel">
          <h2>Major corroborations</h2>
          {[...reveal.corroborations].sort((a, b) => b.strength - a.strength).slice(0, 10).map((c) => (
            <div key={c.id} className="contradiction" style={{ marginBottom: 8, borderLeftColor: "var(--innocent)" }}>
              <div className="meta">{c.playerIds.map(who).join(" + ")} · strength {c.strength.toFixed(2)}</div>
              <div className="small">{c.explanation}</div>
            </div>
          ))}
          {!reveal.corroborations.length && <div className="small muted">None found.</div>}
        </div>
      </div>
    </div>
  );
}

function ProfileCard({ p, name, culprit, accused }: { p: SuspicionProfile; name: string; culprit: boolean; accused: boolean }) {
  const rows: [string, number][] = [
    ["Evidence conflicts", p.components.evidence],
    ["Changed from alibi", p.components.alibi],
    ["Self contradictions", p.components.self],
    ["Conflicts with others", p.components.crossPlayer],
    ["Implausible claims", p.components.implausible],
    ["Evasive or timed out", p.components.evasiveness],
    ["Corroborated (reduces)", -p.components.corroboration],
  ];
  const max = Math.max(0.5, ...rows.map(([, v]) => Math.abs(v)));
  return (
    <div className={`card ${culprit ? "guilty" : ""}`}>
      <div className="row"><b>#{p.rank} {name}</b>{culprit && <span className="badge culprit">culprit</span>}{accused && <span className="badge accused">accused</span>}</div>
      <div className="score" style={{ fontSize: 48, marginTop: 8 }}>{p.suspicionScore}</div>
      <div className="tiny">suspicion score</div>
      <div className="breakdown" style={{ marginTop: 10, gridTemplateColumns: "150px 1fr 40px" }}>
        {rows.map(([label, v]) => (
          <div key={label} style={{ display: "contents" }}>
            <span className="muted">{label}</span>
            <div className={`bar ${v >= 0 ? "red" : ""}`}><i style={{ width: `${(Math.abs(v) / max) * 100}%`, background: v < 0 ? "var(--innocent)" : undefined }} /></div>
            <span>{v.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>Questions {p.questionsReceived} · claims {p.claimsMade} · story changes {p.storyChanges} · corroborations {p.corroborationIds.length}</div>
      {p.openQuestions.length > 0 && <div className="small" style={{ marginTop: 6 }}><b>Open questions:</b> {p.openQuestions.slice(0, 3).join(" · ")}</div>}
      {p.notes.length > 0 && <div className="small" style={{ marginTop: 4 }}><b>Notes:</b> {p.notes.slice(0, 3).join(" · ")}</div>}
    </div>
  );
}
