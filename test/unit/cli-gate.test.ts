/**
 * CLI gate (TESTPLAN B1). The fake CLI is a real Windows .exe compiled with the C# compiler that
 * ships with Windows (.NET Framework): it prints a version for --version and otherwise stays alive
 * like a running generation. Windows does not allow writing to a running .exe, so "the binary
 * changed" is simulated the way an update would do it: rename the running file, put another in place.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyCli, sha256File, GeneratorGate, GateError, parseApproval, compareVersions } from "../../src/main/generator/cli-gate.js";

const CSC = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const buildDir = mkdtempSync(join(tmpdir(), "gate-build-"));
const builds = new Map<string, string>();

function fakeCli(version: string, variant = ""): string {
  const key = `${version}|${variant}`;
  const hit = builds.get(key);
  if (hit) return hit;
  const dir = join(buildDir, String(builds.size));
  mkdirSync(dir);
  const src = join(dir, "fake.cs");
  writeFileSync(src, `class P { const string V = "${variant}"; static int Main(string[] a) {
    if (a.Length > 0 && a[0] == "--version") { System.Console.WriteLine("${version} (Claude Code)" + (V.Length > 99 ? V : "")); return 0; }
    System.Threading.Thread.Sleep(30000); return 0; } }`);
  const exe = join(dir, "claude.exe");
  execFileSync(CSC, ["/nologo", "/target:exe", `/out:${exe}`, src], { windowsHide: true });
  builds.set(key, exe);
  return exe;
}

before(() => {
  if (process.platform !== "win32" || !existsSync(CSC)) throw new Error(`these tests need Windows and ${CSC}`);
});

async function setup(opts: { cliVersion?: string; approval?: Partial<Record<string, unknown>> | null; hashOverride?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const exePath = join(dir, "claude.exe");
  copyFileSync(fakeCli(opts.cliVersion ?? "2.1.293"), exePath);
  const approvalPath = join(dir, "cli-approval.json");
  if (opts.approval !== null) {
    const rec = {
      schema: 1, status: "approved", version: "2.1.293", sha256: opts.hashOverride ?? (await sha256File(exePath)),
      harness: "3.10", decidedAt: new Date().toISOString(), runs: ["r1"], failed: [], missing: [], ...(opts.approval ?? {}),
    };
    writeFileSync(approvalPath, JSON.stringify(rec));
  }
  return { dir, exePath, approvalPath };
}

const exitOf = (child: import("node:child_process").ChildProcess) =>
  new Promise<void>((res) => { if (child.exitCode !== null) res(); else child.once("exit", () => res()); });

test("approved build passes", async () => {
  const s = await setup();
  const r = await verifyCli(s);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("no approval file: refused", async () => {
  const s = await setup({ approval: null });
  const r = await verifyCli(s);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /no CLI approval file/);
});

test("incomplete or blocked approval: refused", async () => {
  for (const status of ["incomplete", "blocked"]) {
    const s = await setup({ approval: { status } });
    const r = await verifyCli(s);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, new RegExp(status));
  }
});

test("different binary (hash mismatch): refused", async () => {
  const s = await setup({ hashOverride: "a".repeat(64) });
  const r = await verifyCli(s);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /not the build the spike approved/);
});

test("binary reports another version: refused", async () => {
  const s = await setup({ cliVersion: "2.1.300" });
  const r = await verifyCli(s);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /reports version 2\.1\.300/);
});

test("approval from an old spike harness: refused", async () => {
  const s = await setup({ approval: { harness: "3.7" } });
  const r = await verifyCli(s);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /harness 3\.7/);
});

test("malformed approval files: refused", () => {
  assert.throws(() => parseApproval("not json"), /not valid JSON/);
  assert.throws(() => parseApproval(JSON.stringify({ schema: 2 })), /schema 2/);
  assert.throws(() => parseApproval(JSON.stringify({ schema: 1, version: "x", sha256: "a".repeat(64), harness: "3.7", status: "approved" })), /version/);
  assert.equal(compareVersions("3.10", "3.7"), 1);
});

test("tested list: the installed build is looked up by its hash; reason codes tell the states apart", async () => {
  const s = await setup({ approval: null });
  const sha = await sha256File(s.exePath);
  const rec = (over: object) => ({ schema: 1, status: "approved", version: "2.1.293", sha256: sha, harness: "3.10", decidedAt: "", runs: ["r"], failed: [], missing: [], ...over });
  const write = (builds: object[]) => writeFileSync(s.approvalPath, JSON.stringify({ schema: 2, builds }));
  write([rec({ version: "2.1.290", sha256: "b".repeat(64) }), rec({})]);
  assert.equal((await verifyCli(s)).ok, true);
  write([rec({ sha256: "c".repeat(64) })]);
  const mism = await verifyCli({ ...s, buildFolder: "2.1.293-0123456789ab" });
  assert.equal(mism.ok === false && mism.code, "hash-mismatch");
  const untested = await verifyCli({ ...s, buildFolder: "2.1.300-0123456789ab" });
  assert.equal(untested.ok === false && untested.code, "untested");
  write([rec({ status: "incomplete", missing: ["T9|x"] })]);
  assert.equal(((await verifyCli(s)) as { code: string }).code, "incomplete");
  write([rec({ harness: "3.9" })]);
  assert.equal(((await verifyCli(s)) as { code: string }).code, "old-harness");
  const legacy = join(s.dir, "legacy.json");
  writeFileSync(legacy, JSON.stringify(rec({})));
  assert.equal((await verifyCli({ ...s, approvalPath: join(s.dir, "missing.json"), legacyApprovalPath: legacy })).ok, true);
});


test("launch refused when not approved, and nothing is started", async () => {
  const s = await setup({ approval: { status: "blocked" } });
  const gate = new GeneratorGate(s);
  await assert.rejects(gate.launch([], {}), GateError);
  assert.equal(gate.runningCount, 0);
  assert.equal(gate.state.enabled, false);
});

test("binary replaced while a generation runs: the gate kills it (taskkill /T) and disables itself", async () => {
  const s = await setup();
  const gate = new GeneratorGate(s);
  const child = await gate.launch(["-p"], { stdio: "pipe" });
  assert.equal(gate.state.enabled, true);
  assert.equal(gate.runningCount, 1);
  const exited = exitOf(child);
  const disabled = new Promise<string>((res) => gate.once("disabled", res));
  gate.startWatching();
  renameSync(s.exePath, s.exePath + ".old");                       // a running .exe can be renamed, not written
  copyFileSync(fakeCli("2.1.293", "other build"), s.exePath);      // same version text, different bytes
  const reason = await disabled;
  assert.match(reason, /not the build the spike approved|cannot read the CLI binary/);
  await exited;
  assert.equal(gate.runningCount, 0);
  await assert.rejects(gate.launch([], {}), GateError);            // stays refused
  gate.stopWatching();
});

test("approval file changed to blocked while a generation runs: killed", async () => {
  const s = await setup();
  const gate = new GeneratorGate(s);
  const child = await gate.launch([], { stdio: "pipe" });
  const exited = exitOf(child);
  gate.startWatching();
  writeFileSync(s.approvalPath, JSON.stringify({ schema: 1, status: "blocked", version: "2.1.293", sha256: await sha256File(s.exePath), harness: "3.10", decidedAt: "", runs: [], failed: ["x"], missing: [] }));
  await exited;
  assert.equal(gate.state.enabled, false);
  gate.stopWatching();
});
