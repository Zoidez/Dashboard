/**
 * The approval canvas (docs/PERMISSIONS.md). Shows what the host will allow, in plain words, with
 * the card's own reason beside it. Every line can be switched off; markings are recomputed by the
 * host at once. Red is never the only signal: every marked line carries its tag and sentence.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CanvasView } from "../main/ui/canvas.js";

declare global {
  interface Window {
    canvasHost: { get(): Promise<CanvasView | null>; toggle(i: number, on: boolean): Promise<CanvasView | null>; decide(approve: boolean): Promise<{ closed: boolean } | null>; onChanged(cb: () => void): void };
  }
}
const host = window.canvasHost;

function App() {
  const [v, setV] = useState<CanvasView | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => void host.get().then((x) => { setV(x); if (x) setChecked(x.permissions.map(() => true)); });
  useEffect(() => { load(); host.onChanged(load); }, []);
  if (!v) return <p className="panel">Nothing to approve.</p>;

  const toggle = async (i: number, on: boolean) => {
    const next = [...checked]; next[i] = on; setChecked(next);
    const nv = await host.toggle(i, on);
    if (nv) setV(nv);
  };
  const red = v.display.red;
  const reds = [...new Set(v.display.lines.flatMap((l) => l.marks.filter((m) => m.level === "red").map((m) => `${m.tag}: ${m.why}`)))];
  const yellows = [...new Set(v.display.lines.flatMap((l) => l.marks.filter((m) => m.level === "yellow").map((m) => m.why)))];

  return (
    <div className={`canvas${red ? " red" : ""}`}>
      <header>
        <h1>{v.kind === "new" ? "Approve the new card" : "Approve the update"}: {v.name}</h1>
        <div className="hint mono">{v.cardId} · version {v.version}{v.installedVersion ? ` (installed: ${v.installedVersion})` : ""}</div>
        {v.description && <p>{v.description}</p>}
      </header>
      {red && (
        <div className="banner red" role="alert">
          <strong>Red markings</strong>
          <ul>{reds.map((s, i) => <li key={i}>{s}</li>)}</ul>
          {v.allowanceCovers && <div>You allowed exactly these scopes before ("Yes, always"); no question will be asked.</div>}
        </div>
      )}
      {!red && yellows.length > 0 && <div className="banner yellow"><strong>Worth a look</strong><ul>{yellows.map((s, i) => <li key={i}>{s}</li>)}</ul></div>}
      <h2>The card may</h2>
      {v.permissions.length === 0 && <p className="hint">Nothing: this card asks for no permissions.</p>}
      <ul className="perms">
        {v.permissions.map((p, i) => {
          const marks = v.display.lines[i].marks;
          const isRed = marks.some((m) => m.level === "red");
          const isYellow = !isRed && marks.some((m) => m.level === "yellow");
          return (
            <li key={i} className={isRed ? "red" : isYellow ? "yellow" : ""}>
              <label>
                <input type="checkbox" checked={checked[i] ?? true} onChange={(e) => void toggle(i, e.target.checked)} />
                <span className="text">{p.text}</span>
                {p.status === "new" && v.kind === "update" && <span className="tag">new</span>}
                {p.status === "changed" && <span className="tag">changed</span>}
                {marks.map((m, j) => <span key={j} className={`mark ${m.level}`}>{m.level === "red" ? "red" : "yellow"} {m.tag}</span>)}
              </label>
              {p.oldText && <div className="hint">was: {p.oldText}</div>}
              <div className="reason">Card says: {p.reason}</div>
              {marks.map((m, j) => <div key={j} className={`why ${m.level}`}>{m.why}</div>)}
            </li>
          );
        })}
      </ul>
      {v.removed.length > 0 && <><h3>No longer asked for</h3><ul className="removed">{v.removed.map((r, i) => <li key={i}><s>{r}</s></li>)}</ul></>}
      <h2>Files</h2>
      <table className="list"><tbody>
        {v.files.map((f) => <tr key={f.path}><td className="mono">{f.path}</td><td>{f.size} bytes</td><td>{v.kind === "update" ? f.change : ""}</td><td className="mono hint">{f.sha256.slice(0, 16)}…</td></tr>)}
        {v.removedFiles.map((f) => <tr key={f}><td className="mono"><s>{f}</s></td><td colSpan={3}>removed</td></tr>)}
      </tbody></table>
      <footer>
        <button onClick={() => { setBusy(true); void host.decide(false); }} disabled={busy}>Cancel</button>
        <button className="primary" onClick={async () => { setBusy(true); const r = await host.decide(true); if (!r?.closed) setBusy(false); }} disabled={busy}>Approve</button>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
