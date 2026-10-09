/**
 * "The host is tested" (VALIDATOR.md): the validator approves nothing unless this exact Dashboard
 * build has passed its own security suite (TESTPLAN part A). The record is
 * data/generator/host-suite.json, written only by scripts/record-host-suite.mjs after the suite
 * passed. Same threat model as the CLI approval: it catches untested builds, not a forger running as the user.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

/** null if the running build passed its security suite; otherwise the reason in plain words. */
export function hostSuiteProblem(recordPath: string, currentHash: string): string | null {
  let rec: Partial<HostSuiteRecord>;
  try { rec = JSON.parse(readFileSync(recordPath, "utf8")) as Partial<HostSuiteRecord>; }
  catch { return "this Dashboard build has not passed its security tests (no record): run npm run test:host-suite"; }
  if (rec.schema !== 1 || typeof rec.buildHash !== "string") return "the security test record is unreadable: run npm run test:host-suite";
  if (rec.buildHash !== currentHash) return `this Dashboard build (${currentHash.slice(0, 12)}…) is not the build that passed the security tests (${rec.buildHash.slice(0, 12)}…): run npm run test:host-suite`;
  return null;
}
