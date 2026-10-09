/**
 * File > Options (ARCHITECTURE.md, "Menu and Options"). Every change goes to the host, which
 * validates it; this page only shows the state the host returns. Card-provided text is text only.
 */
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CardAction, OptionsPatch, OptionsState } from "../shared/ui-state.js";

declare global {
  interface Window {
    optionsHost: {
      get(): Promise<OptionsState>;
      set(p: OptionsPatch): Promise<OptionsState>;
      cardAction(cardId: string, a: CardAction): Promise<OptionsState>;
      audit(cardId: string): Promise<Array<{ at: string; kind: string; detail: string }>>;
      onChanged(cb: () => void): void;
    };
  }
}
const host = window.optionsHost;
const TABS = ["General", "Feeds", "Cards", "Claude", "Security log"] as const;
type Tab = (typeof TABS)[number];
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

function App() {
  const [tab, setTab] = useState<Tab>("General");
  const [s, setS] = useState<OptionsState | null>(null);
  const refresh = useCallback(() => { void host.get().then(setS); }, []);
  useEffect(() => { refresh(); host.onChanged(refresh); }, [refresh]);
  if (!s) return <p className="panel">Loading…</p>;
  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}
      </nav>
      <div className="panel" role="tabpanel">
        {tab === "General" && <General s={s} set={(p) => host.set(p).then(setS)} />}
        {tab === "Feeds" && <Feeds s={s} set={(p) => host.set(p).then(setS)} />}
        {tab === "Cards" && <Cards s={s} act={(id, a) => host.cardAction(id, a).then(setS)} />}
        {tab === "Claude" && <Claude s={s} />}
        {tab === "Security log" && <Security s={s} />}
      </div>
    </>
  );
}

function General({ s, set }: { s: OptionsState; set: (p: OptionsPatch) => void }) {
  return (
    <>
      <h2>General</h2>
      <div className="row">
        <label htmlFor="sww">Start with Windows</label>
        <input id="sww" type="checkbox" checked={s.general.startWithWindows} onChange={(e) => set({ general: { startWithWindows: e.target.checked } })} />
        <span className="hint">{s.general.packaged ? "Adds the Dashboard to your Windows sign-in programs." : "Takes effect only in the packaged Dashboard.exe; this development run does not change Windows."}</span>
      </div>
      <div className="row">
        <label htmlFor="ctt">Close to tray</label>
        <input id="ctt" type="checkbox" checked={s.general.closeToTray} onChange={(e) => set({ general: { closeToTray: e.target.checked } })} />
        <span className="hint">Closing the window keeps the cards running; quit from the tray icon.</span>
      </div>
    </>
  );
}

function Feeds({ s, set }: { s: OptionsState; set: (p: OptionsPatch) => void }) {
  return (
    <>
      <h2>Feeds</h2>
      <table className="list">
        <thead><tr><th>Task</th><th>Runs</th><th>Grace (hours)</th><th>Reports kept</th><th>State</th></tr></thead>
        <tbody>
          {s.feeds.map((f) => (
            <tr key={f.taskId}>
              <td>{f.name}<div className="hint mono">{f.taskId}</div><div className="hint mono">{f.folder}</div></td>
              <td>
                <select value={f.schedule} onChange={(e) => set({ feed: { taskId: f.taskId, schedule: e.target.value as "daily" } })}>
                  <option value="daily">daily</option><option value="weekdays">weekdays</option><option value="none">no schedule</option>
                </select>
              </td>
              <td><input type="number" min={0} max={168} value={f.graceHours} onChange={(e) => set({ feed: { taskId: f.taskId, graceHours: Number(e.target.value) } })} /></td>
              <td><input type="number" min={1} max={1000} value={f.keep} onChange={(e) => set({ feed: { taskId: f.taskId, keep: Number(e.target.value) } })} /></td>
              <td>{f.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Task ids and report folders are fixed (ClaudeExchange\EXCHANGE.md). Changes apply on the next scan.</p>
    </>
  );
}

function Cards({ s, act }: { s: OptionsState; act: (id: string, a: CardAction) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [log, setLog] = useState<Array<{ at: string; kind: string; detail: string }>>([]);
  useEffect(() => { if (open) void host.audit(open).then(setLog); }, [open, s]);
  return (
    <>
      <h2>Cards</h2>
      {s.cards.length === 0 && <p className="hint">No cards installed.</p>}
      {s.cards.map((c) => (
        <div className="card-detail" key={c.cardId}>
          <div className="row">
            <strong>{c.name}</strong>
            <span className="hint mono">{c.cardId}</span>
            <span>{c.revoked ? "approval revoked" : c.running ? "running" : c.state}{c.message ? `: ${c.message}` : ""}</span>
            <span style={{ flex: 1 }} />
            {c.running && <button onClick={() => act(c.cardId, "stop")}>Stop</button>}
            {!c.running && !c.revoked && c.versionHash && <button onClick={() => act(c.cardId, "start")}>Start</button>}
            {!c.revoked && c.versionHash && <button className="danger" onClick={() => act(c.cardId, "revoke")}>Revoke</button>}
            <button className="link" onClick={() => setOpen(open === c.cardId ? null : c.cardId)}>{open === c.cardId ? "Hide details" : "Details"}</button>
          </div>
          {open === c.cardId && (
            <>
              <div className="hint">Approved {when(c.approvedAt)} · version hash <span className="mono">{c.versionHash ?? "—"}</span></div>
              <h4>Permissions</h4>
              {c.permissions.length === 0 && <p className="hint">None.</p>}
              {c.permissions.map((p, i) => (
                <div className="perm" key={i}>
                  {p.text}
                  {p.marks.map((m, j) => <span key={j} className={`mark ${m.level}`} title={m.why}>{m.level === "red" ? "red" : "yellow"} {m.tag}</span>)}
                  <div className="reason">Card says: {p.reason}</div>
                  {p.marks.map((m, j) => <div key={j} className="reason">{m.why}</div>)}
                </div>
              ))}
              <h4>Audit log (latest first)</h4>
              <table className="list"><tbody>
                {log.slice(-100).reverse().map((e, i) => <tr key={i}><td className="mono">{when(e.at)}</td><td>{e.kind}</td><td className="mono">{e.detail}</td></tr>)}
              </tbody></table>
            </>
          )}
        </div>
      ))}
    </>
  );
}

function Claude({ s }: { s: OptionsState }) {
  return (
    <>
      <h2>Claude (generator)</h2>
      <div className="row"><label>Claude Code CLI</label>{s.generator.ok ? <span>version {s.generator.version}, approved by the spike</span> : <span>off: {s.generator.reason}</span>}</div>
      <p className="hint">The generator (the New card) comes in the next build step. Sign-in, model, retries and timeout appear here then.</p>
    </>
  );
}

function Security({ s }: { s: OptionsState }) {
  return (
    <>
      <h2>Security log</h2>
      <p className="hint">Denied requests, blocked network attempts, refused or flagged cards. Read-only.</p>
      <table className="list">
        <thead><tr><th>Time</th><th>Card</th><th>What</th><th>Detail</th></tr></thead>
        <tbody>{[...s.security].reverse().map((e, i) => <tr key={i}><td className="mono">{when(e.at)}</td><td className="mono">{e.cardId}</td><td>{e.kind}</td><td className="mono">{e.detail}</td></tr>)}</tbody>
      </table>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
