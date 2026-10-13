/**
 * Permission types (spec/manifest.schema.json, apiVersion 0) and scope matching.
 * The broker asks: which approved permission, if any, covers this exact request?
 */
import { resolve } from "node:path";

export type SysinfoField = "cpu" | "memory" | "disk" | "network" | "os" | "battery" | "gpu" | "processes";
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type Permission =
  | { type: "fs.read" | "fs.write" | "fs.delete"; path: string; recursive?: boolean; reason: string }
  | { type: "net.http"; origin: string; pathPrefix?: string; methods: HttpMethod[]; reason: string }
  | { type: "sysinfo"; fields: SysinfoField[]; reason: string }
  | { type: "reports.read"; taskId: string; reason: string }
  | { type: "links.open"; origins?: string[]; any?: true; reason: string };

/** Types that are reserved or removed; never grantable in apiVersion 0 (host invariant 11). */
export const FORBIDDEN_PERMISSION_TYPES = new Set(["process.run", "process.launch", "claude", "ffi.call"]);

export type CapabilityRequest =
  | { type: "fs.read" | "fs.write" | "fs.delete"; path: string }
  | { type: "net.http"; url: URL; method: HttpMethod }
  | { type: "sysinfo"; field: SysinfoField }
  | { type: "reports.read"; taskId: string }
  | { type: "links.open"; url: URL };

/**
 * The four groups the user switches on and off (grid permission menu; Options > Cards > Details).
 * links.open counts as web: opening a link sends data to that site just like a request does.
 */
export type PermissionCategory = "web" | "files" | "system" | "reports";
export const PERMISSION_CATEGORIES: readonly PermissionCategory[] = ["web", "files", "system", "reports"];

export function categoryOf(p: { type: Permission["type"] }): PermissionCategory {
  switch (p.type) {
    case "net.http": case "links.open": return "web";
    case "fs.read": case "fs.write": case "fs.delete": return "files";
    case "sysinfo": return "system";
    case "reports.read": return "reports";
  }
}

/** "/api" covers "/api" and "/api/x", not "/apix". "/" covers everything. */
export function pathPrefixCovers(prefix: string, path: string): boolean {
  if (prefix === "/" || prefix === "") return true;
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith("/") || path.length === prefix.length || path[prefix.length] === "/" || path[prefix.length] === "?";
}

function normDir(p: string): string {
  return resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** Lexical check only. The file helper re-checks the final path on the opened handle (ARCHITECTURE.md 4). */
export function fsScopeCovers(scope: string, recursive: boolean, target: string): boolean {
  const s = normDir(scope), t = normDir(target);
  if (t === s) return true;
  if (!t.startsWith(s + "\\")) return false;
  return recursive || !t.slice(s.length + 1).includes("\\");
}

/** Index of the first permission that covers the request, or -1. `skip` leaves out permissions (those switched off). */
export function findCovering(perms: readonly Permission[], req: CapabilityRequest, resolvePath: (p: string) => string, skip?: (index: number) => boolean): number {
  for (let i = 0; i < perms.length; i++) {
    if (skip?.(i)) continue;
    const p = perms[i];
    if (p.type !== req.type) continue;
    switch (req.type) {
      case "sysinfo":
        if (p.type === "sysinfo" && p.fields.includes(req.field)) return i;
        break;
      case "reports.read":
        if (p.type === "reports.read" && p.taskId === req.taskId) return i;
        break;
      case "links.open":
        if (p.type === "links.open" && req.url.protocol === "https:"
          && (p.any === true || (p.origins ?? []).some((o) => new URL(o).origin === req.url.origin))) return i;
        break;
      case "net.http":
        if (p.type === "net.http" && p.methods.includes(req.method)
          && req.url.origin === new URL(p.origin).origin
          && pathPrefixCovers(p.pathPrefix ?? "/", req.url.pathname)) return i;
        break;
      case "fs.read": case "fs.write": case "fs.delete":
        if ((p.type === "fs.read" || p.type === "fs.write" || p.type === "fs.delete")
          && fsScopeCovers(resolvePath(p.path), p.recursive ?? false, resolvePath(req.path))) return i;
        break;
    }
  }
  return -1;
}
