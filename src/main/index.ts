/**
 * Dashboard main process (ARCHITECTURE.md, "Process model").
 * Skeleton scope: the window, one isolated view per approved card, the broker with network
 * blocking, channel identity and lazy grants. No generator, validator, canvas or feeds yet.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from "electron";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuditLog } from "./audit.js";
import { Broker } from "./broker/broker.js";
import { ApprovalStore } from "./cards/approvals.js";
import { CardHost } from "./cards/card-host.js";
import { assertInstance, instancePaths, instanceRootFrom } from "./instance.js";
import { sysinfo } from "./services/sysinfo.js";
import { CardStorage } from "./services/storage.js";

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
let win: BrowserWindow | null = null;
let host: CardHost | null = null;
const lastLink = new Map<string, number>();

const BAR = 28, TOP = 36, CELL_W = 340, CELL_H = 260, GAP = 12;

function layout(): void {
  if (!win || !host) return;
  const width = win.getContentBounds().width;
  const cols = Math.max(1, Math.floor((width - GAP) / (CELL_W + GAP)));
  const entries = [
    ...[...host.cards.values()].map((c) => ({ cardId: c.cardId, name: c.name, state: c.status.state, message: c.notice ?? c.status.message, accent: c.accent, running: true, view: c.view })),
    ...[...host.stopped.entries()].map(([cardId, s]) => ({ cardId, name: s.name, state: s.status.state, message: s.status.message, accent: "neutral", running: false, view: null })),
  ].sort((a, b) => a.cardId.localeCompare(b.cardId));
  const frames = entries.map((e, i) => {
    const rect = { x: GAP + (i % cols) * (CELL_W + GAP), y: GAP + Math.floor(i / cols) * (CELL_H + GAP), width: CELL_W, height: CELL_H };
    e.view?.setBounds({ x: rect.x + 1, y: TOP + rect.y + BAR, width: rect.width - 2, height: rect.height - BAR - 1 });
    const { view: _v, ...rest } = e;
    return { ...rest, rect };
  });
  const running = host.cards.size;
  win.webContents.send("dashboard:state", { frames, summary: `${running} card${running === 1 ? "" : "s"} running` });
}

function createWindow(): BrowserWindow {
  // The Dashboard page loads only its own files.
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest((d, cb) => cb(d.url.startsWith("file://") || d.url.startsWith("devtools://") ? {} : { cancel: true }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);

  const w = new BrowserWindow({
    width: 1100, height: 760, title: "Dashboard", show: false,
    webPreferences: {
      preload: join(distDir, "preload", "dashboard.js"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools,
    },
  });
  w.once("ready-to-show", () => w.show());
  w.on("resize", layout);
  return w;
}

function buildMenu(): void {
  // Our own menu: no Reload, no DevTools accelerators that could act on a card view.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [{ label: "Quit", accelerator: "Ctrl+Q", click: () => app.quit() }] },
    { label: "Cards", submenu: [{ label: "Rescan cards", click: () => void host?.startAll() }] },
    { label: "Help", submenu: [{ label: "Open instance folder", click: () => void shell.openPath(paths.root) }] },
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
        await shell.openExternal(url.href);
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
    stopCard: (id, reason) => setImmediate(() => host?.stop(id, reason, "error")),
  }, { instanceRoot: paths.root, resolvePath: (p) => (p.startsWith("./") ? resolve(paths.root, p) : resolve(p)) });

  host = new CardHost({
    cardsDir: paths.cards,
    configDir: paths.config,
    runtimePath: join(distDir, "card-runtime", "runtime.js"),
    preloadPath: join(distDir, "preload", "card.js"),
    window: w,
    dashboardPid: () => w.webContents.getOSProcessId(),
    onChange: layout,
    devTools,
  }, approvals, broker, audit);

  // Main-process-only handle for the automated tests (Playwright evaluates in this process).
  (globalThis as Record<string, unknown>).__dashboard = { host, broker, audit, approvals, paths };

  ipcMain.on("dashboard:ready", (e) => { if (e.sender === w.webContents) layout(); });
  await w.loadFile(join(distDir, "renderer", "index.html"));
  await host.startAll();
  layout();
});

app.on("before-quit", () => host?.stopAll("the Dashboard quit"));
app.on("window-all-closed", () => app.quit());
