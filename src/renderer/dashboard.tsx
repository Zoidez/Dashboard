/**
 * The grid (React). Each card is a frame with a title bar; the host lays the card's own isolated
 * view over the frame body, at the rectangle this page reports. The page never hosts card code.
 * Card-provided text (names, status messages) is rendered as text only (React escapes it).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent, type ReactElement, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import type { CardAction, CardFrame, DashboardState, FrameRect, LayoutUpdate, NewCardRequest, PermissionCategory } from "../shared/ui-state.js";
import { NewCard } from "./new-card.js";
import { Toggle } from "./toggle.js";

declare global {
  interface Window {
    dashboardHost: {
      onState(cb: (s: DashboardState) => void): void;
      sendRects(r: FrameRect[]): void;
      saveLayout(u: LayoutUpdate): void;
      cardAction(cardId: string, action: CardAction): void;
      cardPermission(cardId: string, category: PermissionCategory, on: boolean): void;
      openOptions(): void;
      newCardStart(r: NewCardRequest): void;
      newCardStop(): void;
      newCardTestCli(): void;
      newCardLassCancel(id: string): void;
    };
  }
}

const host = window.dashboardHost;
// Fine grid (user request 2026-10-09): 96 columns, 10 px rows, no track gap; the spacing between
// cards is each frame's margin (dashboard.css). Must match COLUMNS / ROW_PX / MAX_ROWS / MIN_* in main/layout.ts.
const COLS = 96, ROW = 10, MAX_ROWS = 120, MIN_W = 6, MIN_H = 6;

const STATE_WORDS: Record<string, string> = {
  starting: "starting", loading: "loading", ok: "up to date", stale: "stale", error: "error", stopped: "stopped", refused: "refused",
};

// ---------- permission menu ----------

const svg = { width: 16, height: 16, viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** Shield: the button that opens the menu. */
const ShieldIcon = () => (
  <svg {...svg}><path d="M10 2.5 16 4.8v4.6c0 3.8-2.6 6.6-6 8.1-3.4-1.5-6-4.3-6-8.1V4.8z" /><path d="m7.4 10 1.8 1.8 3.5-3.6" /></svg>
);

const CATEGORY_UI: Array<{ id: PermissionCategory; label: string; what: string; icon: ReactElement }> = [
  {
    id: "web", label: "Web", what: "go online and open links",
    // A globe with an orbit around it.
    icon: (
      <svg {...svg} width={18} height={18}>
        <circle cx="10" cy="10" r="6.3" /><ellipse cx="10" cy="10" rx="2.7" ry="6.3" /><path d="M3.7 10h12.6" />
        <path d="M15.6 6.3c2.4-.9 3.9-.9 4.1-.2.4 1.3-3.8 4.2-9.4 6.3S.8 15.3.3 14c-.2-.7 1-1.8 3.2-3" strokeWidth={1.2} />
      </svg>
    ),
  },
  {
    id: "files", label: "Files", what: "read or change files",
    icon: <svg {...svg}><path d="M2.5 6a1 1 0 0 1 1-1h4.2l1.7 1.9h7.1a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" /></svg>,
  },
  {
    id: "system", label: "System info", what: "read your computer's details",
    icon: <svg {...svg}><rect x="5" y="5" width="10" height="10" rx="1.5" /><rect x="8" y="8" width="4" height="4" rx=".5" /><path d="M8 2.5V5M12 2.5V5M8 15v2.5M12 15v2.5M2.5 8H5M2.5 12H5M15 8h2.5M15 12h2.5" /></svg>,
  },
  {
    id: "reports", label: "Reports", what: "read scheduled-task reports",
    icon: <svg {...svg}><path d="M5 2.5h6.5L15 6v11.5H5z" /><path d="M11.5 2.5V6H15M7.5 9.5h5M7.5 12h5M7.5 14.5h3" /></svg>,
  },
];

/**
 * Drops down from the shield button in a card's title bar: one row per permission group with its
 * icon and an on/off switch. Switching off takes effect at once (the broker refuses it from then on).
 * Positioned fixed so the frame's overflow does not clip it; card views under it are hidden meanwhile
 * (a card view is a native layer above this page).
 */
