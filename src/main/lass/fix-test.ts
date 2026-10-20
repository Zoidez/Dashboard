/**
 * Testing a reviewed fix on this PC (docs/LASS.md 8), started only by the user's click after they saw
 * the patch: this runs code an agent wrote after reading untrusted text, with the user's rights.
 *
 *   1. a git worktree Build\data\lass\work\fix-<inv-id>\ on branch lass/<inv-id>, at the fix's base commit
 *   2. git checks the patch (`git apply --check --numstat`; its file list must equal the host's), applies
 *      it and commits it on that branch (the user's own git identity; nothing is pushed or merged)
 *   3. node_modules: a junction to the project's when the dependencies are unchanged, else npm ci
 *   4. typecheck, unit tests, e2e tests, package (install only: not current, not pending), security suite
 *   5. the host checks the result itself: the installed build's app.asar matches the worktree's, and the
 *      security-test record names the worktree's build hash
 * Install (setPending + restart through the launcher) is a second click, in the LASS bar.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { buildHash, recordedHashes } from "../generator/host-suite.js";
import { numstatPaths, reviewPatch } from "./patch.js";

export interface FixTestDeps {
  /** The project folder (the git repository; Build\ is inside it). */
  repo: string;
  /** The instance root (Build). */
  root: string;
  invId: string;
  base: string;
  patchFile: string;
  summaryLine: string;
  logFile: string;
  /** Runs a command (shell when needed) in a folder, appending to the log; resolves with the exit code. Injectable for tests. */
  run?: (cmd: string, args: string[], cwd: string, opts: { shell?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal; capture?: boolean }) => Promise<{ code: number | null; out: string }>;
  progress?: (step: string, n: number, of: number) => void;
}

export interface FixTestResult { build: string; buildHash: string; worktree: string; branch: string }

export const worktreeOf = (root: string, invId: string) => join(root, "data", "lass", "work", `fix-${invId}`);
export const branchOf = (invId: string) => `lass/${invId}`;

