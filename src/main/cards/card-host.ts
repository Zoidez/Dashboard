/**
 * Loads and runs cards (ARCHITECTURE.md, "The wrapper", "Approval is bound to a reviewed version",
 * "Audit, revoke, stop").
 *
 * Start of a card:
 *   1. its approval record must exist and not be revoked;
 *   2. the files on disk must hash exactly to the approval (and are hashed again whenever served);
 *   3. a fresh hardened session and a WebContentsView are created (own renderer process);
 *   4. before any card code is served, the host checks the view's OS process: not shared with the
 *      Dashboard or another card, Untrusted integrity, restricted token, in a job (process-check.ts);
 *   5. the card's preload asks for its port; the host hands over one end of a new MessageChannel and
 *      keeps the other end bound to a broker session. That binding is the card's identity.
 * Any end of the view (Stop, Revoke, crash, reload, navigation, close, quit) ends the broker session.
 */
import { app, ipcMain, MessageChannelMain, nativeTheme, WebContentsView, type BaseWindow, type WebContents, type Session } from "electron";
import { promises as fsp, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, posix } from "node:path";
import type { AuditLog } from "../audit.js";
import type { Broker, CardSession } from "../broker/broker.js";
import { checkCardProcess, type ProcessRights } from "../security/process-check.js";
import { ApprovalStore, CARD_ID_RE, hashCardFolder, isCardFilePath, sha256, type ApprovalRecord } from "./approvals.js";
import { CARD_CSP, createCardSession } from "./card-session.js";

export interface CardStatus { state: "starting" | "loading" | "ok" | "stale" | "error" | "stopped" | "refused"; message?: string; updatedAt?: string }

interface Manifest {
  id: string;
  name: string;
  version: string;
  worker?: boolean;
  schedule?: { intervalSeconds: number };
  defaultSize?: { w: number; h: number };
  configSchema?: { properties?: Record<string, { default?: unknown }> };
}

export interface RunningCard {
  cardId: string;
  name: string;
  manifest: Manifest;
  approval: ApprovalRecord;
  view: WebContentsView;
  session: Session;
  broker: CardSession | null;
  pid: number | null;
  rights: ProcessRights | null;
  processChecked: Promise<void>;
  runCheck?: () => void;
  status: CardStatus;
  notice?: string;
  accent: string;
  stopping: boolean;
  /** Background ticks (manifest.schedule): the timer, and the tick in flight (watchdog). */
  tickTimer?: NodeJS.Timeout;
  tickSeq: number;
  tickPending?: { seq: number; watchdog: NodeJS.Timeout };
}

export interface CardHostOptions {
  cardsDir: string;
  configDir: string;
  runtimePath: string;
  preloadPath: string;
  window: BaseWindow;
  /** OS process id of the Dashboard's own renderer. */
  dashboardPid: () => number;
  onChange: () => void;
  devTools: boolean;
  limits?: { memoryBytes?: number; cpuPercent?: number; cpuSeconds?: number; tickTimeoutMs?: number };
  workerRuntimePath: string;
}

const MIME: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2" };

export class CardHost {
  readonly cards = new Map<string, RunningCard>();
  /** Cards that were refused or stopped, with the reason (shown on the grid). */
  readonly stopped = new Map<string, { name: string; status: CardStatus }>();
  private readonly runtimeJs: Buffer;
  private readonly workerRuntimeJs: Buffer;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly starting = new Set<string>();
  private readonly sizes = new Map<string, { w: number; h: number }>();
  private dirWatcher: FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private readonly hot = new Map<string, number>();

  constructor(private readonly opts: CardHostOptions, private readonly approvals: ApprovalStore, private readonly broker: Broker, private readonly audit: AuditLog) {
    this.runtimeJs = readFileSync(opts.runtimePath);
    this.workerRuntimeJs = readFileSync(opts.workerRuntimePath);
    ipcMain.on("card:hello", (e) => this.onHello(e.sender, e.senderFrame?.url ?? ""));
  }

