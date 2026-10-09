/**
 * The portable instance (ARCHITECTURE.md, "Storage"). Every path the host writes is derived here,
 * under the instance root. Nothing goes to %APPDATA% or the user profile.
 *
 * Root:
 *   packaged: <root>/app/Dashboard.exe  -> <root>
 *   dev/test: --instance=<path> (required; relative to the working directory)
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve, join } from "node:path";

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
  if (isPackaged) return dirname(dirname(exePath));
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
