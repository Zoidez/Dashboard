/**
 * The Dashboard's side of the launcher (docs/LASS.md 8; launcher/Launcher.cs = Build\Dashboard.exe):
 * the ready report the launcher waits for, the window position it restores, and the restart into a
 * pending build. Builds live side by side in Build\app\<build-id>\; Build\data\current-build.json
 * names current, previous and pending.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const BUILD_ID = /^[0-9a-f]{12}$/;
export interface BuildState { current?: string; previous?: string; pending?: string }
export interface Bounds { x: number; y: number; width: number; height: number }

export const launcherExe = (root: string) => join(root, "Dashboard.exe");
const stateFile = (root: string) => join(root, "data", "current-build.json");

export function readBuildState(root: string): BuildState {
  try {
    const j = JSON.parse(readFileSync(stateFile(root), "utf8")) as Record<string, unknown>;
    const out: BuildState = {};
    for (const k of ["current", "previous", "pending"] as const) if (typeof j[k] === "string" && BUILD_ID.test(j[k] as string)) out[k] = j[k] as string;
    return out;
  } catch { return {}; }
}

function writeJson(file: string, v: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(v));
  renameSync(file + ".tmp", file);
}

/** Marks an installed build as pending: the launcher tries it on the next restart (and rolls back if it fails). */
export function setPending(root: string, id: string): void {
  if (!BUILD_ID.test(id) || !existsSync(join(root, "app", id, "Dashboard.exe"))) throw new Error(`build ${id} is not installed`);
  writeJson(stateFile(root), { ...readBuildState(root), pending: id });
}

/** The report the launcher waits for: this process is up, and whether its security-test record matches this build. */
export function writeReady(root: string, r: { pid: number; build: string; hostSuiteOk: boolean }): void {
  try { writeJson(join(root, "data", "launcher", "ready.json"), { ...r, at: new Date().toISOString() }); } catch { /* never blocks start-up */ }
}

const boundsFile = (root: string) => join(root, "data", "window.json");

export function readBounds(root: string): Bounds | null {
  try {
    const b = JSON.parse(readFileSync(boundsFile(root), "utf8")) as Bounds;
    const ok = [b.x, b.y, b.width, b.height].every((n) => Number.isInteger(n)) && b.width >= 400 && b.height >= 300 && b.width <= 10000 && b.height <= 10000;
    return ok ? b : null;
  } catch { return null; }
}

export function saveBounds(root: string, b: Bounds): void {
  try { writeJson(boundsFile(root), b); } catch { /* best effort */ }
}

/**
 * Restart into the pending build (LASS rollout, after the user's click): the launcher waits for this
 * process to exit, shows the restart screen where the window is, starts the pending build, and rolls
 * back if it does not come up. The caller quits the app right after.
 */
export function restartIntoPending(root: string, bounds: Bounds | null): void {
  const exe = launcherExe(root);
  if (!existsSync(exe)) throw new Error("the launcher (Build\\Dashboard.exe) is missing");
  if (!readBuildState(root).pending) throw new Error("no pending build");
  const args = ["--wait-pid", String(process.pid), ...(bounds ? ["--bounds", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`] : [])];
  spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