function projectEnv(repo: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const node = join(repo, "tools", "node");
  env[key] = (existsSync(node) ? node + delimiter : "") + (env[key] ?? "");
  // Electron's own variables from this process must not leak into the tools it starts.
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

function defaultRun(logFile: string): NonNullable<FixTestDeps["run"]> {
  return (cmd, args, cwd, o) => new Promise((resolve) => {
    appendFileSync(logFile, `\n> ${cmd} ${args.join(" ")}   (in ${cwd})\n`);
    const child = spawn(cmd, args, { cwd, env: o.env, shell: o.shell ?? false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const take = (d: Buffer) => { const s = d.toString("utf8"); appendFileSync(logFile, s); if (o.capture && out.length < 1_000_000) out += s; };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => { if (child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); };
    o.signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => { appendFileSync(logFile, `\n${e.message}\n`); resolve({ code: null, out }); });
    child.on("close", (code) => { o.signal?.removeEventListener("abort", kill); appendFileSync(logFile, `\n(exit ${code})\n`); resolve({ code, out }); });
  });
}

/**
 * Reads app.asar as a plain file. Inside Electron, fs treats *.asar as an archive to open (and keeps it open):
 * the read failed and the open handle then stopped the worktree from being deleted (2026-10-19).
 */
function readPlain(file: string): Buffer {
  const p = process as NodeJS.Process & { noAsar?: boolean };
  const before = p.noAsar;
  p.noAsar = true;
  try { return readFileSync(file); } finally { p.noAsar = before; }
}
const asarId = (file: string) => createHash("sha256").update(readPlain(file)).digest("hex").slice(0, 12);

/** Deletes what is left of a work folder git could not delete; the node_modules junction goes first, so the project's packages are never reached. */
function removeLeftover(wt: string): void {
  const nm = join(wt, "node_modules");
  try { if (lstatSync(nm).isSymbolicLink()) unlinkSync(nm); } catch { /* no junction */ }
  if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) throw new Error(`could not remove the junction ${nm}`);
  const p = process as NodeJS.Process & { noAsar?: boolean };
  const before = p.noAsar;
  p.noAsar = true;   // pack/win-unpacked/resources/app.asar is a file to delete, not a folder to walk
  try { rmSync(wt, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } finally { p.noAsar = before; }
}

export async function testFix(d: FixTestDeps, signal?: AbortSignal): Promise<FixTestResult> {
  mkdirSync(dirname(d.logFile), { recursive: true });
  const run = d.run ?? defaultRun(d.logFile);
  const env = projectEnv(d.repo);
  const wt = worktreeOf(d.root, d.invId), branch = branchOf(d.invId);
  const STEPS = 10;
  let n = 0;
  const step = async (label: string, cmd: string, args: string[], cwd: string, shell = false, capture = false) => {
    if (signal?.aborted) throw new Error("cancelled by the user");
    d.progress?.(label, ++n, STEPS);
    const r = await run(cmd, args, cwd, { shell, env, signal, capture });
    if (signal?.aborted) throw new Error("cancelled by the user");
    if (r.code !== 0) throw new Error(`${label} failed (exit ${r.code}); log: ${d.logFile}`);
    return r.out;
  };
  if (!/^[0-9a-f]{40}$/.test(d.base)) throw new Error("bad base commit");
  const patch = readFileSync(d.patchFile, "utf8");
  const review = reviewPatch(patch);
  if (review.refused.length) throw new Error(`the patch is refused: ${review.refused[0]}`);

  // An earlier test of this fix may have left its worktree, folder or branch: clear them first.
  await cleanUpFix(d.repo, d.root, d.invId, false, d.logFile, run);
  if (existsSync(wt)) throw new Error(`the work folder ${wt} from an earlier test could not be removed (a file in it may be open); close what uses it, or restart Windows, and try again`);
  await step("worktree", "git", ["-C", d.repo, "worktree", "add", "-b", branch, wt, d.base], d.repo);
  const listed = await step("check the patch", "git", ["apply", "--check", "--numstat", d.patchFile], wt, false, true);
  const gitPaths = numstatPaths(listed).sort(), hostPaths = review.files.map((f) => f.path).sort();
  if (JSON.stringify(gitPaths) !== JSON.stringify(hostPaths)) throw new Error(`git and the host read different file lists from the patch (git: ${gitPaths.join(", ").slice(0, 200)})`);
  await step("apply", "git", ["apply", "--index", d.patchFile], wt);
  await step("commit", "git", ["commit", "-q", "--no-verify", "-m", `LASS fix ${d.invId}: ${d.summaryLine.replace(/[\r\n]+/g, " ").slice(0, 120)}`], wt);
  const depsChanged = review.files.some((f) => f.path === "package.json" || f.path === "package-lock.json");
  if (!depsChanged && existsSync(join(d.repo, "node_modules"))) { symlinkSync(join(d.repo, "node_modules"), join(wt, "node_modules"), "junction"); n++; }
  else await step("npm ci", "npm", ["ci", "--no-audit", "--no-fund"], wt, true);
  await step("typecheck", "npm", ["run", "typecheck"], wt, true);
  await step("unit tests", "node", ["scripts/run-tests.mjs", "test/unit"], wt);
  await step("e2e tests", "npm", ["run", "test:e2e"], wt, true);
  await step("package", "node", ["scripts/package.mjs", `--instance=${d.root}`, "--install-only"], wt);
  d.progress?.("security tests (about 15 minutes)", STEPS, STEPS);
  const r = await run("node", ["scripts/record-host-suite.mjs", `--instance=${d.root}`], wt, { env, signal });
  if (signal?.aborted) throw new Error("cancelled by the user");
  if (r.code !== 0) throw new Error(`the security tests failed (exit ${r.code}); log: ${d.logFile}`);

  // The host's own checks: what was installed is what was tested.
  const asar = join(wt, "pack", "win-unpacked", "resources", "app.asar");
  if (!existsSync(asar)) throw new Error("the package step left no app.asar");
  const build = asarId(asar);
  const installed = join(d.root, "app", build, "resources", "app.asar");
  if (!existsSync(installed) || asarId(installed) !== build) throw new Error(`build ${build} is not installed in ${join(d.root, "app")}`);
  const hash = buildHash(join(wt, "dist"));
  if (!(recordedHashes(join(d.root, "data", "generator", "host-suite.json")) ?? []).includes(hash)) throw new Error("the security-test record does not name the tested build");
  return { build, buildHash: hash, worktree: wt, branch };
}

/** Rejecting a fix: the worktree goes; the branch goes too unless keepBranch (an installed fix keeps it for merging). */
export async function cleanUpFix(repo: string, root: string, invId: string, keepBranch: boolean, logFile: string, run?: FixTestDeps["run"]): Promise<void> {
  const r = run ?? defaultRun(logFile);
  const wt = worktreeOf(root, invId);
  if (existsSync(wt)) {
    // The node_modules junction first, so removing the worktree can never reach the project's packages.
    const nm = join(wt, "node_modules");
    try { if (lstatSync(nm).isSymbolicLink()) unlinkSync(nm); } catch { /* no junction */ }
    if (existsSync(nm) && lstatSync(nm).isSymbolicLink()) throw new Error(`could not remove the junction ${nm}`);
    await r("git", ["-C", repo, "worktree", "remove", "--force", wt], repo, {});
    // git unregisters the worktree even when it cannot delete every file; delete the rest.
    if (existsSync(wt)) removeLeftover(wt);
  }
  await r("git", ["-C", repo, "worktree", "prune"], repo, {});
  if (!keepBranch) await r("git", ["-C", repo, "branch", "-D", branchOf(invId)], repo, {});
}
