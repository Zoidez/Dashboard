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
import { app, ipcMain, MessageChannelMain, View, WebContentsView, type BaseWindow, type WebContents, type Session } from "electron";
import { promises as fsp, readFileSync, watch, type FSWatcher } from "node:fs";
import { join, posix } from "node:path";
import type { AuditLog } from "../audit.js";
import type { Broker, CardSession, SmokeMode } from "../broker/broker.js";
import { checkCardProcess, type ProcessRights } from "../security/process-check.js";
import { ApprovalStore, CARD_ID_RE, hashCardFolder, isCardFilePath, sha256, type ApprovalRecord } from "./approvals.js";
import { CARD_CSP, createCardSession } from "./card-session.js";
import { cardVars, themeInfo, type ThemeState } from "../../shared/theme.js";

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
  /** Plain parent view, sized to the visible part of the frame body; it clips the card view. */
  clip: View;
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
  /** The current theme (THEMES.md); card pages are built from it and follow its changes. */
  theme: () => ThemeState;
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
  private readonly smokes = new Map<number, { hello: (frameUrl: string) => void }>();
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

  /**
   * Places each running card's view at the rectangle the grid page reported (validated, clamped).
   * A card partly scrolled out of the grid stays shown, clipped to its visible part: the card view keeps
   * its full size inside a parent view whose bounds are the visible part. Hidden only when no part of
   * the frame body is visible (user request 2026-10-10: cull only completely hidden cards).
   */
  applyRects(rects: unknown): void {
    if (!Array.isArray(rects)) return;
    const { width: W, height: H } = this.opts.window.getContentBounds();
    const LIM = 100_000;
    for (const r of rects.slice(0, 500) as Array<Record<string, unknown>>) {
      const card = typeof r?.cardId === "string" ? this.cards.get(r.cardId) : undefined;
      if (!card || card.stopping) continue;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN);
      const c = (r.clip && typeof r.clip === "object" ? r.clip : {}) as Record<string, unknown>;
      const x = n(r.x), y = n(r.y), w = n(r.width), h = n(r.height);
      const cx = n(c.x), cy = n(c.y), cw = n(c.width), ch = n(c.height);
      // The visible part: the reported clip, cut to the frame body itself and to the window.
      const L = Math.max(cx, x, 0), T = Math.max(cy, y, 0), R = Math.min(cx + cw, x + w, W), B = Math.min(cy + ch, y + h, H);
      if ([x, y, w, h, cx, cy, cw, ch].some(Number.isNaN) || r.visible !== true || w < 20 || h < 20 || w > LIM || h > LIM
        || Math.abs(x) > LIM || Math.abs(y) > LIM || R - L < 1 || B - T < 1) {
        card.clip.setVisible(false);
        continue;
      }
      card.clip.setBounds({ x: L, y: T, width: R - L, height: B - T });
      card.view.setBounds({ x: x - L, y: y - T, width: w, height: h });
      card.view.setVisible(true);
      card.clip.setVisible(true);
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
    const clip = new View();                                 // clips the card view to the visible part of its frame
    clip.setVisible(false);
    clip.addChildView(view);

    let resolveChecked!: () => void, rejectChecked!: (e: Error) => void;
    const card: RunningCard = {
      cardId, name: manifest.name, manifest, approval, view, clip, session: ses, broker: null, pid: null, rights: null,
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

    this.opts.window.contentView.addChildView(clip);
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
      return new Response(indexHtml(this.opts.theme(), card.accent, this.hasWorker(card)), { headers: headers("text/html; charset=utf-8") });
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
    const smoke = this.smokes.get(sender.id);
    if (smoke) { smoke.hello(frameUrl); return; }
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
    try { card.clip.removeChildView(card.view); } catch { /* already removed */ }
    try { this.opts.window.contentView.removeChildView(card.clip); } catch { /* window gone */ }
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

  /**
   * VALIDATOR.md V5: runs a staged card once in the real card runtime with the broker in deny-all
   * mode. The files are served from memory (the exact bytes the validator read). Returns the errors.
   */
  async smoke(card: { cardId: string; manifest: { permissions: SmokeMode["declared"]; worker?: boolean; configSchema?: Manifest["configSchema"] }; files: Record<string, Buffer> },
    t: { mountMs?: number; settleMs?: number; unmountMs?: number } = {}): Promise<string[]> {
    const errors: string[] = [];
    const id = card.cardId;
    const since = new Date().toISOString();
    const config: Record<string, string | number | boolean> = {};
    for (const [k, f] of Object.entries(card.manifest.configSchema?.properties ?? {})) {
      if (typeof f.default === "string" || typeof f.default === "number" || typeof f.default === "boolean") config[k] = f.default;
    }
    const mode: SmokeMode = { declared: card.manifest.permissions, config, requests: [], statuses: [], lifecycle: [], storage: new Map() };
    const worker = card.manifest.worker === true && !!card.files["worker.js"];
    let ses: Session;
    try { ses = await createCardSession(id, this.audit); } catch (e) { return [`the card could not be isolated: ${(e as Error).message}`]; }
    const view = new WebContentsView({
      webPreferences: {
        session: ses, preload: this.opts.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
        webSecurity: true, webviewTag: false, backgroundThrottling: false, spellcheck: false, disableDialogs: true, devTools: false, navigateOnDragDrop: false,
      },
    });
    view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    view.setVisible(false);
    view.setBounds({ x: 0, y: 0, width: 480, height: 360 });
    this.opts.window.contentView.addChildView(view);
    const wc = view.webContents;
    let session: CardSession | null = null;
    let pid = 0;
    let checked: Promise<void> | null = null;
    const check = () => {
      if (!checked) checked = (async () => {
        pid = wc.getOSProcessId();
        const shared = pid === process.pid || pid === this.opts.dashboardPid() || [...this.cards.values()].some((c) => c.pid === pid);
        if (!pid || shared) throw new Error("the card would share a process");
        const r = checkCardProcess(pid);
        if (!r.ok) throw new Error(`card process fails the OS rights check: ${r.reason}`);
      })();
      return checked;
    };
    ses.protocol.handle("card", async (req) => {
      const url = new URL(req.url);
      const nf = () => new Response("not found", { status: 404, headers: { "content-security-policy": CARD_CSP } });
      const hdr = (type: string) => ({ "content-type": type, "content-security-policy": CARD_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" });
      if (url.host !== id) return nf();
      if (url.pathname === "/" || url.pathname === "/index.html") return new Response(indexHtml(this.opts.theme(), "neutral", worker), { headers: hdr("text/html; charset=utf-8") });
      try { await check(); } catch (e) { errors.push((e as Error).message); return nf(); }
      if (url.pathname === "/__host/runtime.js") return new Response(new Uint8Array(this.runtimeJs), { headers: hdr(MIME[".js"]) });
      if (url.pathname === "/__host/worker-runtime.js") return worker ? new Response(new Uint8Array(this.workerRuntimeJs), { headers: hdr(MIME[".js"]) }) : nf();
      const rel = decodeURIComponent(url.pathname.slice(1));
      if (!isCardFilePath(rel) || rel === "manifest.json" || rel === "DEVLOG.md" || !card.files[rel]) return nf();
      return new Response(new Uint8Array(card.files[rel]), { headers: hdr(MIME[rel.slice(rel.lastIndexOf("."))] ?? "application/octet-stream") });
    });
    const lifecycleSeen = (events: string[], ms: number) => new Promise<boolean>((res) => {
      const end = Date.now() + ms;
      const poll = () => { if (mode.lifecycle.some((l) => events.includes(l.event))) res(true); else if (Date.now() > end || wc.isDestroyed()) res(false); else setTimeout(poll, 50); };
      poll();
    });
    let navigated = false;
    wc.on("did-start-navigation", (d) => { if (d.isMainFrame && !d.isSameDocument && session) navigated = true; });
    let crashed = "";
    wc.on("render-process-gone", (_e, d) => { crashed = d.reason; });
    this.smokes.set(wc.id, {
      hello: (frameUrl) => {
        if (session || !frameUrl.startsWith(`card://${id}/`)) return;
        void check().then(() => {
          const { port1, port2 } = new MessageChannelMain();
          const s = this.broker.openSession(id, "smoke", port1, mode);
          session = s;
          port1.on("message", (e) => { void this.broker.handle(s, e.data); });
          port1.start();
          wc.postMessage("card:port", null, [port2]);
        }, () => undefined);
      },
    });
    try {
      try { await wc.loadURL(`card://${id}/`); } catch (e) { errors.push(`the card did not load: ${(e as Error).message}`); }
      const mounted = await lifecycleSeen(["mounted", "mount-failed"], t.mountMs ?? 10_000);
      if (!mounted) errors.push(`mount() did not finish within ${Math.round((t.mountMs ?? 10_000) / 1000)} s`);
      await new Promise((r) => setTimeout(r, t.settleMs ?? 1500));
      if (session) this.broker.emit(session, "card:unmount", null);
      if (mounted && !(await lifecycleSeen(["unmounted", "unmount-failed"], t.unmountMs ?? 3000))) errors.push("unmount() did not finish");
      for (const l of mode.lifecycle) {
        if (l.event === "mount-failed") errors.push(`mount() threw: ${l.detail}`);
        if (l.event === "unmount-failed") errors.push(`unmount() threw: ${l.detail}`);
        if (l.event === "uncaught") errors.push(`uncaught error: ${l.detail}`);
      }
      if (!mode.statuses.length) errors.push("the card never reported its state (api.ui.setStatus, generator rule 7)");
      for (const r of mode.requests) if (!r.covered) errors.push(`it tried something its manifest does not declare: ${r.what}`);
      const blocked = this.audit.entries({ cardId: id }).filter((e) => e.at >= since && (e.kind === "blocked-request" || e.kind === "browser-permission"));
      for (const b of blocked.slice(0, 8)) errors.push(`blocked attempt: ${b.detail}`);
      if (blocked.length > 8) errors.push(`... and ${blocked.length - 8} more blocked attempts`);
      if (navigated) errors.push("it tried to navigate the card view");
      if (crashed) errors.push(`its process ended (${crashed})`);
      const m = pid ? app.getAppMetrics().find((x) => x.pid === pid) : undefined;
      const limit = this.opts.limits?.memoryBytes ?? 512 * 1024 * 1024;
      if (m && (m.memory?.workingSetSize ?? 0) * 1024 > limit) errors.push(`it used more than ${Math.round(limit / 1048576)} MB of memory`);
    } finally {
      this.smokes.delete(wc.id);
      if (session) this.broker.endSession(session, "smoke test finished");
      try { this.opts.window.contentView.removeChildView(view); } catch { /* window gone */ }
      try { if (!wc.isDestroyed()) wc.close({ waitForBeforeUnload: false }); } catch { /* closed */ }
      try { ses.protocol.unhandle("card"); } catch { /* gone */ }
    }
    return [...new Set(errors)];
  }

  /** Revoke: removes the approval (written to disk first in memory), which also stops the card. */
  async revoke(cardId: string): Promise<void> {
    await this.approvals.revoke(cardId);
    this.audit.write(cardId, "permission-change", "approval revoked by you");
    this.stop(cardId, "approval revoked", "stopped");
  }

  /**
   * Grant: undoes a revoke and starts the card again. The start re-checks everything as usual: the
   * files on disk must still hash exactly to the approved version, or the card is refused.
   */
  async restoreApproval(cardId: string): Promise<boolean> {
    if (!CARD_ID_RE.test(cardId) || this.cards.has(cardId)) return false;
    if (!(await this.approvals.unrevoke(cardId))) return false;
    this.audit.write(cardId, "permission-change", "approval granted again by you");
    this.stopped.delete(cardId);
    return this.start(cardId);
  }

  /**
   * Switches approved permissions off or on (by index into the approval's permission list). Effective
   * immediately: the broker refuses switched-off permissions from the next call on and cuts what runs
   * under them now (permissionsChanged). The choice is saved with the approval and survives restarts.
   */
  async setPermissions(cardId: string, indices: readonly number[], on: boolean): Promise<void> {
    const rec = this.approvals.get(cardId);
    if (!rec || rec.revoked) return;
    const changed = await this.approvals.setOff(cardId, indices, !on);
    if (!changed.length) return;
    this.broker.permissionsChanged(cardId);
    for (const i of changed) this.audit.write(cardId, "permission-change", `${rec.permissions[i].type} #${i} switched ${on ? "on" : "off"} by you`);
    this.opts.onChange();
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
    if (!card || card.accent === accent) return;
    card.accent = accent;
    this.opts.onChange();
    // With the "background" severity method the card's own background shows its level.
    if (this.opts.theme().methods.includes("background")) this.pushTheme(card);
  }

  /** Sends the current theme to every running card (host to card only; THEMES.md rule 5). */
  applyTheme(): void {
    for (const card of this.cards.values()) this.pushTheme(card);
  }

  private pushTheme(card: RunningCard): void {
    if (!card.broker || card.stopping) return;
    const t = this.opts.theme();
    this.broker.emit(card.broker, "host:theme", { vars: cardVars(t, card.accent), info: themeInfo(t) });
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

/**
 * The card page. Its colours and font come from the theme (validated values only, host invariant 14);
 * the runtime updates them in place when the theme or the card's level changes.
 */
function indexHtml(theme: ThemeState, accent: string, worker: boolean): string {
  const vars = Object.entries(cardVars(theme, accent)).map(([k, v]) => `${k}:${v}`).join(";");
  return `<!doctype html>
<html data-theme="${theme.mode}" data-theme-id="${theme.id}" data-theme-font="${theme.font.family}"${worker ? ' data-worker="1"' : ""}><head><meta charset="utf-8">
<style>
:root{color-scheme:${theme.mode};${vars}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:var(--font-size)/var(--line-height) var(--font-family)}
#card{height:100%;box-sizing:border-box;padding:10px;overflow:auto}
.md-link{color:var(--link);text-decoration:underline;cursor:pointer}
#card pre{overflow:auto;padding:6px;border:1px solid var(--border);border-radius:4px}
#card table{border-collapse:collapse}#card th,#card td{border:1px solid var(--border);padding:2px 6px;text-align:left}
#card blockquote{margin:6px 0;padding-left:8px;border-left:3px solid var(--border)}
</style></head>
<body><div id="card"></div><script type="module" src="/__host/runtime.js"></script></body></html>`;
}
