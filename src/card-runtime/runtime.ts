/**
 * Host runtime inside the card's page (served as card://<id>/__host/runtime.js).
 * Builds the `api` object of spec/host-api.d.ts. Every call is a message over the card's port;
 * this code holds no privilege. Card code could reach the port anyway (it shares this world), and
 * that is fine: the port only carries this card's own identity, and the broker checks everything.
 */
import type { HostApi, ErrorCode } from "../../spec/host-api.js";
import { buildApi, hostError } from "./api.js";
import { parse, type Block, type Inline } from "../shared/markdown.js";

type Ret = { t: "ret"; id: number; ok: true; v: unknown } | { t: "ret"; id: number; ok: false; e: { code: ErrorCode; message: string } };
type Evt = { t: "evt"; ch: string; v: unknown };

/** Builds DOM from the safe Markdown tree. Content only ever becomes text nodes; no attribute comes from it except a link's title. */
function renderMarkdown(blocks: Block[], open: (href: string) => void): DocumentFragment {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K) => document.createElement(tag);
  const inl = (parent: HTMLElement, nodes: Inline[]): void => {
    for (const n of nodes) {
      switch (n.t) {
        case "text": parent.appendChild(document.createTextNode(n.v)); break;
        case "br": parent.appendChild(el("br")); break;
        case "code": { const c = el("code"); c.textContent = n.v; parent.appendChild(c); break; }
        case "strong": case "em": case "del": { const c = el(n.t === "strong" ? "strong" : n.t === "em" ? "em" : "del"); inl(c, n.c); parent.appendChild(c); break; }
        case "link": {
          // No href: a click never navigates the card view; the host opens the URL in the browser.
          const a = el("a");
          a.className = "md-link";
          a.title = n.href;
          a.tabIndex = 0;
          a.setAttribute("role", "link");
          const go = (e: Event) => { e.preventDefault(); open(n.href); };
          a.addEventListener("click", go);
          a.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go(e); });
          inl(a, n.c);
          parent.appendChild(a);
          break;
        }
      }
    }
  };
  const blk = (parent: Node, list: Block[]): void => {
    for (const b of list) {
      switch (b.t) {
        case "h": { const h = el(`h${Math.min(6, Math.max(1, b.level))}` as "h1"); inl(h, b.c); parent.appendChild(h); break; }
        case "p": { const p = el("p"); inl(p, b.c); parent.appendChild(p); break; }
        case "pre": { const pre = el("pre"); const c = el("code"); c.textContent = b.v; pre.appendChild(c); parent.appendChild(pre); break; }
        case "quote": { const q = el("blockquote"); blk(q, b.c); parent.appendChild(q); break; }
        case "hr": parent.appendChild(el("hr")); break;
        case "list": {
          const l = el(b.ordered ? "ol" : "ul");
          for (const item of b.items) { const li = el("li"); blk(li, item); l.appendChild(li); }
          parent.appendChild(l);
          break;
        }
        case "table": {
          const t = el("table"), thead = el("thead"), tbody = el("tbody"), hr = el("tr");
          for (const c of b.head) { const th = el("th"); inl(th, c); hr.appendChild(th); }
          thead.appendChild(hr);
          for (const row of b.rows) { const tr = el("tr"); for (const c of row) { const td = el("td"); inl(td, c); tr.appendChild(td); } tbody.appendChild(tr); }
          t.append(thead, tbody);
          parent.appendChild(t);
          break;
        }
      }
    }
  };
  const frag = document.createDocumentFragment();
  blk(frag, blocks);
  return frag;
}

function getPort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window || ev.data !== "dashboard:port" || !ev.ports[0]) return;
      window.removeEventListener("message", onMsg);
      resolve(ev.ports[0]);
    };
    window.addEventListener("message", onMsg);
    window.postMessage("dashboard:want-port", "*");
  });
}

