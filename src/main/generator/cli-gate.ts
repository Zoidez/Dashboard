/**
 * CLI gate: the only way the Dashboard starts the Claude Code CLI (the generator).
 *
 * Rule (RULES.md, Binary and config 1b): the Dashboard runs a CLI build only if the spike approved that
 * exact build. Before EVERY launch the gate checks:
 *   1. Build/data/generator/cli-approval.json exists, is schema 1, status "approved", from harness >= MIN_HARNESS;
 *   2. the SHA-256 of the installed claude.exe equals the approved sha256;
 *   3. `claude.exe --version` reports the approved version.
 * If any check fails, the gate refuses the launch, kills every CLI process it started (whole process
 * tree), closes their pipes, and stays disabled until a later check passes. It also watches the binary
 * and the approval file and re-checks on any change.
 *
 * The approval file is written by spikes/spike1-cli.ps1; the Dashboard never writes it.
 * Threat model: this catches accidental or unreviewed CLI changes. A process running as the user can
 * forge the file or swap the binary; Option A accepts that (ARCHITECTURE.md, Security model).
 */
import { spawn, execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fsp, watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";

export const MIN_HARNESS = "3.9";

export interface CliApproval {
  schema: 1;
  status: "approved" | "blocked" | "incomplete";
  version: string;
  sha256: string;
  harness: string;
  decidedAt: string;
  runs: string[];
  failed: string[];
  missing: string[];
}

/** Why a build cannot run; the New card picks its state from this (ARCHITECTURE.md, "Claude card: CLI test states"). */
export type GateCode = "no-list" | "unreadable" | "untested" | "incomplete" | "blocked" | "old-harness" | "hash-mismatch" | "binary-unreadable" | "version-failed" | "version-mismatch" | "changed-during-check";

export type GateResult =
  | { ok: true; version: string; sha256: string }
  | { ok: false; code: GateCode; reason: string; record?: CliApproval };

export interface GateOptions {
  exePath: string;        // Build/data/vendor/claude/<version>-<sha12>/claude.exe
  /** The tested list Build/data/generator/cli-approvals.json (schema 2), or a single record (schema 1, older spikes). */
  approvalPath: string;
  /** Tried when approvalPath does not exist: the single record older spikes wrote. */
  legacyApprovalPath?: string;
  /** The build's folder name "<version>-<sha12>", to tell "untested" from "damaged or replaced". */
  buildFolder?: string;
  versionTimeoutMs?: number;
  /** Environment for `--version`; built from scratch, never inherited. */
  baseEnv?: NodeJS.ProcessEnv;
}

/** Compares dotted versions numerically ("3.10" > "3.7"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Parses and validates the approval file. Throws with a plain-words reason. */
export function parseApproval(text: string): CliApproval {
  let j: unknown;
  try { j = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("approval file is not valid JSON"); }
  const a = j as Partial<CliApproval>;
  if (!a || typeof a !== "object") throw new Error("approval file is not an object");
  if (a.schema !== 1) throw new Error(`approval file schema ${String(a.schema)} is not supported`);
  if (typeof a.version !== "string" || !/^\d+\.\d+\.\d+$/.test(a.version)) throw new Error("approval file has no valid version");
  if (typeof a.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(a.sha256)) throw new Error("approval file has no valid sha256");
  if (typeof a.harness !== "string" || Number.isNaN(compareVersions(a.harness, MIN_HARNESS))) throw new Error("approval file has no valid harness version");
  if (a.status !== "approved" && a.status !== "blocked" && a.status !== "incomplete") throw new Error("approval file has an unknown status");
  return a as CliApproval;
}

/** The tested list: schema 2 { builds: [...] }, or a single schema-1 record (older spikes). */
export function parseApprovals(text: string): CliApproval[] {
  let j: unknown;
  try { j = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("the tested list is not valid JSON"); }
  const o = j as { schema?: unknown; builds?: unknown };
  if (o && typeof o === "object" && o.schema === 2) {
    if (!Array.isArray(o.builds)) throw new Error("the tested list has no builds");
    return o.builds.map((b) => parseApproval(JSON.stringify(b)));
  }
  return [parseApproval(text)];
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => resolve()).on("error", reject);
  });
  return h.digest("hex");
}

/** Runs `<exe> --version` and returns the x.y.z it reports. */
export function readCliVersion(exePath: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exePath, ["--version"], { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`"--version" failed: ${err.message}`));
      const m = /^\s*(\d+\.\d+\.\d+)\b/.exec(String(stdout));
      if (!m) return reject(new Error(`"--version" printed no version: ${String(stdout).slice(0, 80)}`));
      resolve(m[1]);
    });
  });
}

