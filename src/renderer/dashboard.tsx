/**
 * The grid (React). Each card is a frame with a title bar; the host lays the card's own isolated
 * view over the frame body, at the rectangle this page reports. The page never hosts card code.
 * Card-provided text (names, status messages) is rendered as text only (React escapes it).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createRoot } from "react-dom/client";
import type { CardAction, CardFrame, DashboardState, FrameRect, LayoutUpdate, NewCardRequest } from "../shared/ui-state.js";
import { NewCard } from "./new-card.js";

declare global {
  interface Window {
    dashboardHost: {
      onState(cb: (s: DashboardState) => void): void;
      sendRects(r: FrameRect[]): void;
      saveLayout(u: LayoutUpdate): void;
      cardAction(cardId: string, action: CardAction): void;
      openOptions(): void;
      newCardStart(r: NewCardRequest): void;
      newCardStop(): void;
      newCardTestCli(): void;
    };
  }
}

const host = window.dashboardHost;
const COLS = 12, ROW = 80, GAP = 12;

const STATE_WORDS: Record<string, string> = {
  starting: "starting", loading: "loading", ok: "up to date", stale: "stale", error: "error", stopped: "stopped", refused: "refused",
};

function App() {
  const [state, setState] = useState<DashboardState>({ frames: [], summary: "", generator: { phase: "idle", testing: false, canTest: false, targets: [] } });
  const [frames, setFrames] = useState<CardFrame[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);              // dragging or resizing: views hidden meanwhile
  const scroller = useRef<HTMLElement>(null);
  const bodies = useRef(new Map<string, HTMLElement>());
  // While the user drags or resizes, updates from the host must not undo the change in progress.
  const pendingSizes = useRef(new Map<string, { w: number; h: number }>());

  useEffect(() => host.onState((s) => {
    setState(s);
    setFrames(pendingSizes.current.size ? s.frames.map((f) => (pendingSizes.current.has(f.cardId) ? { ...f, size: pendingSizes.current.get(f.cardId)! } : f)) : s.frames);
  }), []);

  const saveLayout = useCallback((fs: CardFrame[]) => {
    host.saveLayout({ order: fs.map((f) => f.cardId), sizes: Object.fromEntries(fs.map((f) => [f.cardId, f.size])) });
  }, []);

  // Report every running frame's body rectangle; a view whose frame is not fully visible is hidden.
  const report = useCallback(() => {
    const view = scroller.current?.getBoundingClientRect();
    if (!view) return;
    const rects: FrameRect[] = [];
    for (const f of frames) {
      if (!f.running) continue;
      const el = bodies.current.get(f.cardId);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const visible = !busy && r.width > 20 && r.height > 20 && r.top >= view.top && r.bottom <= view.bottom && r.left >= view.left && r.right <= view.right;
      rects.push({ cardId: f.cardId, x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), visible });
    }
    host.sendRects(rects);
  }, [frames, busy]);

  useLayoutEffect(() => { report(); });
  useEffect(() => {
    let raf = 0;
    const later = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(report); };
    const ro = new ResizeObserver(later);
    if (scroller.current) ro.observe(scroller.current);
    scroller.current?.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    return () => { ro.disconnect(); scroller.current?.removeEventListener("scroll", later); window.removeEventListener("resize", later); cancelAnimationFrame(raf); };
  }, [report]);

  const onDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = frames.filter((f) => f.cardId !== dragId);
    const at = next.findIndex((f) => f.cardId === targetId);
    next.splice(at < 0 ? next.length : at, 0, frames.find((f) => f.cardId === dragId)!);
    setFrames(next);
    saveLayout(next);
  };

  const startResize = (e: RPointerEvent, f: CardFrame) => {
    e.preventDefault();
    const grid = scroller.current?.querySelector(".grid") as HTMLElement | null;
    if (!grid) return;
    const colW = (grid.clientWidth - GAP * (COLS - 1)) / COLS;
    const x0 = e.clientX, y0 = e.clientY, { w: w0, h: h0 } = f.size;
    setBusy(true);
    const move = (ev: PointerEvent) => {
      const w = Math.max(1, Math.min(COLS, Math.round(w0 + (ev.clientX - x0) / (colW + GAP))));
      const h = Math.max(1, Math.min(12, Math.round(h0 + (ev.clientY - y0) / (ROW + GAP))));
      pendingSizes.current.set(f.cardId, { w, h });
      setFrames((cur) => cur.map((c) => (c.cardId === f.cardId ? { ...c, size: { w, h } } : c)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setBusy(false);
      setFrames((cur) => {
        const next = cur.map((c) => (pendingSizes.current.has(c.cardId) ? { ...c, size: pendingSizes.current.get(c.cardId)! } : c));
        saveLayout(next);
        pendingSizes.current.clear();                    // the host's next state carries the saved size
        return next;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <>
      <header id="top">
        <span className="title">Dashboard</span>
        <span id="summary">{state.summary}</span>
        <button className="link" onClick={() => host.openOptions()}>Options…</button>
      </header>
      <main id="grid" ref={scroller}>
        <div className="grid">
          <section className="frame newcard-frame" data-card="new" style={{ gridColumn: "span 4", gridRow: "span 5" }}>
            <div className="bar"><span className="name">New</span><span className="state">{state.generator.gate?.ok ? `Claude Code ${state.generator.gate.version}` : ""}</span></div>
            <div className="body newcard-body">
              <NewCard g={state.generator} start={(r) => host.newCardStart(r)} stop={() => host.newCardStop()} testCli={() => host.newCardTestCli()} />
            </div>
          </section>
          {frames.map((f) => (
            <section
              key={f.cardId}
              className={`frame${dragId === f.cardId ? " dragging" : ""}`}
              data-card={f.cardId}
              data-accent={f.accent}
              style={{ gridColumn: `span ${f.size.w}`, gridRow: `span ${f.size.h}` }}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={() => onDrop(f.cardId)}
            >
              <div className="bar" draggable onDragStart={() => { setDragId(f.cardId); setBusy(true); }} onDragEnd={() => { setDragId(null); setBusy(false); }} title="Drag to move">
                <span className="name">{f.name}</span>
                <span className="state" data-state={f.state}>{STATE_WORDS[f.state] ?? f.state}{f.message ? `: ${f.message}` : ""}</span>
                <span className="actions">
                  {f.running && <button onClick={() => host.cardAction(f.cardId, "stop")} title="Stop the card now">Stop</button>}
                  {f.startable && <button onClick={() => host.cardAction(f.cardId, "start")} title="Start the card again">Start</button>}
                  {(f.running || f.startable) && <button className="danger" onClick={() => host.cardAction(f.cardId, "revoke")} title="Remove the card's approval">Revoke</button>}
                </span>
              </div>
              <div className="body" ref={(el) => { if (el) bodies.current.set(f.cardId, el); else bodies.current.delete(f.cardId); }}>
                {!f.running && <p className="reason">{f.message ?? STATE_WORDS[f.state] ?? f.state}</p>}
                {f.running && busy && <p className="reason">{f.name}</p>}
              </div>
              <div className="resize" onPointerDown={(e) => startResize(e, f)} title="Drag to resize" />
            </section>
          ))}
        </div>
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
