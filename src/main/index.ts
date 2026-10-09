/**
 * Dashboard main process (ARCHITECTURE.md, "Process model").
 * The window and its grid, File > Options, the tray, one isolated view per approved card, the
 * broker, the file helper and the feeds. Not yet: the generator, validator and approval canvas.
 */
import { app, BrowserWindow, dialog, Menu, protocol, session, shell as electronShell } from "electron";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { Broker } from "./broker/broker.js";
import { ApprovalStore } from "./cards/approvals.js";
import { CardHost } from "./cards/card-host.js";
import { assertInstance, instancePaths, instanceRootFrom } from "./instance.js";
import { sysinfo } from "./services/sysinfo.js";
import { CardStorage } from "./services/storage.js";
import { FileHelper } from "./services/files.js";
import { OptionsStore } from "./options.js";
import { FeedService } from "./reports/feeds.js";
import { feedCard, feedCardId, installCard, reviewText, type Decide } from "./cards/install.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { GeneratorGate, parseApprovals } from "./generator/cli-gate.js";
import { buildHash, hostSuiteProblem } from "./generator/host-suite.js";
import { GeneratorPipeline } from "./generator/pipeline.js";
import { loadPromptDocs, type PromptDocs } from "./generator/prompt.js";
import { ApprovalCanvas } from "./ui/canvas.js";
import { installGenerated } from "./cards/install.js";
import { streamsOf } from "../filehelper/win32.js";
import type { GeneratorView } from "../shared/ui-state.js";
import { LayoutStore } from "./layout.js";
import { Shell } from "./ui/shell.js";
import { verifyCli } from "./generator/cli-gate.js";

// ---------- before ready: instance paths, scheme, sandbox ----------

const root = instanceRootFrom(process.argv, app.isPackaged, process.execPath, process.cwd());
assertInstance(root);
const paths = instancePaths(root);
for (const d of [paths.data, paths.cards, paths.approvals, paths.audit, paths.config, paths.electron]) mkdirSync(d, { recursive: true });
app.setPath("userData", paths.electron);
app.setPath("sessionData", join(paths.electron, "session"));
app.setPath("logs", join(paths.electron, "logs"));
app.setPath("crashDumps", join(paths.electron, "crashes"));

protocol.registerSchemesAsPrivileged([
  { scheme: "card", privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false, codeCache: false, allowServiceWorkers: false, bypassCSP: false } },
]);
app.enableSandbox();

const devTools = process.argv.includes("--dev-tools");
const distDir = resolve(__dirname, "..");

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ---------- every web contents: no navigation, no windows, no webviews ----------

app.on("web-contents-created", (_e, wc) => {
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  wc.on("will-redirect", (e) => e.preventDefault());
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => { if (!e.isMainFrame) e.preventDefault(); });
});

// ---------- host state ----------

const audit = new AuditLog(paths.audit);
const approvals = new ApprovalStore(paths.approvals);
const storage = new CardStorage(paths.config);
const files = new FileHelper(join(distDir, "filehelper", "main.js"));
const options = new OptionsStore(join(paths.config, "options.json"));
const feeds = new FeedService(paths.reports, () => options.feeds, audit);
let win: BrowserWindow | null = null;
let host: CardHost | null = null;
const lastLink = new Map<string, number>();

let shell: Shell | null = null;
const layoutStore = new LayoutStore(join(paths.data, "layout.json"));

// ---------- the generator (New card) ----------

const approvalsList = join(paths.generator, "cli-approvals.json");
const approvalsLegacy = join(paths.generator, "cli-approval.json");

/**
 * The CLI build in use (ARCHITECTURE.md: builds side by side in data/vendor/claude/<version>-<sha12>/).
 * Options may name one; otherwise the newest approved build that is installed; otherwise the newest folder.
 */