function minimalEnv(): NodeJS.ProcessEnv {
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  return { SystemRoot: sys, windir: sys, PATH: `${sys}\\system32;${sys}`, DISABLE_UPDATES: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

/** One full check. Never throws; returns a reason code and the reason in plain words. */
export async function verifyCli(opts: GateOptions): Promise<GateResult> {
  let list: CliApproval[];
  try {
    let text: string;
    try { text = await fsp.readFile(opts.approvalPath, "utf8"); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !opts.legacyApprovalPath) throw e;
      text = await fsp.readFile(opts.legacyApprovalPath, "utf8");
    }
    list = parseApprovals(text);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, code: "no-list", reason: "no CLI approval file: run the spike on this CLI version" };
    return { ok: false, code: "unreadable", reason: (e as Error).message };
  }
  // The binary is identified by its hash first; an untested binary is never started, not even for --version.
  let sha: string;
  try { sha = (await sha256File(opts.exePath)).toLowerCase(); } catch (e) { return { ok: false, code: "binary-unreadable", reason: `cannot read the CLI binary: ${(e as Error).message}` }; }
  const approval = list.find((r) => r.sha256.toLowerCase() === sha);
  if (!approval) {
    const folderVersion = /^(\d+\.\d+\.\d+)-/.exec(opts.buildFolder ?? "")?.[1];
    const sameVersion = folderVersion ? list.find((r) => r.version === folderVersion) : undefined;
    if (sameVersion) return { ok: false, code: "hash-mismatch", reason: `the CLI file does not match the tested build of ${sameVersion.version}; it may be damaged or replaced`, record: sameVersion };
    return { ok: false, code: "untested", reason: `the installed CLI binary (sha256 ${sha.slice(0, 12)}...) is not on the tested list: it is not the build the spike approved` };
  }
  if (approval.status !== "approved") {
    return { ok: false, code: approval.status, reason: `CLI ${approval.version} is ${approval.status} by the spike (failed: ${approval.failed.length}, not yet passed: ${approval.missing.length})`, record: approval };
  }
  if (compareVersions(approval.harness, MIN_HARNESS) < 0) {
    return { ok: false, code: "old-harness", reason: `approval comes from spike harness ${approval.harness}; at least ${MIN_HARNESS} is required: run the spike again`, record: approval };
  }
  let version: string;
  try { version = await readCliVersion(opts.exePath, opts.baseEnv ?? minimalEnv(), opts.versionTimeoutMs ?? 15000); }
  catch (e) { return { ok: false, code: "version-failed", reason: (e as Error).message, record: approval }; }
  if (version !== approval.version) {
    return { ok: false, code: "version-mismatch", reason: `the CLI reports version ${version}; the spike approved ${approval.version}`, record: approval };
  }
  // Hash again: the binary must not have changed while --version ran.
  try { if ((await sha256File(opts.exePath)).toLowerCase() !== sha) return { ok: false, code: "changed-during-check", reason: "the CLI binary changed during the check" }; }
  catch (e) { return { ok: false, code: "binary-unreadable", reason: `cannot read the CLI binary: ${(e as Error).message}` }; }
  return { ok: true, version, sha256: sha };
}

export class GateError extends Error {}

/**
 * Owns every generator process. Events: "disabled" (reason), "enabled" (version).
 * Use `launch()` for every CLI start; never spawn the CLI elsewhere.
 */
export class GeneratorGate extends EventEmitter {
  private readonly children = new Set<ChildProcess>();
  private watchers: FSWatcher[] = [];
  private recheckTimer: NodeJS.Timeout | null = null;
  private _state: { enabled: boolean; reason: string; version?: string } = { enabled: false, reason: "not checked yet" };

  constructor(private opts: GateOptions) { super(); }

  /** Points the gate at another build (e.g. after "Switch to CLI x.y.z"); every running generation stops. */
  retarget(opts: GateOptions): void {
    this.abortAll("the CLI build changed");
    const watching = this.watchers.length > 0;
    this.stopWatching();
    this.opts = opts;
    if (watching) this.startWatching();
  }

  get state() { return { ...this._state }; }
  get runningCount() { return this.children.size; }

  /** Checks now; on failure aborts everything. Returns the result. */
  async check(): Promise<GateResult> {
    const r = await verifyCli(this.opts);
    if (r.ok) {
      const was = this._state.enabled;
      this._state = { enabled: true, reason: "", version: r.version };
      if (!was) this.emit("enabled", r.version);
    } else {
      this.abortAll(r.reason);
    }
    return r;
  }

  /** Verifies, then spawns the CLI. Throws GateError (and aborts everything) if the check fails. */
  async launch(args: string[], options: SpawnOptions): Promise<ChildProcess> {
    const r = await this.check();
    if (!r.ok) throw new GateError(`Generator disabled: ${r.reason}`);
    const child = spawn(this.opts.exePath, args, { ...options, windowsHide: true });
    this.children.add(child);
    const forget = () => this.children.delete(child);
    child.once("exit", forget);
    child.once("error", forget);
    return child;
  }

  /** Kills one generation (whole process tree), e.g. when the user presses Stop or a run times out. */
  kill(child: ChildProcess): void {
    try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
    killTree(child);
    this.children.delete(child);
  }

  /** Kills every CLI process this gate started (whole tree), closes their pipes, disables the gate. */
  abortAll(reason: string): void {
    const wasEnabled = this._state.enabled;
    this._state = { enabled: false, reason };
    for (const child of this.children) {
      try { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); } catch { /* already closed */ }
      killTree(child);
    }
    this.children.clear();
    if (wasEnabled || reason) this.emit("disabled", reason);
  }

  /** Re-checks whenever the binary or the approval file changes (debounced). */
  startWatching(): void {
    const onChange = () => {
      if (this.recheckTimer) clearTimeout(this.recheckTimer);
      this.recheckTimer = setTimeout(() => { void this.check(); }, 250);
    };
    for (const p of [this.opts.exePath, this.opts.approvalPath]) {
      try { this.watchers.push(watch(p, onChange)); }
      catch { this.abortAll(`cannot watch ${p}`); }
    }
  }

  stopWatching(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    // /T: the whole tree (the CLI starts helpers such as ripgrep and reg.exe); /F: no grace period.
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => { /* best effort */ });
  } else {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}
