/**
 * The grid page (skeleton). Draws a frame with a title bar for every card; the host lays the card's
 * own view over the frame body. React and the real grid come with the next step (PROJECT.md).
 * Card-provided text (names, status messages) is set with textContent only.
 */
interface FrameState {
  cardId: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  state: string;
  message?: string;
  accent: string;
  running: boolean;
}
interface State { frames: FrameState[]; summary: string }

declare global {
  interface Window { dashboardHost: { onState(cb: (s: State) => void): void } }
}

const grid = document.getElementById("grid")!;
const summary = document.getElementById("summary")!;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

window.dashboardHost.onState((s) => {
  summary.textContent = s.summary;
  grid.replaceChildren();
  for (const f of s.frames) {
    const frame = el("section", "frame");
    frame.dataset.accent = f.accent;
    Object.assign(frame.style, { left: `${f.rect.x}px`, top: `${f.rect.y}px`, width: `${f.rect.width}px`, height: `${f.rect.height}px` });
    const bar = el("div", "bar");
    bar.append(el("span", "name", f.name));
    const st = el("span", "state", f.message ? `${f.state}: ${f.message}` : f.state);
    st.dataset.state = f.state;
    bar.append(st);
    frame.append(bar);
    if (!f.running && f.message) frame.append(el("div", "reason", f.message));
    grid.append(frame);
  }
});

export {};