async function main(): Promise<void> {
  const port = await getPort();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(v: unknown) => void>>();
  let worker: Worker | null = null;

  port.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as Ret | Evt;
    if (msg?.t === "ret") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.v); else p.reject(hostError(msg.e.code, msg.e.message));
    } else if (msg?.t === "evt") {
      for (const cb of listeners.get(msg.ch) ?? []) { try { cb(msg.v); } catch (e) { console.error(e); } }
      worker?.postMessage({ k: "evt", ch: msg.ch, v: msg.v });     // the worker filters what it subscribed to
    }
  };

  const call = (m: string, ...a: unknown[]): Promise<any> => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    port.postMessage({ t: "call", id, m, a });
  });
  const fire = (m: string, ...a: unknown[]): void => { call(m, ...a).catch(() => undefined); };

  // Theme (THEMES.md): the page starts with the host's variables; "host:theme" replaces them in place.
  const root = document.documentElement;
  const themeListeners = new Set<(t: ReturnType<HostApi["ui"]["theme"]>) => void>();
  const readTheme = (): ReturnType<HostApi["ui"]["theme"]> => {
    const cs = getComputedStyle(root);
    const g = (k: string) => cs.getPropertyValue(k).trim();
    return {
      mode: root.dataset.theme === "dark" ? "dark" : "light",
      id: root.dataset.themeId ?? "",
      colors: {
        background: g("--surface"), page: g("--page"), text: g("--fg"), muted: g("--muted"), border: g("--border"), accent: g("--accent"),
        ok: g("--ok"), warning: g("--warn"), error: g("--err"), low: g("--sev-low"), medium: g("--sev-medium"), high: g("--sev-high"), critical: g("--sev-critical"),
      },
      font: { family: root.dataset.themeFont ?? "", size: parseFloat(g("--font-size")) || 13, lineHeight: parseFloat(g("--line-height")) || 1.4 },
    };
  };
  const SAFE_VALUE = /^[#\w\s",.()-]{1,200}$/;
  listeners.set("host:theme", new Set([(v: unknown) => {
    const m = v as { vars?: Record<string, unknown>; info?: { id?: unknown; mode?: unknown; font?: { family?: unknown } } };
    if (!m?.vars || typeof m.vars !== "object") return;
    for (const [k, val] of Object.entries(m.vars)) if (/^--[a-z0-9-]{1,40}$/.test(k) && typeof val === "string" && SAFE_VALUE.test(val)) root.style.setProperty(k, val);
    const mode = m.info?.mode === "dark" ? "dark" : "light";
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    if (typeof m.info?.id === "string") root.dataset.themeId = m.info.id;
    if (typeof m.info?.font?.family === "string") root.dataset.themeFont = m.info.font.family;
    const t = readTheme();
    for (const cb of themeListeners) { try { cb(t); } catch (e) { console.error(e); } }
  }]));

  const config = (await call("card.config")) as Record<string, string | number | boolean>;
  const cardId = location.host;
  const fromWorker = new Set<(m: unknown) => void>();

  const ui: HostApi["ui"] = {
    markdown: (src) => renderMarkdown(parse(String(src)), (href) => {
      call("ui.openLink", href).catch((e: Error) => fire("ui.notify", `Could not open the link: ${e.message}`, "warning"));
    }),
    openLink: (url) => call("ui.openLink", url),
    confirm: (message, opts) => call("ui.confirm", message, opts ?? {}),
    notify: (message, level) => fire("ui.notify", message, level ?? "info"),
    setStatus: (status) => fire("ui.setStatus", { ...status }),
    setAccent: (accent) => fire("ui.setAccent", accent),
    theme: () => readTheme(),
    onThemeChange: (cb) => { themeListeners.add(cb); return () => { themeListeners.delete(cb); }; },
  };
  const api = buildApi({ call, listeners }, {
    cardId, config, ui,
    messaging: {
      send: (m) => worker?.postMessage({ k: "msg", v: m }),
      onMessage: (cb) => { fromWorker.add(cb); return () => fromWorker.delete(cb); },
    },
  });

  // worker.js runs as a Web Worker in this same view (same process, same sandbox, same CSP). Its
  // calls are relayed over this card's port, so it has this card's identity and nothing more.
  if (document.documentElement.dataset.worker === "1") {
    worker = new Worker(new URL("/__host/worker-runtime.js", location.href), { type: "module", name: "card-worker" });
    worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { k: string; id?: number; m?: string; a?: unknown[]; v?: unknown };
      if (m?.k === "msg") { for (const cb of fromWorker) { try { cb(m.v); } catch (e) { console.error(e); } } return; }
      if (m?.k !== "call" || typeof m.id !== "number" || typeof m.m !== "string" || !Array.isArray(m.a)) return;
      const id = m.id;
      if (m.m.startsWith("ui.")) { worker!.postMessage({ k: "ret", id, ok: false, e: { code: "InvalidArgument", message: "api.ui is only available in ui.js" } }); return; }
      call(m.m, ...m.a).then(
        (v) => worker!.postMessage({ k: "ret", id, ok: true, v }),
        (e: { code?: ErrorCode; message?: string }) => worker!.postMessage({ k: "ret", id, ok: false, e: { code: e?.code ?? "IOError", message: e?.message ?? String(e) } }),
      );
    };
    worker.onerror = (e) => { e.preventDefault(); ui.setStatus({ state: "error", message: `worker.js failed: ${e.message}` }); };
    worker.postMessage({ k: "init", cardId, config });
  }

  const report = (event: string, detail?: string) => fire("card.lifecycle", event, ...(detail === undefined ? [] : [detail.slice(0, 2000)]));
  window.addEventListener("error", (e) => report("uncaught", String(e.message || e.error)));
  window.addEventListener("unhandledrejection", (e) => report("uncaught", String((e.reason as Error)?.message ?? e.reason)));

  const el = document.getElementById("card")!;
  let mod: { mount?: (el: HTMLElement, api: HostApi) => unknown; unmount?: () => unknown } = {};
  if (!listeners.has("card:unmount")) listeners.set("card:unmount", new Set());
  listeners.get("card:unmount")!.add(() => {
    void (async () => {
      try { await mod.unmount?.(); report("unmounted"); } catch (e) { report("unmount-failed", (e as Error)?.message ?? String(e)); }
    })();
  });
  try {
    const uiUrl = new URL("/ui.js", location.href).href;   // a variable, so the bundler leaves it alone
    mod = (await import(uiUrl)) as typeof mod;
    if (typeof mod.mount !== "function") throw new Error("ui.js does not export mount(el, api)");
    await mod.mount(el, api);
    report("mounted");
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    report("mount-failed", msg);
    ui.setStatus({ state: "error", message: `The card failed to start: ${msg}` });
  }
}

void main();
