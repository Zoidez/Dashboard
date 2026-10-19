/**
 * The portable instance (ARCHITECTURE.md, "Storage"). Every path the host writes is derived here,
 * under the instance root. Nothing goes to %APPDATA% or the user profile.
 *
 * Root:
 *   packaged: <root>/app/<build-id>/Dashboard.exe -> <root> (side by side, LASS phase 3)
 *             <root>/app/Dashboard.exe            -> <root> (the flat layout before it)
 *   dev/test: --instance=<path> (required; relative to the working directory)
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, join } from "node:path";

export interface InstancePaths {
  root: string;
  app: string;
  data: string;
  cards: string;
  approvals: string;
  audit: string;
  config: string;
  electron: string;
  generator: string;
  vendor: string;
  exchange: string;
  reports: string;
  staging: string;
}

export function instanceRootFrom(argv: readonly string[], isPackaged: boolean, exePath: string, cwd: string): string {
  const flag = argv.find((a) => a.startsWith("--instance="));
  if (flag) {
    const p = flag.slice("--instance=".length);
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  }
  if (isPackaged) {
    // Side by side (LASS phase 3): <root>/app/<build-id>/Dashboard.exe. Before: <root>/app/Dashboard.exe.
    // (2026-10-19: the side-by-side build took <root>/app as its instance and started empty.)
    const dir = dirname(exePath), parent = dirname(dir);
    if (/^[0-9a-f]{12}$/.test(basename(dir)) && basename(parent).toLowerCase() === "app") return dirname(parent);
    return parent;
  }
  throw new Error("Unpackaged runs need --instance=<path to the instance folder>.");
}

export function instancePaths(root: string): InstancePaths {
  const data = join(root, "data");
  const exchange = join(root, "ClaudeExchange");
  return {
    root,
    app: join(root, "app"),
    data,
    cards: join(data, "cards"),
    approvals: join(data, "approvals"),
    audit: join(data, "audit"),
    config: join(data, "config"),
    electron: join(data, "electron"),
    generator: join(data, "generator"),
    vendor: join(data, "vendor"),
    exchange,
    reports: join(exchange, "reports"),
    staging: join(exchange, "staging"),
  };
}

/** The instance folder must already exist: the app never creates its own root. */
export function assertInstance(root: string): void {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Instance folder not found: ${root}`);
  if (/[\\/]OneDrive[^\\/]*[\\/]/i.test(root + "\\")) throw new Error(`The instance must not be in a OneDrive folder: ${root}`);
}

/** True if `p` is the instance root or inside it (host invariant 12 uses this). Case-insensitive, Windows paths. */
export function isInsideInstance(root: string, p: string): boolean {
  const norm = (x: string) => resolve(x).replace(/[\\/]+$/, "").toLowerCase();
  const r = norm(root), q = norm(p);
  return q === r || q.startsWith(r + "\\") || q.startsWith(r + "/");
}