function PermissionMenu({ frame, at, menuRef, onSwitch }: {
  frame: CardFrame; at: { top: number; right: number }; menuRef: RefObject<HTMLDivElement | null>;
  onSwitch: (c: PermissionCategory, on: boolean) => void;
}) {
  const p = frame.permissions;
  if (!p) return null;
  return (
    <div className="perm-menu" role="menu" aria-label={`Permissions of ${frame.name}`} ref={menuRef} style={{ top: at.top, right: at.right }}>
      {CATEGORY_UI.map((c) => {
        const st = p[c.id];
        const none = st.state === "none";
        const on = st.state === "on" || st.state === "mixed";
        const note = none ? "not requested" : st.state === "mixed" ? "some off" : on ? "allowed" : "off";
        return (
          <div key={c.id} className={`perm-row${none ? " none" : on ? "" : " off"}`} role="menuitem" title={none ? `${frame.name} did not ask to ${c.what}` : `${on ? "Allowed" : "Not allowed"} to ${c.what}`}>
            <span className="perm-icon">{c.icon}</span>
            <span className="perm-label">{c.label}<span className="perm-note">{note}</span></span>
            <Toggle on={on} disabled={none} label={`${c.label}: ${on ? "switch off" : "switch on"}`} onChange={(v) => onSwitch(c.id, v)} />
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const [state, setState] = useState<DashboardState>({ frames: [], summary: "", generator: { phase: "idle", testing: false, canTest: false, targets: [] } });
  const [frames, setFrames] = useState<CardFrame[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);              // dragging or resizing: views hidden meanwhile
  // Smooth resizing (user request 2026-10-09): while dragging, an outline follows the pointer pixel
  // for pixel and nothing else moves; on release the card snaps to the nearest fine grid step.
  const [ghost, setGhost] = useState<{ cardId: string; left: number; top: number; width: number; height: number } | null>(null);
  const scroller = useRef<HTMLElement>(null);
  const bodies = useRef(new Map<string, HTMLElement>());
  // While the user drags or resizes, updates from the host must not undo the change in progress.
  const pendingSizes = useRef(new Map<string, { w: number; h: number }>());
  // The open permission menu: which card, and where (fixed, right-aligned under its button).
  const [menu, setMenu] = useState<{ cardId: string; top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLElement | null>(null);

  useEffect(() => host.onState((s) => {
    setState(s);
    setFrames(pendingSizes.current.size ? s.frames.map((f) => (pendingSizes.current.has(f.cardId) ? { ...f, size: pendingSizes.current.get(f.cardId)! } : f)) : s.frames);
  }), []);

  const saveLayout = useCallback((fs: CardFrame[]) => {
    host.saveLayout({ order: fs.map((f) => f.cardId), sizes: Object.fromEntries(fs.map((f) => [f.cardId, f.size])) });
  }, []);

  // Report every running frame's body rectangle plus the grid's visible area. The host shows the part of
  // each view inside that area; a view is hidden only when its frame body is completely out of view.
  const report = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const v = sc.getBoundingClientRect();
    // The scroller's content box without its scrollbars.
    const clip = { x: Math.round(v.left + sc.clientLeft), y: Math.round(v.top + sc.clientTop), width: sc.clientWidth, height: sc.clientHeight };
    const rects: FrameRect[] = [];
    const m = menuRef.current?.getBoundingClientRect();
    for (const f of frames) {
      if (!f.running) continue;
      const el = bodies.current.get(f.cardId);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left), y = Math.round(r.top), width = Math.round(r.width), height = Math.round(r.height);
      const overlaps = x < clip.x + clip.width && x + width > clip.x && y < clip.y + clip.height && y + height > clip.y;
      // A card view is drawn above this page: hide any card the open permission menu would sit under.
      const underMenu = !!m && x < m.right && x + width > m.left && y < m.bottom && y + height > m.top;
      const visible = !busy && !underMenu && width > 20 && height > 20 && overlaps;
      rects.push({ cardId: f.cardId, x, y, width, height, clip, visible });
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

  // Close the permission menu on a click elsewhere, Escape, scrolling or resizing (its position would go stale).
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !menuButton.current?.contains(t)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(null); (menuButton.current as HTMLButtonElement | null)?.focus(); } };
    const close = () => setMenu(null);
    const sc = scroller.current;
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    sc?.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
      sc?.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const menuFrame = menu ? frames.find((f) => f.cardId === menu.cardId && f.permissions) : undefined;
  useEffect(() => { if (menu && !menuFrame) setMenu(null); }, [menu, menuFrame]);

  const toggleMenu = (e: RMouseEvent<HTMLButtonElement>, f: CardFrame) => {
    if (menu?.cardId === f.cardId) { setMenu(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    menuButton.current = e.currentTarget;
    setMenu({ cardId: f.cardId, top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) });
  };

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
    const frameEl = (e.currentTarget as HTMLElement).closest("section.frame") as HTMLElement | null;
    if (!grid || !frameEl) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const colW = grid.clientWidth / COLS;
    const MARGIN = 12;                                   // frame margin, both sides (dashboard.css)
    const g = grid.getBoundingClientRect(), r = frameEl.getBoundingClientRect();
    const left = r.left - g.left, top = r.top - g.top;
    const minW = MIN_W * colW - MARGIN, minH = MIN_H * ROW - MARGIN;
    const maxW = g.width - left - MARGIN / 2, maxH = MAX_ROWS * ROW - MARGIN;
    const x0 = e.clientX, y0 = e.clientY;
    let width = r.width, height = r.height;
    setBusy(true);
    setGhost({ cardId: f.cardId, left, top, width, height });
    let raf = 0;
    const move = (ev: PointerEvent) => {
      width = Math.max(minW, Math.min(maxW, r.width + ev.clientX - x0));
      height = Math.max(minH, Math.min(maxH, r.height + ev.clientY - y0));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setGhost({ cardId: f.cardId, left, top, width, height }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      cancelAnimationFrame(raf);
      // Snap to the nearest fine step: frame size = units * step - margin.
      const w = Math.max(MIN_W, Math.min(COLS, Math.round((width + MARGIN) / colW)));
      const h = Math.max(MIN_H, Math.min(MAX_ROWS, Math.round((height + MARGIN) / ROW)));
      setGhost(null);
      setBusy(false);
      setFrames((cur) => {
        const next = cur.map((c) => (c.cardId === f.cardId ? { ...c, size: { w, h } } : c));
        pendingSizes.current.set(f.cardId, { w, h });
        saveLayout(next);
        pendingSizes.current.clear();                    // the host's next state carries the saved size
        return next;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
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
          {ghost && (
            <div className="resize-ghost" style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}>
              <span>{Math.round(ghost.width)} × {Math.round(ghost.height)}</span>
            </div>
          )}
          <section className="frame newcard-frame" data-card="new" style={{ gridColumn: "span 32", gridRow: "span 46" }}>
            <div className="bar"><span className="name">New</span><span className="state">{state.generator.gate?.ok ? `Claude Code ${state.generator.gate.version}` : ""}</span></div>
            <div className="body newcard-body">
              <NewCard g={state.generator} start={(r) => host.newCardStart(r)} stop={() => host.newCardStop()} testCli={() => host.newCardTestCli()} lassCancel={(id) => host.newCardLassCancel(id)} />
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
                {/* Shown only when the theme uses the bookmark severity method (dashboard.css). */}
                <svg className="bookmark" viewBox="0 0 10 14" aria-hidden="true"><path d="M0 0h10v14L5 10 0 14z" /></svg>
                <span className="name">{f.name}</span>
                <span className="state" data-state={f.state}>{STATE_WORDS[f.state] ?? f.state}{f.message ? `: ${f.message}` : ""}</span>
                <span className="actions">
                  {f.permissions && (
                    <button
                      className={`perm-btn${Object.values(f.permissions).some((c) => c.state === "off" || c.state === "mixed") ? " some-off" : ""}`}
                      aria-haspopup="menu" aria-expanded={menu?.cardId === f.cardId} draggable={false}
                      onClick={(e) => toggleMenu(e, f)} title="Permissions"
                    ><ShieldIcon /></button>
                  )}
                  {f.running && <button onClick={() => host.cardAction(f.cardId, "stop")} title="Stop the card now">Stop</button>}
                  {f.startable && <button onClick={() => host.cardAction(f.cardId, "start")} title="Start the card again">Start</button>}
                  {(f.running || f.startable) && <button className="danger" onClick={() => host.cardAction(f.cardId, "revoke")} title="Remove the card's approval">Revoke</button>}
                  {f.revoked && <button className="grant" onClick={() => host.cardAction(f.cardId, "grant")} title="Undo the revoke and start the card again">Grant</button>}
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
      {menu && menuFrame && (
        <PermissionMenu frame={menuFrame} at={menu} menuRef={menuRef} onSwitch={(c, on) => host.cardPermission(menuFrame.cardId, c, on)} />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
