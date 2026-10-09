/**
 * The approval canvas (docs/PERMISSIONS.md) in the main process: builds what the canvas page shows,
 * recomputes markings when the user unchecks lines, and decides on Approve (with the
 * No / Yes, always / Yes, only now dialog when red markings remain).
 * Allowances ("Yes, always") are per card and per exact scopes: data/approvals/<id>.allowances.json.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { promises as fsp, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Permission } from "../broker/permissions.js";
import { display, type Display } from "../cards/permission-lines.js";
import type { ReviewRequest, ReviewResult } from "../generator/pipeline.js";

export interface CanvasView {
  cardId: string; name: string; description: string; kind: "new" | "update"; version: string; installedVersion?: string;
  permissions: Array<{ text: string; reason: string; status: "new" | "same" | "changed"; oldText?: string }>;
  removed: string[];
  display: Display;
  files: Array<{ path: string; size: number; sha256: string; change: "added" | "changed" | "same" }>;
  removedFiles: string[];
  allowanceCovers: boolean;
}

const scopeKey = (p: Permission) => JSON.stringify({ ...p, reason: undefined });

/** The red combination's exact scopes; "Yes, always" remembers this key. */
function redKey(perms: Permission[], d: Display): string | null {
  const idx = d.lines.map((l, i) => (l.marks.some((m) => m.level === "red") ? i : -1)).filter((i) => i >= 0);
  return idx.length ? JSON.stringify(idx.map((i) => scopeKey(perms[i])).sort()) : null;
}

export class ApprovalCanvas {
  private win: BrowserWindow | null = null;
  private pending: { req: ReviewRequest; checked: boolean[]; resolve: (r: ReviewResult) => void } | null = null;

  constructor(private readonly d: { parent: () => BrowserWindow | null; distDir: string; approvalsDir: string; taskName: (id: string) => string; devTools: boolean }) {
    const from = (e: IpcMainInvokeEvent) => !!this.win && e.sender === this.win.webContents;
    ipcMain.handle("canvas:get", (e) => (from(e) && this.pending ? this.view() : null));
    ipcMain.handle("canvas:toggle", (e, index, on) => {
      if (!from(e) || !this.pending || typeof index !== "number" || typeof on !== "boolean" || !(index in this.pending.checked)) return null;
      this.pending.checked[index] = on;
      return this.view();
    });
    ipcMain.handle("canvas:decide", async (e, approve) => (from(e) ? this.decide(approve === true) : null));
  }

  /** Opens the canvas for a generated card and resolves with the user's decision. */
  review(req: ReviewRequest): Promise<ReviewResult> {
    if (this.pending) this.pending.resolve({ approved: false });
    return new Promise((resolve) => {
      this.pending = { req, checked: req.card.manifest.permissions.map(() => true), resolve };
      this.open();
    });
  }

  private open(): void {
    if (this.win && !this.win.isDestroyed()) { this.win.webContents.send("canvas:changed"); this.win.show(); this.win.focus(); return; }
    const parent = this.d.parent() ?? undefined;
    const w = new BrowserWindow({
      width: 760, height: 720, title: "Approve card", parent, modal: false, show: false, autoHideMenuBar: true,
      webPreferences: { preload: join(this.d.distDir, "preload", "canvas.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: this.d.devTools },
    });
    w.setMenu(null);
    w.once("ready-to-show", () => w.show());
    w.on("closed", () => { this.win = null; if (this.pending) { const p = this.pending; this.pending = null; p.resolve({ approved: false }); } });
    this.win = w;
    void w.loadFile(join(this.d.distDir, "renderer", "canvas.html"));
  }

  private allowances(cardId: string): string[] {
    try { return JSON.parse(readFileSync(join(this.d.approvalsDir, `${cardId}.allowances.json`), "utf8")) as string[]; } catch { return []; }
  }

  private checkedPerms(): Permission[] {
    const p = this.pending!;
    return p.req.card.manifest.permissions.filter((_, i) => p.checked[i]);
  }

  view(): CanvasView {
    const { req, checked } = this.pending!;
    const m = req.card.manifest;
    const perms = m.permissions;
    const shown = perms.filter((_, i) => checked[i]);
    const dshown = display(shown, this.d.taskName);
    // Lines for every permission (unchecked ones keep their text but no markings).
    const full = display(perms, this.d.taskName);
    let k = 0;
    const lines = perms.map((_, i) => (checked[i] ? dshown.lines[k++] : { ...full.lines[i], marks: [] }));
    const oldKeys = new Map((req.installed?.permissions ?? []).map((p) => [scopeKey(p), p]));
    const oldTypes = new Map((req.installed?.permissions ?? []).map((p) => [p.type, p]));
    const key = redKey(shown, dshown);
    const files = Object.entries(req.card.hashes).map(([path, sha256]) => {
      const old = req.installed?.files[path];
      return { path, size: req.card.files[path].length, sha256, change: (!req.installed ? "added" : !old ? "added" : old === sha256 ? "same" : "changed") as "added" | "changed" | "same" };
    });
    return {
      cardId: m.id, name: m.name, description: typeof m.description === "string" ? m.description : "", kind: req.kind, version: m.version, installedVersion: req.installed?.version,
      permissions: perms.map((p, i) => {
        const same = oldKeys.has(scopeKey(p));
        const prev = !same && req.installed ? oldTypes.get(p.type) : undefined;
        return { text: lines[i].text, reason: p.reason, status: !req.installed ? "new" : same ? "same" : prev ? "changed" : "new", oldText: prev ? display([prev], this.d.taskName).lines[0].text : undefined };
      }),
      removed: (req.installed?.permissions ?? []).filter((p) => !perms.some((n) => scopeKey(n) === scopeKey(p))).map((p) => display([p], this.d.taskName).lines[0].text),
      display: { ...dshown, lines },
      files,
      removedFiles: Object.keys(req.installed?.files ?? {}).filter((f) => !req.card.hashes[f]),
      allowanceCovers: !!key && this.allowances(m.id).includes(key),
    };
  }

  private async decide(approve: boolean): Promise<{ closed: boolean }> {
    const p = this.pending;
    if (!p) return { closed: true };
    if (!approve) { this.finish({ approved: false }); return { closed: true }; }
    const v = this.view();
    const perms = this.checkedPerms();
    if (v.display.red && !v.allowanceCovers) {
      const sentences = [...new Set(v.display.lines.flatMap((l) => l.marks.filter((m) => m.level === "red").map((m) => m.why)))];
      const r = await dialog.showMessageBox(this.win!, {
        type: "warning", title: "Allow this combination?", message: "Do you want to allow this permission combination?",
        detail: sentences.map((s) => `• ${s}`).join("\n"),
        buttons: ["No", "Yes, always", "Yes, only now"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (r.response === 0) return { closed: false };
      if (r.response === 1) {
        const key = redKey(perms, display(perms, this.d.taskName))!;
        const list = [...new Set([...this.allowances(v.cardId), key])];
        await fsp.mkdir(this.d.approvalsDir, { recursive: true });
        await fsp.writeFile(join(this.d.approvalsDir, `${v.cardId}.allowances.json`), JSON.stringify(list, null, 2));
      }
    }
    this.finish({ approved: true, permissions: perms });
    return { closed: true };
  }

  private finish(r: ReviewResult): void {
    const p = this.pending;
    this.pending = null;
    p?.resolve(r);
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}
