/**
 * The LASS bar (docs/LASS.md 7): slides up below the grid (it never covers a card or the New card).
 * Asks the user to describe a problem LASS could not identify, once per investigation; or shows a
 * finished investigation's answer with the steps only the user can do. New-card answers are shown on
 * the New card instead. The answer text comes from the triage model: shown as plain text only.
 */
import { useState } from "react";
import type { LassBarView, LassFixView } from "../shared/ui-state.js";

export type FixAction = "start" | "test" | "install" | "reject" | "fixed" | "not-fixed";
export interface FixHost { fix: (id: string, action: FixAction, confirmedRed: boolean) => Promise<string | null>; patch: (id: string) => Promise<string> }

const passed = (c: number | undefined) => (c === 0 ? "passed" : c === undefined ? "not run" : `failed (exit ${c})`);
const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";

/**
 * LASS phase 4 (LASS.md 8): every step of a fix is a button here. The summary and the file reasons
 * from the fix run are model text: shown as plain text. The red list is the host's own reading of the patch.
 */
function FixPanel({ f, fx }: { f: LassFixView; fx: FixHost }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [red, setRed] = useState(false);
  const act = async (a: FixAction) => { setBusy(true); setMsg(null); const r = await fx.fix(f.id, a, red); setBusy(false); if (r) setMsg(r); };
  const reject = <button className="danger" disabled={busy} onClick={() => void act("reject")}>Reject the fix</button>;
  const note = msg && <p className="lass-error" role="alert">{msg}</p>;
  const err = f.error && <p className="lass-error">Last attempt: {f.error}</p>;

  if (f.state === "identified") return (
    <footer className="lass-bar" role="region" aria-label="LASS">
      <strong>LASS found the problem</strong>
      {f.summary && <p>{f.summary}</p>}
      {err}
      {f.unavailable
        ? <p className="lass-note-text">LASS cannot fix it on this PC: {f.unavailable}.</p>
        : <p>LASS can try to fix it. Claude (Opus) works on a copy of the Dashboard's code inside the sealed container (no access to your files, internet only through the proxy). Nothing on this PC changes until you have seen the changes and said so. This uses one of today's 2 fix runs ({f.left} left) and can take up to 100 minutes.</p>}
      {note}
      <div className="lass-row end">
        {!f.unavailable && <button className="primary" disabled={busy || f.left === 0} onClick={() => void act("start")}>Start the fix</button>}
        {reject}
      </div>
    </footer>
  );

  if (f.state === "verifying") return (
    <footer className="lass-bar" role="region" aria-label="LASS">
      <strong>LASS installed its fix</strong>
      {f.fixSummary && <p>{firstLine(f.fixSummary)}</p>}
      <p>Try what failed before. Did the fix solve the problem?</p>
      {note}
      <div className="lass-row end">
        <button className="primary" disabled={busy} onClick={() => void act("fixed")}>Yes, it's fixed</button>
        <button disabled={busy} onClick={() => void act("not-fixed")}>No</button>
      </div>
    </footer>
  );

  const stage = f.stage;
  if (stage === "container" || stage === "testing" || stage === "installing") return (
    <footer className="lass-bar" role="region" aria-label="LASS">
      <strong>{stage === "container" ? "LASS is working on a fix" : stage === "testing" ? "Testing the fix on this PC" : "Installing the fix"}</strong>
      <p>{f.progress ?? "starting"}{stage === "container" ? ". This can take up to 100 minutes; the rest of the Dashboard stays usable." : stage === "testing" ? ". The tests take about 30 minutes; the rest of the Dashboard stays usable." : ""}</p>
      {note}
      {stage !== "installing" && <div className="lass-row end">{reject}</div>}
    </footer>
  );

  const files = f.files ?? [];
  const reds = files.filter((x) => x.security);
  const refused = f.refused ?? [];
  const canTest = stage === "review" && refused.length === 0 && files.length > 0;
  return (
    <footer className="lass-bar" role="region" aria-label="LASS">
      <strong>{stage === "ready" ? "The fix passed every test on this PC" : "LASS has a fix for you to review"}</strong>
      {f.fixSummary && <pre className="lass-summary">{f.fixSummary}</pre>}
      {stage === "review" && <p className="lass-note-text">Checks inside the container: npm ci {passed(f.checks?.npmCi)}, Claude {passed(f.checks?.claude)}, typecheck {passed(f.checks?.typecheck)}, unit tests {passed(f.checks?.unit)} (tests that need Windows cannot pass there).</p>}
      {stage === "ready" && <p>Build {f.build} is installed beside the current one and passed the typecheck, the unit and e2e tests and the security tests. Install restarts the Dashboard into it; if it does not start properly, the previous build comes back by itself. The fix is on branch {f.branch} in your project; it is not merged.</p>}
      <p>{files.length} file{files.length === 1 ? "" : "s"} changed (+{f.added ?? 0} −{f.removed ?? 0} lines){reds.length ? `, ${reds.length} security-relevant (red):` : ":"}</p>
      <ul className="lass-files">
        {files.map((x) => <li key={x.path} className={x.security ? "red" : ""}><span className="mono">{x.from ? `${x.from} → ` : ""}{x.path}</span> {x.change}{x.why ? `: ${x.why}` : ""}</li>)}
      </ul>
      {refused.length > 0 && <div className="lass-error" role="alert">The host refuses this patch: <ul>{refused.map((r, i) => <li key={i}>{r}</li>)}</ul></div>}
      {err}
      {diff !== null && <pre className="lass-diff" aria-label="The changes">{diff || "(no patch)"}</pre>}
      {canTest && <>
        <p>Testing runs the changed code on this PC with your rights (typecheck, unit and e2e tests, packaging, the security tests: about 30 minutes). Read the changes first.</p>
        {reds.length > 0 && <label className="lass-confirm"><input type="checkbox" checked={red} onChange={(e) => setRed(e.target.checked)} /> I have read the red changes and want them tested on this PC</label>}
      </>}
      {note}
      <div className="lass-row end">
        <button disabled={busy} onClick={() => { if (diff === null) void fx.patch(f.id).then(setDiff); else setDiff(null); }}>{diff === null ? "Show the changes" : "Hide the changes"}</button>
        {canTest && <button className="primary" disabled={busy || (reds.length > 0 && !red)} onClick={() => void act("test")}>Test on this PC</button>}
        {stage === "ready" && <button className="primary" disabled={busy} onClick={() => void act("install")}>Install and restart</button>}
        {reject}
      </div>
    </footer>
  );
}

export function LassBar({ v, answer, dismiss, fx }: { v: LassBarView | undefined; answer: (id: string, text: string) => void; dismiss: (id: string) => void; fx: FixHost }) {
  const [text, setText] = useState("");
  if (v?.fix) return <FixPanel key={`${v.fix.id}-${v.fix.state}-${v.fix.stage ?? ""}`} f={v.fix} fx={fx} />;
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
