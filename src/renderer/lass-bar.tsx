/**
 * The LASS bar (docs/LASS.md 7): slides up below the grid (it never covers a card or the New card).
 * Asks the user to describe a problem LASS could not identify, once per investigation; or shows a
 * finished investigation's answer with the steps only the user can do. New-card answers are shown on
 * the New card instead. The answer text comes from the triage model: shown as plain text only.
 */
import { useState } from "react";
import type { LassBarView } from "../shared/ui-state.js";

export function LassBar({ v, answer, dismiss }: { v: LassBarView | undefined; answer: (id: string, text: string) => void; dismiss: (id: string) => void }) {
  const [text, setText] = useState("");
  if (v?.asking) {
    const a = v.asking;
    const lead = a.title === "your report"
      ? "LASS could not tell from the logs what went wrong with your report."
      : `It looks like creating ${a.title} has failed several times.`;
    return (
      <footer className="lass-bar" role="region" aria-label="LASS">
        <strong>Something not working?</strong>
        <p>{lead} If something about the Dashboard is getting in your way, describe it here and LASS will look into it.</p>
        {a.summary && <p className="lass-note-text">What LASS saw: {a.summary}</p>}
        <div className="lass-row">
          <textarea aria-label="Describe the problem" maxLength={4000} rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="primary" disabled={!text.trim()} onClick={() => { answer(a.id, text); setText(""); }}>Send</button>
          <button onClick={() => dismiss(a.id)}>Not now</button>
        </div>
      </footer>
    );
  }
  const n = v?.notice;
  if (n && n.function !== "newcard.create") {
    return (
      <footer className="lass-bar" role="region" aria-label="LASS">
        <strong>LASS</strong>
        {n.summary && <p>{n.summary}</p>}
        {n.userSteps.length > 0 && <><p>What only you can do:</p><ol>{n.userSteps.map((s, i) => <li key={i}>{s}</li>)}</ol></>}
        <div className="lass-row end"><button onClick={() => dismiss(n.id)}>Close</button></div>
      </footer>
    );
  }
  return null;
}