  /** Starts every installed card that has an approval. */
  async startAll(): Promise<void> {
    let ids: string[] = [];
    try { ids = (await fsp.readdir(this.opts.cardsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    for (const id of ids.sort()) if (!this.cards.has(id) && this.stopped.get(id)?.status.state !== "stopped") await this.start(id);
    this.startWatchdog();
    this.watchCardsFolder();
  }

  /** Hot-loading: a newly approved card folder starts without a restart; a removed folder stops its card. */
  private watchCardsFolder(): void {
    if (this.dirWatcher) return;
    try {
      this.dirWatcher = watch(this.opts.cardsDir, { persistent: false }, () => {
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => void this.rescanFolder(), 500);
      });
      this.dirWatcher.on("error", () => undefined);
    } catch { /* the folder is created at start; Rescan still works */ }
  }

  private async rescanFolder(): Promise<void> {
    let ids: string[] = [];
    try { ids = (await fsp.readdir(this.opts.cardsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
    for (const id of [...this.cards.keys()]) if (!ids.includes(id)) this.stop(id, "its folder was removed", "stopped");
    for (const id of [...this.stopped.keys()]) if (!ids.includes(id)) { this.stopped.delete(id); this.opts.onChange(); }
    for (const id of ids) if (CARD_ID_RE.test(id) && !this.cards.has(id) && !this.stopped.has(id)) await this.start(id);
  }

  /** The cell size a card starts with (manifest defaultSize). */
  defaultSize(cardId: string): { w: number; h: number } | undefined {
    return this.sizes.get(cardId);
  }

  /** Can the user start this stopped card again (still approved, not refused)? */
  startable(cardId: string): boolean {
    const s = this.stopped.get(cardId);
    if (!s || this.cards.has(cardId) || s.status.state === "refused") return false;
    const a = this.approvals.get(cardId);
    return !!a && !a.revoked;
  }

  /** Places each running card's view at the rectangle the grid page reported (validated, clamped). */
  applyRects(rects: unknown): void {
    if (!Array.isArray(rects)) return;
    const { width: W, height: H } = this.opts.window.getContentBounds();
    for (const r of rects.slice(0, 500) as Array<Record<string, unknown>>) {
      const card = typeof r?.cardId === "string" ? this.cards.get(r.cardId) : undefined;
      if (!card || card.stopping) continue;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN);
      const x = n(r.x), y = n(r.y), w = n(r.width), h = n(r.height);
      if ([x, y, w, h].some(Number.isNaN) || r.visible !== true || w < 20 || h < 20 || x < 0 || y < 0 || x + w > W || y + h > H) {
        card.view.setVisible(false);
        continue;
      }
      card.view.setBounds({ x, y, width: w, height: h });
      card.view.setVisible(true);
    }
  }

  private refuse(cardId: string, name: string, reason: string): void {
    this.audit.write(cardId, "card-refused", reason);
    this.stopped.set(cardId, { name, status: { state: "refused", message: reason } });
    this.opts.onChange();
  }

  async start(cardId: string): Promise<boolean> {
    if (!CARD_ID_RE.test(cardId)) { this.audit.write("_host", "card-refused", `invalid card folder name: ${cardId.slice(0, 60)}`); return false; }
    if (this.cards.has(cardId) || this.starting.has(cardId)) return true;
    this.starting.add(cardId);
    try { return await this.startInner(cardId); } finally { this.starting.delete(cardId); }
  }

  private async startInner(cardId: string): Promise<boolean> {
    const dir = join(this.opts.cardsDir, cardId);
    let approval: ApprovalRecord | null;
    try { approval = await this.approvals.load(cardId); }
    catch (e) { this.refuse(cardId, cardId, `approval record unreadable: ${(e as Error).message}`); return false; }
    if (!approval) { this.refuse(cardId, cardId, "not approved"); return false; }
    if (approval.revoked) { this.refuse(cardId, cardId, "approval revoked"); return false; }

    let files: Record<string, string>;
    try { files = await hashCardFolder(dir); }
    catch (e) { this.refuse(cardId, cardId, (e as Error).message); return false; }
    const same = Object.keys(files).length === Object.keys(approval.files).length && Object.entries(files).every(([p, h]) => approval!.files[p] === h);
    if (!same) {
      this.audit.write(cardId, "approval-mismatch", "files on disk differ from the approved files");
      this.refuse(cardId, cardId, "its files changed after approval");
      return false;
    }
    let manifest: Manifest;
    try { manifest = JSON.parse(await fsp.readFile(join(dir, "manifest.json"), "utf8")) as Manifest; }
    catch { this.refuse(cardId, cardId, "manifest.json is not valid JSON"); return false; }
    if (manifest.id !== cardId) { this.refuse(cardId, cardId, "manifest id does not match its folder"); return false; }
    if (manifest.defaultSize) this.sizes.set(cardId, manifest.defaultSize);

    let ses: Session;
    try { ses = await createCardSession(cardId, this.audit); }
    catch (e) { this.refuse(cardId, manifest.name, `could not isolate the card: ${(e as Error).message}`); return false; }

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: this.opts.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        backgroundThrottling: false,
        spellcheck: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        enableWebSQL: false,
        plugins: false,
        experimentalFeatures: false,
        devTools: this.opts.devTools,
        autoplayPolicy: "document-user-activation-required",
      },
    });
    view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    view.setVisible(false);                                  // shown once the grid reports where its frame is

    let resolveChecked!: () => void, rejectChecked!: (e: Error) => void;
    const card: RunningCard = {
      cardId, name: manifest.name, manifest, approval, view, session: ses, broker: null, pid: null, rights: null,
      processChecked: new Promise<void>((res, rej) => { resolveChecked = res; rejectChecked = rej; }),
      status: { state: "starting" }, accent: "neutral", stopping: false, tickSeq: 0,
    };
    card.processChecked.catch(() => undefined);
    this.cards.set(cardId, card);
    this.stopped.delete(cardId);

    ses.protocol.handle("card", (req) => this.serve(card, req));
    this.wireLifecycle(card);

    // The process check runs once the document is committed in its final renderer process.
    const runCheck = () => {
      if (card.pid !== null) return;
      try {
        const pid = view.webContents.getOSProcessId();
        const problem = this.sharedProcess(card, pid);
        if (problem) throw new Error(problem);
        const r = checkCardProcess(pid);
        card.pid = pid;
        card.rights = r.rights ?? null;
        if (!r.ok) throw new Error(`card process ${pid} fails the OS rights check: ${r.reason}`);
        resolveChecked();
      } catch (e) {
        rejectChecked(e as Error);
        this.stop(cardId, (e as Error).message, "refused");
      }
    };
    view.webContents.once("did-navigate", runCheck);
    card.runCheck = runCheck;

    this.opts.window.contentView.addChildView(view);
    this.opts.onChange();
    try { await view.webContents.loadURL(`card://${cardId}/`); }
    catch (e) { if (!card.stopping) this.stop(cardId, `could not load: ${(e as Error).message}`, "error"); return false; }
    return true;
  }

  private sharedProcess(card: RunningCard, pid: number): string | null {
    if (!pid) return "the card has no renderer process yet";
    if (pid === process.pid) return "the card runs in the Dashboard's main process";
    if (pid === this.opts.dashboardPid()) return "the card shares a process with the Dashboard";
    for (const other of this.cards.values()) {
      if (other !== card && other.pid === pid) return `the card shares process ${pid} with card ${other.cardId}`;
    }
    return null;
  }

  private async serve(card: RunningCard, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain", "content-security-policy": CARD_CSP } });
    if (url.host !== card.cardId || card.stopping) return notFound();
    const headers = (type: string) => ({ "content-type": type, "content-security-policy": CARD_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store", "cross-origin-opener-policy": "same-origin", "cross-origin-resource-policy": "same-origin" });

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(indexHtml(nativeTheme.shouldUseDarkColors, this.hasWorker(card)), { headers: headers("text/html; charset=utf-8") });
    }

    // No card code before the OS process check has passed.
    if (card.runCheck) card.runCheck();
    try { await card.processChecked; } catch { return notFound(); }

    if (url.pathname === "/__host/runtime.js") return new Response(new Uint8Array(this.runtimeJs), { headers: headers(MIME[".js"]) });
    if (url.pathname === "/__host/worker-runtime.js") {
      if (!this.hasWorker(card)) return notFound();
      return new Response(new Uint8Array(this.workerRuntimeJs), { headers: headers(MIME[".js"]) });
    }

    const rel = decodeURIComponent(url.pathname.slice(1));
    if (rel.includes("\\") || rel.includes("\0") || posix.normalize(rel) !== rel || !isCardFilePath(rel) || rel === "manifest.json" || rel === "DEVLOG.md") return notFound();
    const expected = card.approval.files[rel];
    if (!expected) return notFound();
    let data: Buffer;
    try { data = await fsp.readFile(join(this.opts.cardsDir, card.cardId, ...rel.split("/"))); } catch { return notFound(); }
    if (sha256(data) !== expected) {
      this.audit.write(card.cardId, "approval-mismatch", `${rel} changed after approval`);
      this.stop(card.cardId, "its files changed after approval", "refused");
      return notFound();
    }
    const ext = rel.slice(rel.lastIndexOf("."));
    return new Response(new Uint8Array(data), { headers: headers(MIME[ext] ?? "application/octet-stream") });
  }

  /** The preload asks for its port. Only the main frame of a live, checked card view gets one, once. */
  private onHello(sender: WebContents, frameUrl: string): void {
    const card = [...this.cards.values()].find((c) => !c.view.webContents.isDestroyed() && c.view.webContents.id === sender.id);
    if (!card || card.broker || card.stopping) return;
    if (!frameUrl.startsWith(`card://${card.cardId}/`)) return;
    void card.processChecked.then(() => {
      if (card.stopping || card.broker) return;
      const { port1, port2 } = new MessageChannelMain();
      const s = this.broker.openSession(card.cardId, card.approval.versionHash, port1);
      card.broker = s;
      port1.on("message", (e) => { void this.broker.handle(s, e.data); });
      port1.on("close", () => this.broker.endSession(s, "port closed"));
      port1.start();
      sender.postMessage("card:port", null, [port2]);
      this.setStatus(card.cardId, { state: "loading" });
      const every = card.manifest.schedule?.intervalSeconds;
      if (this.hasWorker(card) && typeof every === "number" && every >= 60) card.tickTimer = setInterval(() => this.tick(card.cardId), every * 1000);
    }, () => undefined);
  }

  private wireLifecycle(card: RunningCard): void {
    const wc = card.view.webContents;
    // CSP refusals happen inside the renderer, before the session's request filter sees anything.
    // Chromium reports them on the console; log them as blocked requests. (A card can add fake
    // lines of this kind; they only clutter its own log.)
    let cspLogged = 0;
    wc.on("console-message", (e) => {
      const msg = e.message ?? "";
      if (/Content Security Policy/.test(msg) && cspLogged++ < 200) this.audit.write(card.cardId, "blocked-request", `CSP: ${msg.slice(0, 300)}`);
    });
    wc.on("render-process-gone", (_e, d) => this.stop(card.cardId, `the card's process ended (${d.reason})`, "error"));
    wc.on("did-start-navigation", (d) => {
      // The first navigation loads the card. Any later one (reload, location change) ends it.
      if (d.isMainFrame && !d.isSameDocument && card.broker) this.stop(card.cardId, "the card reloaded or navigated", "stopped");
    });
    wc.on("destroyed", () => { if (card.broker) this.broker.endSession(card.broker, "view destroyed"); });
  }

  /** Stop: kills the view at once and drops its grants (broker session end). */
  stop(cardId: string, reason: string, state: CardStatus["state"] = "stopped"): void {
    const card = this.cards.get(cardId);
    if (!card || card.stopping) return;
    card.stopping = true;
    if (card.tickTimer) clearInterval(card.tickTimer);
    if (card.tickPending) clearTimeout(card.tickPending.watchdog);
    if (card.broker) this.broker.endSession(card.broker, reason);
    this.cards.delete(cardId);
    this.stopped.set(cardId, { name: card.name, status: { state, message: reason } });
    if (state === "refused") this.audit.write(cardId, "card-refused", reason);
    try { this.opts.window.contentView.removeChildView(card.view); } catch { /* window gone */ }
    try { if (!card.view.webContents.isDestroyed()) card.view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already closed */ }
    try { void card.session.protocol.unhandle("card"); } catch { /* session gone */ }
    this.opts.onChange();
  }

  private hasWorker(card: RunningCard): boolean {
    return card.manifest.worker === true && !!card.approval.files["worker.js"];
  }

  /** Sends one tick to the card's worker. A tick still running after the limit (60 s) stops the card. */
  tick(cardId: string): boolean {
    const card = this.cards.get(cardId);
    if (!card || !card.broker || card.stopping || !this.hasWorker(card)) return false;
    if (card.tickPending) return false;                       // the previous tick has not finished: skip
    const seq = ++card.tickSeq;
    const limit = this.opts.limits?.tickTimeoutMs ?? 60_000;
    card.tickPending = {
      seq,
      watchdog: setTimeout(() => {
        this.audit.write(cardId, "card-flagged", `tick ${seq} ran longer than ${Math.round(limit / 1000)} s`);
        this.stop(cardId, `its background tick ran longer than ${Math.round(limit / 1000)} seconds`, "error");
      }, limit),
    };
    this.broker.emit(card.broker, "card:tick", seq);
    return true;
  }

  tickDone(cardId: string, seq: number): void {
    const card = this.cards.get(cardId);
    if (!card?.tickPending || card.tickPending.seq !== seq) return;
    clearTimeout(card.tickPending.watchdog);
    card.tickPending = undefined;
  }

  /** Revoke: removes the approval (written to disk first in memory), which also stops the card. */
  async revoke(cardId: string): Promise<void> {
    await this.approvals.revoke(cardId);
    this.stop(cardId, "approval revoked", "stopped");
  }

  stopAll(reason: string): void {
    for (const id of [...this.cards.keys()]) this.stop(id, reason);
    if (this.watchdog) clearInterval(this.watchdog);
    this.dirWatcher?.close();
    if (this.rescanTimer) clearTimeout(this.rescanTimer);
  }

  setStatus(cardId: string, s: Omit<CardStatus, "state"> & { state: string }): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    card.status = s as CardStatus;
    this.opts.onChange();
  }

  /** A short notice in the card's status line; it clears after 8 seconds. */
  notify(cardId: string, message: string, level: string): void {
    const card = this.cards.get(cardId);
    if (!card) return;
    const notice = level === "info" ? message : `${level}: ${message}`;
    card.notice = notice;
    this.opts.onChange();
    setTimeout(() => { if (card.notice === notice) { card.notice = undefined; this.opts.onChange(); } }, 8000);
  }

  setAccent(cardId: string, accent: string): void {
    const card = this.cards.get(cardId);
    if (card) { card.accent = accent; this.opts.onChange(); }
  }

  config(cardId: string): Record<string, string | number | boolean> {
    const card = this.cards.get(cardId);
    const out: Record<string, string | number | boolean> = {};
    for (const [k, f] of Object.entries(card?.manifest.configSchema?.properties ?? {})) {
      if (typeof f.default === "string" || typeof f.default === "number" || typeof f.default === "boolean") out[k] = f.default;
    }
    try {
      const saved = JSON.parse(readFileSync(join(this.opts.configDir, cardId, "config.json"), "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(saved)) if (k in out && typeof v === typeof out[k]) out[k] = v as string | number | boolean;
    } catch { /* no saved config */ }
    return out;
  }

  /** Resource limits: memory and sustained CPU, per card process (ARCHITECTURE.md 1). */
  private startWatchdog(): void {
    if (this.watchdog) return;
    const memLimit = this.opts.limits?.memoryBytes ?? 512 * 1024 * 1024;
    const cpuLimit = this.opts.limits?.cpuPercent ?? 90;
    const cpuSeconds = this.opts.limits?.cpuSeconds ?? 30;
    const every = 5;
    this.watchdog = setInterval(() => {
      const metrics = app.getAppMetrics();
      for (const card of [...this.cards.values()]) {
        if (card.pid === null) continue;
        const m = metrics.find((x) => x.pid === card.pid);
        if (!m) continue;
        const ws = (m.memory?.workingSetSize ?? 0) * 1024;
        if (ws > memLimit) {
          this.audit.write(card.cardId, "card-flagged", `memory ${Math.round(ws / 1048576)} MB over the ${Math.round(memLimit / 1048576)} MB limit`);
          this.stop(card.cardId, "used more memory than the host allows", "error");
          continue;
        }
        const hotFor = m.cpu.percentCPUUsage > cpuLimit ? (this.hot.get(card.cardId) ?? 0) + every : 0;
        this.hot.set(card.cardId, hotFor);
        if (hotFor >= cpuSeconds) {
          this.audit.write(card.cardId, "card-flagged", `CPU over ${cpuLimit}% for ${hotFor} s`);
          this.stop(card.cardId, "kept the processor busy for too long", "error");
        }
      }
    }, every * 1000);
  }
}

function indexHtml(dark: boolean, worker: boolean): string {
  return `<!doctype html>
<html data-theme="${dark ? "dark" : "light"}"${worker ? ' data-worker="1"' : ""}><head><meta charset="utf-8">
<style>
:root{color-scheme:light;--bg:#ffffff;--fg:#1d2330;--muted:#5b6475;--border:#d8dce3;--link:#0b57c2;
--sev-none-bg:#ffffff;--sev-none-fg:#1d2330;--sev-low-bg:#e3e9f0;--sev-low-fg:#1f2d3d;--sev-medium-bg:#fff1cc;--sev-medium-fg:#4a3500;
--sev-high-bg:#ffe0d1;--sev-high-fg:#5c1d00;--sev-critical-bg:#fbd5d2;--sev-critical-fg:#5f0f0a}
:root[data-theme=dark]{color-scheme:dark;--bg:#1b1f27;--fg:#e6e9ef;--muted:#a3abba;--border:#363c48;--link:#8ab4ff;
--sev-none-bg:#1b1f27;--sev-none-fg:#e6e9ef;--sev-low-bg:#26313d;--sev-low-fg:#dbe5f0;--sev-medium-bg:#3d3010;--sev-medium-fg:#ffe7a8;
--sev-high-bg:#45230f;--sev-high-fg:#ffd2bb;--sev-critical-bg:#4a1714;--sev-critical-fg:#ffd0cc}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:13px/1.4 "Segoe UI",system-ui,sans-serif}
#card{height:100%;box-sizing:border-box;padding:10px;overflow:auto}
.md-link{color:var(--link);text-decoration:underline;cursor:pointer}
#card pre{overflow:auto;padding:6px;border:1px solid var(--border);border-radius:4px}
#card table{border-collapse:collapse}#card th,#card td{border:1px solid var(--border);padding:2px 6px;text-align:left}
#card blockquote{margin:6px 0;padding-left:8px;border-left:3px solid var(--border)}
</style></head>
<body><div id="card"></div><script type="module" src="/__host/runtime.js"></script></body></html>`;
}
