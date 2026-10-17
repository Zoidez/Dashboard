/**
 * The Dashboard's own UI in the main process: grid state and view placement, card actions,
 * File > Options, the tray icon, close-to-tray and start-with-Windows.
 * Every message from a page is checked to come from that page's own window and is validated here.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { AuditLog } from "../audit.js";
import { offSet, type ApprovalRecord, type ApprovalStore } from "../cards/approvals.js";
import { categoryOf, PERMISSION_CATEGORIES, type PermissionCategory } from "../broker/permissions.js";
import type { CardHost } from "../cards/card-host.js";
import { display } from "../cards/permission-lines.js";
import { LayoutStore, clampSize } from "../layout.js";
import type { OptionsStore } from "../options.js";
import type { FeedService } from "../reports/feeds.js";
import { THEMES } from "../../shared/theme.js";
import type { CardAction, CardFrame, CategoryState, DashboardState, GeneratorView, NewCardRequest, OptionsPatch, OptionsState } from "../../shared/ui-state.js";

export interface ShellDeps {
  win: BrowserWindow;
  host: () => CardHost | null;
  approvals: ApprovalStore;
  audit: AuditLog;
  options: OptionsStore;
  feeds: FeedService;
  layout: LayoutStore;
  gate: () => Promise<{ ok: boolean; version?: string; reason?: string; code?: string }>;
  distDir: string;
  reportsDir: string;
  devTools: boolean;
  /** The theme setting changed: re-send the theme to every page and card. */
  themeChanged: () => void;
  /** Writes the Windows sign-in entry; only called for the packaged app. */
  setLoginItem: (open: boolean) => void;
  /** The New card: state, and what its buttons do. */
  generator: {
    view: () => GeneratorView;
    start: (req: NewCardRequest) => void;
    stop: () => void;
    testCli: () => void;
  };
}

const ACTIONS = new Set<CardAction>(["stop", "start", "revoke", "grant"]);
const CATEGORIES = new Set<string>(PERMISSION_CATEGORIES);

/** Per-group summary of an approval's permissions, for the grid's permission menu. */
function categorySummary(rec: ApprovalRecord): Record<PermissionCategory, { state: CategoryState; count: number }> {
  const off = offSet(rec);
  const out = Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, { state: "none" as CategoryState, count: 0 }])) as Record<PermissionCategory, { state: CategoryState; count: number }>;
  const on = Object.fromEntries(PERMISSION_CATEGORIES.map((c) => [c, 0])) as Record<PermissionCategory, number>;
  rec.permissions.forEach((p, i) => { const c = categoryOf(p); out[c].count++; if (!off.has(i)) on[c]++; });
  for (const c of PERMISSION_CATEGORIES) {
    const n = out[c].count;
    out[c].state = n === 0 ? "none" : on[c] === n ? "on" : on[c] === 0 ? "off" : "mixed";
  }
  return out;
}

