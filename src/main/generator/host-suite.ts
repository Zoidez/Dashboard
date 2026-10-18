/**
 * "The host is tested" (VALIDATOR.md): the validator approves nothing unless this exact Dashboard
 * build has passed its own security suite (TESTPLAN part A). The record is
 * data/generator/host-suite.json, written only by scripts/record-host-suite.mjs after the suite
 * passed (schema 2: one record per tested build, newest first, at most MAX_RECORDS). Same threat model as the CLI approval: it catches untested builds, not a forger running as the user.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Build parts that decide security: main process, preloads, card runtimes, file helper. */
export const SECURITY_PARTS = ["main", "preload", "card-runtime", "filehelper"];

export function buildHash(distDir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".js")) files.push(p);
    }
  };
  for (const part of SECURITY_PARTS) { try { walk(join(distDir, part)); } catch { /* missing part: hash differs */ } }
  const h = createHash("sha256");
  for (const f of files.sort()) {
    h.update(relative(distDir, f).replace(/\\/g, "/") + "\0");
    h.update(createHash("sha256").update(readFileSync(f)).digest("hex") + "\n");
  }
  return h.digest("hex");
}

export interface HostSuiteRecord { schema: 1; buildHash: string; passedAt: string; suites: string[] }
/** Schema 2 (LASS phase 4): records for several builds, so testing a fix's build does not void the running one's. */
export interface HostSuiteRecords { schema: 2; records: Array<{ buildHash: string; passedAt: string; suites: string[] }> }
/** How many builds keep their record (the launcher keeps three builds; a tested fix may wait beside them). */
export const MAX_RECORDS = 5;

/** The build hashes with a passed record, newest first; null if the file is missing or unreadable. */
export function recordedHashes(recordPath: string): string[] | null {
  let rec: Record<string, unknown>;
  try { rec = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>; } catch { return null; }
  const ok = (h: unknown): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
  if (rec.schema === 1) return ok(rec.buildHash) ? [rec.buildHash] : null;
  if (rec.schema === 2 && Array.isArray(rec.records)) {
    const hashes = (rec.records as Array<Record<string, unknown>>).filter((r) => r && ok(r.buildHash)).map((r) => r.buildHash as string);
    return hashes.length ? hashes : null;
  }
  return null;
}

/** null if the running build passed its security suite; otherwise the reason in plain words. */
export function hostSuiteProblem(recordPath: string, currentHash: string): string | null {
  if (!existsSync(recordPath)) return "this Dashboard build has not passed its security tests (no record): run npm run test:host-suite";
  const hashes = recordedHashes(recordPath);
  if (!hashes) return "the security test record is unreadable: run npm run test:host-suite";
  if (!hashes.includes(currentHash)) return `this Dashboard build (${currentHash.slice(0, 12)}…) is not a build that passed the security tests (${hashes.map((h) => h.slice(0, 12) + "…").join(", ")}): run npm run test:host-suite`;
  return null;
}
