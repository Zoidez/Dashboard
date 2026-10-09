/**
 * E2E helpers: throwaway instance folders with approved fixture cards, app launch, host state.
 * Approval records are written here directly, standing in for the approval canvas (not built yet).
 */
import { _electron as electron, type ElectronApplication } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(__dirname, "..", "..");

export function makeInstance(): string {
  const dir = mkdtempSync(join(tmpdir(), "dash-e2e-"));
  for (const d of ["data/cards", "data/approvals", "data/config", "ClaudeExchange/reports", "ClaudeExchange/staging"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export interface CardSpec {
  id: string;
  name?: string;
  ui: string;
  permissions?: unknown[];
  /** Permissions to record as approved; defaults to all requested. */
  approved?: unknown[];
  approve?: boolean;
  /** Files under assets/, e.g. { "pic.png": Buffer }. */
  assets?: Record<string, Buffer>;
  /** worker.js source; sets manifest.worker = true. */
  worker?: string;
  /** Extra manifest fields (e.g. schedule). */
  manifest?: Record<string, unknown>;
}

export function addCard(instance: string, spec: CardSpec): void {
  const dir = join(instance, "data", "cards", spec.id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id: spec.id, name: spec.name ?? spec.id, version: "1.0.0", apiVersion: 0, permissions: spec.permissions ?? [], ...(spec.worker ? { worker: true } : {}), ...(spec.manifest ?? {}) };
  const files: Record<string, string | Buffer> = {
    "manifest.json": JSON.stringify(manifest, null, 2),
    "ui.js": spec.ui,
    "DEVLOG.md": `# ${spec.id}\n\n- test fixture\n`,
  };
  if (spec.worker) files["worker.js"] = spec.worker;
  for (const [name, data] of Object.entries(spec.assets ?? {})) files[`assets/${name}`] = data;
  if (spec.assets) mkdirSync(join(dir, "assets"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, ...name.split("/")), text);
  if (spec.approve === false) return;
  const hashes = Object.fromEntries(Object.entries(files).map(([n, t]) => [n, sha(t)]));
  const lines = Object.keys(hashes).sort().map((p) => `${p}\0${hashes[p]}\n`).join("");
  writeFileSync(join(instance, "data", "approvals", `${spec.id}.json`), JSON.stringify({
    schema: 1, cardId: spec.id, version: "1.0.0", versionHash: sha(lines), files: hashes,
    permissions: spec.approved ?? spec.permissions ?? [], approvedAt: new Date().toISOString(), revoked: false,
  }, null, 2));
}

/** Launches the app on a throwaway instance: the packaged exe if DASH_EXE is set, otherwise the dev build. */
export async function launch(instance: string): Promise<ElectronApplication> {
  const exe = process.env.DASH_EXE;
  // Tests never touch Windows' sign-in programs: the app honours this switch (it can only disable the feature).
  const env = { ...process.env, DASHBOARD_NO_LOGIN_ITEM: "1" } as Record<string, string>;
  if (exe) return electron.launch({ executablePath: exe, args: [`--instance=${instance}`], env, timeout: 30_000 });
  return electron.launch({ args: [REPO, `--instance=${instance}`], cwd: REPO, env, timeout: 30_000 });
}

/** The card's own storage, where fixture cards write their results. */
export function cardStorage(instance: string, cardId: string): Record<string, unknown> | null {
  const f = join(instance, "data", "config", cardId, "storage.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : null;
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface HostSnapshot {
  mainPid: number;
  dashboardPid: number;
  running: Array<{ cardId: string; pid: number | null; rights: unknown; status: { state: string; message?: string }; grants: number; sessionLive: boolean }>;
  stopped: Array<{ cardId: string; status: { state: string; message?: string } }>;
  audit: Array<{ cardId: string; kind: string; detail: string }>;
}

export async function snapshot(app: ElectronApplication): Promise<HostSnapshot> {
  return app.evaluate(({ BrowserWindow }) => {
    const d = (globalThis as any).__dashboard;
    const win = BrowserWindow.getAllWindows()[0];
    if (!d || !win) return { mainPid: process.pid, dashboardPid: 0, running: [], stopped: [], audit: [] };
    return {
      mainPid: process.pid,
      dashboardPid: win.webContents.getOSProcessId(),
      running: [...d.host.cards.values()].map((c: any) => ({
        cardId: c.cardId, pid: c.pid, rights: c.rights, status: c.status,
        grants: c.broker ? c.broker.grants.size : 0, sessionLive: !!c.broker && !c.broker.ended,
      })),
      stopped: [...d.host.stopped.entries()].map(([cardId, s]: [string, any]) => ({ cardId, status: s.status })),
      audit: d.audit.entries().map((e: any) => ({ cardId: e.cardId, kind: e.kind, detail: e.detail })),
    };
  });
}

/** Common prelude for fixture cards: report(key, value) stores into the card's own storage. */
export const PRELUDE = `
const results = {};
async function report(api, key, value) { results[key] = value; await api.storage.set("results", results); }
async function attempt(fn) { try { const v = await fn(); return { ok: true, v: v === undefined ? null : String(v).slice(0, 200) }; } catch (e) { return { ok: false, code: e && e.code, msg: String(e && e.message || e).slice(0, 200) }; } }
`;

/** Waits until the main process has set up the host (its test handle exists). */
export async function ready(app: ElectronApplication): Promise<void> {
  await waitFor(() => app.evaluate(() => !!(globalThis as any).__dashboard?.host), "the host to start");
}