export class Shell {
  private optionsWin: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private quitting = false;
  private pushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly d: ShellDeps) {
    const w = d.win;
    const fromGrid = (e: IpcMainEvent) => e.sender === w.webContents;
    ipcMain.on("dashboard:ready", (e) => { if (fromGrid(e)) this.push(); });
    ipcMain.on("dashboard:rects", (e, rects) => { if (fromGrid(e)) d.host()?.applyRects(rects); });
    ipcMain.on("dashboard:layout", (e, update) => {
      if (!fromGrid(e) || typeof update !== "object" || update === null) return;
      d.layout.apply(update);
      d.layout.save();
      this.push();
    });
    ipcMain.on("dashboard:card-action", (e, cardId, action) => { if (fromGrid(e)) void this.cardAction(cardId, action, w); });
    // The grid's permission menu switches a whole group (web, files, system, reports) of one card.
    ipcMain.on("dashboard:card-permission", (e, cardId, category, on) => {
      if (!fromGrid(e) || typeof cardId !== "string" || typeof category !== "string" || !CATEGORIES.has(category) || typeof on !== "boolean") return;
      const rec = d.approvals.get(cardId);
      if (!rec) return;
      const indices = rec.permissions.map((p, i) => (categoryOf(p) === category ? i : -1)).filter((i) => i >= 0);
      void d.host()?.setPermissions(cardId, indices, on).then(() => this.push());
    });
    ipcMain.on("dashboard:open-options", (e) => { if (fromGrid(e)) this.openOptions(); });
    // Host invariant 1: a generation starts only from the text typed into the New card, in the grid window.
    ipcMain.on("new:start", (e, req) => {
      if (!fromGrid(e) || typeof req !== "object" || req === null) return;
      const r = req as Record<string, unknown>;
      if (typeof r.text !== "string" || r.text.length > 20_000 || typeof r.target !== "string" || (r.preset !== null && r.preset !== "watch-feed")) return;
      d.generator.start({ text: r.text, target: r.target, preset: r.preset });
    });
    ipcMain.on("new:stop", (e) => { if (fromGrid(e)) d.generator.stop(); });
    ipcMain.on("new:test-cli", (e) => { if (fromGrid(e)) d.generator.testCli(); });

    const fromOptions = (e: IpcMainInvokeEvent) => !!this.optionsWin && e.sender === this.optionsWin.webContents;
    ipcMain.handle("options:get", async (e) => (fromOptions(e) ? this.optionsState() : null));
    ipcMain.handle("options:set", async (e, patch) => { if (fromOptions(e)) this.applyPatch(patch); return fromOptions(e) ? this.optionsState() : null; });
    ipcMain.handle("options:card-action", async (e, cardId, action) => {
      if (!fromOptions(e)) return null;
      await this.cardAction(cardId, action, this.optionsWin!);
      return this.optionsState();
    });
    // Options > Cards > Details > Permissions: one permission, by its index in the approval.
    ipcMain.handle("options:card-permission", async (e, cardId, index, on) => {
      if (!fromOptions(e)) return null;
      if (typeof cardId === "string" && typeof index === "number" && Number.isInteger(index) && typeof on === "boolean") {
        await this.d.host()?.setPermissions(cardId, [index], on);
        this.push();
      }
      return this.optionsState();
    });
    ipcMain.handle("options:audit", async (e, cardId) => (fromOptions(e) && typeof cardId === "string" ? this.d.audit.entries({ cardId }).slice(-200) : []));

    // Close to tray: the window hides, cards keep running; Quit is in the tray menu.
    w.on("close", (e) => {
      if (!this.quitting && this.d.options.general.closeToTray && this.tray) { e.preventDefault(); w.hide(); }
    });
    app.on("before-quit", () => { this.quitting = true; });
  }

  /** Sends the grid its state (debounced). */
  push(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const host = this.d.host();
      if (!host || this.d.win.isDestroyed()) return;
      const items: Array<Omit<CardFrame, "size">> = [
        ...[...host.cards.values()].map((c) => ({
          cardId: c.cardId, name: c.name, state: c.status.state, message: c.notice ?? c.status.message, updatedAt: c.status.updatedAt,
          accent: c.accent, running: true, startable: false, ...this.approvalView(c.cardId),
        })),
        ...[...host.stopped.entries()].map(([cardId, s]) => ({
          cardId, name: s.name, state: s.status.state, message: s.status.message, accent: "neutral", running: false, startable: host.startable(cardId),
          ...this.approvalView(cardId),
        })),
      ];
      const frames = this.d.layout.arrange(items, (id) => clampSize(host.defaultSize(id)));
      const running = host.cards.size;
      const state: DashboardState = { frames, summary: `${running} card${running === 1 ? "" : "s"} running`, generator: this.d.generator.view() };
      this.d.win.webContents.send("dashboard:state", state);
      this.optionsWin?.webContents.send("options:changed");
      this.updateTray();
    }, 50);
  }

  private approvalView(cardId: string): Pick<CardFrame, "revoked" | "permissions"> {
    const rec = this.d.approvals.get(cardId);
    return { revoked: rec?.revoked ?? false, permissions: rec && !rec.revoked ? categorySummary(rec) : null };
  }

  private async cardAction(cardId: unknown, action: unknown, parent: BrowserWindow): Promise<void> {
    const host = this.d.host();
    if (!host || typeof cardId !== "string" || !ACTIONS.has(action as CardAction)) return;
    const name = host.cards.get(cardId)?.name ?? host.stopped.get(cardId)?.name ?? cardId;
    switch (action as CardAction) {
      case "stop": host.stop(cardId, "stopped by you", "stopped"); break;
      case "start": if (host.startable(cardId)) { host.stopped.delete(cardId); await host.start(cardId); } break;
      case "revoke": {
        const r = await dialog.showMessageBox(parent, {
          type: "warning", title: "Revoke approval", message: `Revoke the approval of "${name}"?`,
          detail: "The card stops now and stays stopped until you click Grant.",
          buttons: ["Cancel", "Revoke"], defaultId: 0, cancelId: 0, noLink: true,
        });
        if (r.response === 1) await host.revoke(cardId);
        break;
      }
      // Undo of Revoke: no question asked; the start still checks the files against the approval.
      case "grant": await host.restoreApproval(cardId); break;
    }
    this.push();
  }

  // ---------- Options ----------

  openOptions(): void {
    if (this.optionsWin && !this.optionsWin.isDestroyed()) { this.optionsWin.show(); this.optionsWin.focus(); return; }
    const o = new BrowserWindow({
      width: 820, height: 640, title: "Options", parent: this.d.win, show: false, autoHideMenuBar: true,
      webPreferences: {
        preload: join(this.d.distDir, "preload", "options.js"),
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: this.d.devTools,
      },
    });
    o.setMenu(null);
    o.once("ready-to-show", () => o.show());
    o.on("closed", () => { this.optionsWin = null; });
    this.optionsWin = o;
    void o.loadFile(join(this.d.distDir, "renderer", "options.html"));
  }

  async optionsState(): Promise<OptionsState> {
    const host = this.d.host();
    const ids = new Set<string>([...(host?.cards.keys() ?? []), ...(host?.stopped.keys() ?? [])]);
    const taskName = (t: string) => this.d.options.feed(t)?.name ?? t;
    return {
      general: { ...this.d.options.general, packaged: app.isPackaged },
      themes: THEMES.map((t) => ({ id: t.id, name: t.name, light: !!t.light, dark: !!t.dark, font: t.font })),
      feeds: this.d.options.feeds.map((f) => {
        const st = this.d.feeds.state(f.taskId);
        return {
          ...f, folder: join(this.d.reportsDir, f.taskId),
          state: st.offline ? `offline: ${st.offline.reason}` : st.latest ? `ok, last report ${new Date(st.latest.runFinishedAt).toLocaleString()}` : "no report yet",
        };
      }),
      cards: [...ids].sort().map((id) => {
        const running = host?.cards.get(id);
        const stopped = host?.stopped.get(id);
        const appr = this.d.approvals.get(id);
        return {
          cardId: id, name: running?.name ?? stopped?.name ?? id,
          state: running?.status.state ?? stopped?.status.state ?? "unknown",
          message: running?.status.message ?? stopped?.status.message,
          running: !!running, revoked: appr?.revoked ?? false,
          versionHash: appr?.versionHash ?? null, approvedAt: appr?.approvedAt ?? null,
          permissions: appr ? (() => {
            const off = offSet(appr);
            return display(appr.permissions, taskName).lines.map((l, i) => ({ ...l, category: categoryOf(appr.permissions[i]), on: !off.has(i) }));
          })() : [],
        };
      }),
      generator: await this.d.gate(),
      security: this.d.audit.security(300),
    };
  }

  private applyPatch(patch: unknown): void {
    const p = patch as OptionsPatch;
    if (p && typeof p === "object" && "general" in p && p.general && typeof p.general === "object") {
      const before = { ...this.d.options.general };
      this.d.options.setGeneral(p.general);
      const after = this.d.options.general;
      if (after.startWithWindows !== before.startWithWindows) this.applyLoginItem();
      if (after.theme !== before.theme || after.themeMode !== before.themeMode) this.d.themeChanged();
    } else if (p && typeof p === "object" && "feed" in p && p.feed && typeof p.feed.taskId === "string") {
      const { taskId, ...rest } = p.feed;
      if (this.d.options.setFeed(taskId, rest)) void this.d.feeds.rescan(taskId);
    }
  }

  /** Start with Windows: only the packaged exe registers itself; a development run never touches Windows. */
  applyLoginItem(): void {
    if (!app.isPackaged) { this.d.audit.write("_host", "fs", "start with Windows not applied: unpackaged run"); return; }
    // Test runs switch the feature off (they must never write the user's sign-in programs). This can only disable.
    if (process.env.DASHBOARD_NO_LOGIN_ITEM === "1") { this.d.audit.write("_host", "fs", "start with Windows not applied: disabled for this run"); return; }
    this.d.setLoginItem(this.d.options.general.startWithWindows);
  }

  // ---------- tray ----------

  createTray(iconPath: string): void {
    const img = nativeImage.createFromPath(iconPath);
    this.tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    this.tray.setToolTip("Dashboard");
    this.tray.on("click", () => this.showWindow());
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray) return;
    const running = this.d.host()?.cards.size ?? 0;
    this.tray.setToolTip(`Dashboard: ${running} card${running === 1 ? "" : "s"} running`);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show Dashboard", click: () => this.showWindow() },
      { label: "Options…", click: () => this.openOptions() },
      { type: "separator" },
      { label: "Quit", click: () => { this.quitting = true; app.quit(); } },
    ]));
  }

  showWindow(): void {
    const w = this.d.win;
    if (w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }

  destroyTray(): void { this.tray?.destroy(); this.tray = null; }
}

