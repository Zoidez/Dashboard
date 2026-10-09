/**
 * The New card (CARDS.md 1). Part of the host, not a sandboxed card: the only place where typed
 * text can start the generator (RULES.md, host invariant 1). When the CLI gate refuses, it shows
 * the state and button from ARCHITECTURE.md, "Claude card: CLI test states", instead of the input.
 */
import { useEffect, useRef, useState } from "react";
import type { GeneratorView, NewCardRequest } from "../shared/ui-state.js";

const BUSY = new Set(["checking", "writing", "validating", "approval", "installing"]);
const TESTABLE = new Set(["untested", "no-list", "unreadable", "incomplete", "old-harness"]);

function gateMessage(g: NonNullable<GeneratorView["gate"]>, build?: string): string {
  const v = build?.split("-")[0] ?? "this version";
  switch (g.code) {
    case "untested": case "no-list": return `This CLI version (${v}) has not been tested. The generator is off until it passes.`;
    case "incomplete": return `Testing of CLI ${v} is not finished: ${g.reason ?? "some checks have not passed yet"}.`;
    case "blocked": return `CLI ${v} failed the security test. The generator stays off.`;
    case "hash-mismatch": return `The CLI file does not match the tested build of ${v}. It may be damaged or replaced; reinstall the verified build (run the spike).`;
    case "old-harness": return `CLI ${v} was approved by an older version of the security test. Run the test again to switch the generator on.`;
    default: return g.reason ?? "The generator is off.";
  }
}

export function NewCard({ g, start, stop, testCli }: { g: GeneratorView; start: (r: NewCardRequest) => void; stop: () => void; testCli: () => void }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("new");
  const [preset, setPreset] = useState<"watch-feed" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const busy = BUSY.has(g.phase);
  useEffect(() => { if (target !== "new" && !g.targets.some((t) => t.cardId === target)) setTarget("new"); }, [g.targets, target]);
  useEffect(() => { if (g.phase === "done" && /on the grid|was updated/.test(g.message ?? "")) setText(""); }, [g.phase, g.message]);

  const send = () => { if (!busy && text.trim()) start({ text, target, preset }); };
  const targetName = g.targets.find((t) => t.cardId === target)?.name;

  if (g.gate && !g.gate.ok) {
    return (
      <div className="newcard">
        <p className="gate-state" role="status">{gateMessage(g.gate, g.build)}</p>
        {g.gate.code && TESTABLE.has(g.gate.code) && (
          <button className="primary" disabled={g.testing || !g.canTest} onClick={testCli}>
            {g.testing ? "Testing… (see the PowerShell window)" : "Test the new CLI version"}
          </button>
        )}
        {!g.canTest && g.gate.code && TESTABLE.has(g.gate.code) && <p className="hint">The security test runs from the project folder (spikes\spike1-cli.ps1); it is not available in this build.</p>}
      </div>
    );
  }

  return (
    <div className="newcard">
      <div className="row">
        <select aria-label="What to make" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
          <option value="new">New card</option>
          {g.targets.map((t) => <option key={t.cardId} value={t.cardId}>Change: {t.name}</option>)}
        </select>
        <select aria-label="Preset" value={preset ?? ""} disabled={busy || target !== "new"} onChange={(e) => setPreset(e.target.value === "watch-feed" ? "watch-feed" : null)}>
          <option value="">No preset</option>
          <option value="watch-feed">Watch feed</option>
        </select>
      </div>
      <textarea
        ref={area}
        aria-label="Describe the card"
        placeholder={target === "new" ? "Describe the card you want. Ctrl+Enter sends." : `Describe the change to ${targetName}. Ctrl+Enter sends.`}
        rows={6}
        spellCheck
        value={text}
        disabled={busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); send(); } }}
      />
      <div className="row">
        {!busy && <button className="primary" disabled={!text.trim()} onClick={send}>{target === "new" ? "Create" : `Update ${targetName}`}</button>}
        {busy && <button className="danger" onClick={stop}>Stop</button>}
        <span className="progress" role="status">{g.message}{g.progress ? ` — ${g.progress}` : ""}</span>
      </div>
      {g.phase === "failed" && g.errors && <pre className="errors">{g.errors}</pre>}
    </div>
  );
}