function activeBuild(): string | null {
  let folders: string[] = [];
  try { folders = readdirSync(join(paths.vendor, "claude"), { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+-[0-9a-f]{12}$/i.test(d.name)).map((d) => d.name); } catch { return null; }
  if (!folders.length) return null;
  let records: Array<{ status: string; sha256: string; decidedAt: string }> = [];
  for (const f of [approvalsList, approvalsLegacy]) { try { records = parseApprovals(readFileSync(f, "utf8")); break; } catch { /* next */ } }
  const approved = records.filter((r) => r.status === "approved").sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  for (const r of approved) { const f = folders.find((x) => x.toLowerCase().endsWith(r.sha256.slice(0, 12).toLowerCase())); if (f) return f; }
  return folders.sort().reverse()[0];
}

let build = activeBuild();
const gateOpts = () => ({
  exePath: join(paths.vendor, "claude", build ?? "none", "claude.exe"),
  approvalPath: approvalsList, legacyApprovalPath: approvalsLegacy, buildFolder: build ?? undefined,
});
const gate = new GeneratorGate(gateOpts());
const currentBuildHash = buildHash(distDir);
const spikePath = join(app.getAppPath(), "spikes", "spike1-cli.ps1");
let testing = false;
let pipeline: GeneratorPipeline | null = null;
let canvas: ApprovalCanvas | null = null;
const readGen = (f: string) => readFileSync(join(distDir, "generator", f), "utf8");
let promptDocs: PromptDocs | null = null;

async function gateState(): Promise<{ ok: boolean; version?: string; reason?: string; code?: string }> {
  const r = await verifyCli(gateOpts());
  return r.ok ? { ok: true, version: r.version } : { ok: false, reason: r.reason, code: r.code };
}

function generatorView(): GeneratorView {
  const p = pipeline?.current ?? { phase: "idle" as const };
  const targets = host ? [
    ...[...host.cards.values()].map((c) => ({ cardId: c.cardId, name: c.name })),
    ...[...host.stopped.entries()].filter(([id]) => host!.startable(id)).map(([cardId, s]) => ({ cardId, name: s.name })),
  ].filter((t) => !t.cardId.startsWith("feed-")).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return { ...p, build: build ?? undefined, testing, canTest: existsSync(spikePath), targets };
}

/** "Test the new CLI version": the host runs its own security test in a visible PowerShell window. */
function testCli(): void {
  if (testing || !existsSync(spikePath)) return;
  const version = build?.split("-")[0];
  const child = spawn("powershell.exe", ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", spikePath, ...(version ? ["-Version", version] : [])], {
    cwd: dirname(dirname(spikePath)), detached: true, stdio: "ignore", windowsHide: false,
  });
  testing = true;
  audit.write("_host", "session-start", `CLI security test started for ${version ?? "the latest version"}`);
  shell?.push();
  child.once("exit", () => { testing = false; build = activeBuild(); gate.retarget(gateOpts()); void pipeline?.refreshGate().then(() => shell?.push()); });
  child.unref();
}

function createWindow(): BrowserWindow {
  // The Dashboard page loads only its own files.
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((d, cb) => cb(d.url.startsWith("file://") || d.url.startsWith("devtools://") ? {} : { cancel: true }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  const w = new BrowserWindow({
    width: 1180, height: 800, title: "Dashboard", show: false, icon: join(distDir, "assets", "icon.png"),
    webPreferences: {
      preload: join(distDir, "preload", "dashboard.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools,
    },
  });
  w.once("ready-to-show", () => w.show());
  return w;
}

/** Interim approval dialog (the approval canvas replaces it). Default button: Cancel. */
const askUser: Decide = async (r) => {
  if (!win) return false;
  const red = r.display.red;
  const res = await dialog.showMessageBox(win, {
    type: red || r.display.yellow ? "warning" : "question",
    title: "Approve card",
    message: `Install the card "${r.name}"? It asks for:`,
    detail: reviewText(r) + (red ? "\n\nThis card has RED markings. Do you want to allow this permission combination?" : ""),
    buttons: red ? ["No", "Yes, only now"] : ["Cancel", "Approve"],
    defaultId: 0, cancelId: 0, noLink: true,
  });
  return res.response === 1;
};

/** Installs a watch-feed card for every configured feed that has none yet. */
async function installFeedCards(decide: Decide = askUser): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of options.feeds) {
    const id = feedCardId(f);
    if (existsSync(join(paths.cards, id))) { out[id] = "already installed"; continue; }
    try {
      const r = await installCard(await feedCard(f, join(distDir, "cards")), { cards: paths.cards, approvals: paths.approvals, config: paths.config }, (t) => options.feed(t)?.name ?? t, decide);
      out[id] = r;
      if (r === "installed") await host?.start(id);
    } catch (e) { out[id] = `failed: ${(e as Error).message}`; }
  }
  return out;
}

function buildMenu(): void {
  // Our own menu: no Reload, no DevTools accelerators that could act on a card view.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Options…", accelerator: "Ctrl+,", click: () => shell?.openOptions() },
      { type: "separator" },
      { label: "Quit", accelerator: "Ctrl+Q", click: () => app.quit() },
    ] },
    { label: "Cards", submenu: [
      { label: "Install watch-feed cards…", click: () => void installFeedCards() },
      { label: "Rescan cards", click: () => void host?.startAll() },
    ] },
    { label: "Help", submenu: [{ label: "Open instance folder", click: () => void electronShell.openPath(paths.root) }] },
  ]));
}

