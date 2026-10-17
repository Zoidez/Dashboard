/**
 * Help > Something's wrong (docs/LASS.md, section 5): the user describes a problem and LASS opens an
 * investigation with that text. What the user types here is an instruction to LASS, nothing else is.
 */
import { createRoot } from "react-dom/client";
import { useState } from "react";

declare global {
  interface Window { reportHost: { send(text: string): Promise<{ id: string | null; message: string }>; close(): void } }
}

function Report() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    const r = await window.reportHost.send(text);
    setResult(r.message);
    setBusy(false);
  };
  return (
    <div className="report">
      <h1>Something's wrong?</h1>
      <p>Describe what isn't working or what's getting in your way. LASS looks into it in the background; the rest of the Dashboard stays usable.</p>
      {result === null ? (
        <>
          <textarea autoFocus maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="For example: the card I asked for keeps failing, and I don't know why." />
          <div className="row">
            <button onClick={() => window.reportHost.close()}>Cancel</button>
            <button className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>Send</button>
          </div>
        </>
      ) : (
        <>
          <div className="result" role="status">{result}</div>
          <div className="row"><button className="primary" onClick={() => window.reportHost.close()}>Close</button></div>
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Report />);