app.whenReady().then(async () => {
  buildMenu();
  win = createWindow();
  const w = win;
  const broker = new Broker(approvals, audit, {
    config: (id) => host?.config(id) ?? {},
    sysinfo: (field) => sysinfo(field),
    ui: {
      setStatus: (id, s) => host?.setStatus(id, s as never),
      notify: (id, message, level) => host?.notify(id, message, level),
      setAccent: (id, a) => host?.setAccent(id, a),
      openLink: async (id, url) => {
        const now = Date.now();
        if (now - (lastLink.get(id) ?? 0) < 2000) throw new Error("links can be opened at most every 2 seconds");
        lastLink.set(id, now);
        await electronShell.openExternal(url.href);
      },
      confirm: async (id, message, opts) => {
        const name = host?.cards.get(id)?.name ?? id;
        const r = await dialog.showMessageBox(w, {
          type: opts.danger ? "warning" : "question", title: `${name} asks`, message,
          buttons: [opts.confirmLabel ?? "OK", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
        });
        return r.response === 0;
      },
    },
    storage: {
      get: (id, k) => storage.get(id, k),
      set: (id, k, v) => storage.set(id, k, v),
      remove: (id, k) => storage.remove(id, k),
    },
    files: { call: (op, args, ctx) => files.call(op, args, ctx), watch: (p, ctx, cb) => files.watch(p, ctx, cb) },
    reports: { isFeed: (t) => feeds.isFeed(t), state: (t) => feeds.state(t), history: (t, n) => feeds.historyOf(t, n), onChange: (t, cb) => feeds.onChange(t, cb) },
    tickDone: (id, seq) => host?.tickDone(id, seq),
    stopCard: (id, reason) => setImmediate(() => host?.stop(id, reason, "error")),
  }, { instanceRoot: paths.root, resolvePath: (p) => (p.startsWith("./") ? resolve(paths.root, p) : resolve(p)) });

  host = new CardHost({
    cardsDir: paths.cards,
    configDir: paths.config,
    runtimePath: join(distDir, "card-runtime", "runtime.js"),
    workerRuntimePath: join(distDir, "card-runtime", "worker-runtime.js"),
    preloadPath: join(distDir, "preload", "card.js"),
    window: w,
    dashboardPid: () => w.webContents.getOSProcessId(),
    onChange: () => shell?.push(),
    devTools,
  }, approvals, broker, audit);

  canvas = new ApprovalCanvas({ parent: () => win, distDir, approvalsDir: paths.approvals, taskName: (t) => options.feed(t)?.name ?? t, devTools });
  const cv = canvas;
  pipeline = new GeneratorPipeline({
    gate, checkGate: () => verifyCli(gateOpts()),
    hostSuiteProblem: () => hostSuiteProblem(join(paths.generator, "host-suite.json"), currentBuildHash),
    paths, distDir,
    docs: () => (promptDocs ??= loadPromptDocs(join(distDir, "generator"))),
    manifestSchema: () => JSON.parse(readGen("manifest.schema.json")) as object,
    hostApiDts: () => readGen("host-api.d.ts"),
    feedTaskIds: () => options.feeds.map((f) => f.taskId),
    installedInfo: (id) => { const a = approvals.get(id); return a && !a.revoked ? { version: a.version, permissions: a.permissions, files: a.files } : null; },
    smoke: (card) => host!.smoke(card),
    streamsOf,
    review: (r) => cv.review(r),
    install: async (card, perms, kind) => {
      await installGenerated(card, perms, kind, { cards: paths.cards, approvals: paths.approvals, config: paths.config }, (id) => host?.stop(id, "being updated", "stopped"));
      await approvals.load(card.cardId);
      host?.stopped.delete(card.cardId);
      await host?.start(card.cardId);
    },
    audit,
  });
  const pl = pipeline;
  pl.on("state", () => shell?.push());

  shell = new Shell({
    win: w, host: () => host, approvals, audit, options, feeds, layout: layoutStore, gate: gateState,
    distDir, reportsDir: paths.reports, devTools,
    setLoginItem: (open) => app.setLoginItemSettings({ openAtLogin: open, path: process.execPath }),
    generator: {
      view: generatorView,
      start: (req) => {
        const target = req.target === "new" ? { kind: "new" as const } : { kind: "update" as const, cardId: req.target };
        pl.start({ text: req.text, target, preset: req.target === "new" ? req.preset : null }).catch((e: Error) => audit.write("_host", "denied", `generation refused: ${e.message}`));
      },
      stop: () => pl.stop(),
      testCli,
    },
  });
  shell.createTray(join(distDir, "assets", "icon.png"));
  if (options.general.startWithWindows) shell.applyLoginItem();

  // Main-process-only handle for the automated tests (Playwright evaluates in this process).
  (globalThis as Record<string, unknown>).__dashboard = { host, broker, audit, approvals, paths, files, feeds, options, installFeedCards, shell, layout: layoutStore, win: w, pipeline: pl, canvas: cv, gate };

  await w.loadFile(join(distDir, "renderer", "index.html"));
  await feeds.start();
  await host.startAll();
  if (existsSync(gateOpts().exePath)) gate.startWatching();
  void pl.refreshGate();
  shell.push();
});

app.on("before-quit", () => { pipeline?.stop(); gate.abortAll("the Dashboard quit"); gate.stopWatching(); host?.stopAll("the Dashboard quit"); files.stop(); feeds.stop(); shell?.destroyTray(); });
app.on("window-all-closed", () => app.quit());
app.on("second-instance", () => shell?.showWindow());
