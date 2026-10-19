/**
 * The launcher (docs/LASS.md 8, launcher/Launcher.cs): starts the current build; tries a pending build
 * and keeps it only when it reports ready with a matching security-test record in time; otherwise rolls
 * back to the previous build and records why. Fake builds stand in for Dashboard.exe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error: a plain .mjs build script without type declarations
import { buildLauncher, CSC } from "../../scripts/build-launcher.mjs";

const have = existsSync(CSC as string);
const work = mkdtempSync(join(tmpdir(), "launcher-"));
let launcher = "", fakeExe = "";

// The fake build: reads behavior.txt next to it, marks that it started, and maybe writes the ready report.
const FAKE = `
using System; using System.IO; using System.Threading; using System.Diagnostics;
static class Fake { static void Main() {
  string dir = AppDomain.CurrentDomain.BaseDirectory, id = new DirectoryInfo(dir).Name;
  string root = Path.GetFullPath(Path.Combine(dir, "..", ".."));
  string mode = File.ReadAllText(Path.Combine(dir, "behavior.txt")).Trim();
  Directory.CreateDirectory(Path.Combine(root, "data", "launcher"));
  File.AppendAllText(Path.Combine(root, "data", "started.txt"), id + "\\n");
  int pid = Process.GetCurrentProcess().Id;
  if (mode == "exit") return;
  if (mode == "ready" || mode == "bad-suite")
    File.WriteAllText(Path.Combine(root, "data", "launcher", "ready.json"), "{\\"pid\\":" + pid + ",\\"build\\":\\"x\\",\\"hostSuiteOk\\":" + (mode == "ready" ? "true" : "false") + "}");
  Thread.Sleep(8000);
} }`;

function setup() {
  if (!launcher) {
    launcher = buildLauncher(join(work, "bin", "Dashboard.exe"));
    writeFileSync(join(work, "fake.cs"), FAKE);
    fakeExe = join(work, "bin", "fake.exe");
    execFileSync(CSC as string, ["/nologo", "/target:winexe", `/out:${fakeExe}`, join(work, "fake.cs")]);
  }
  const root = mkdtempSync(join(work, "inst-"));
  const exe = join(root, "Dashboard.exe");
  writeFileSync(exe, readFileSync(launcher));
  const build = (id: string, mode: string) => { const d = join(root, "app", id); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "Dashboard.exe"), readFileSync(fakeExe)); writeFileSync(join(d, "behavior.txt"), mode); };
  const state = (s?: object) => { const f = join(root, "data", "current-build.json"); if (s) { mkdirSync(join(root, "data"), { recursive: true }); writeFileSync(f, JSON.stringify(s)); } return JSON.parse(readFileSync(f, "utf8")); };
  // stdio ignored: the started (fake) build would otherwise keep the pipes, and the test, waiting.
  const run = (...args: string[]) => spawnSync(exe, ["--no-splash", ...args], { timeout: 60_000, stdio: "ignore" }).status;
  const read = () => (existsSync(join(root, "data", "started.txt")) ? readFileSync(join(root, "data", "started.txt"), "utf8").split("\n").filter(Boolean) : []);
  // The launcher exits right after starting a build; give the build up to 5 s to write its marker.
  const started = (n = 1) => { const end = Date.now() + 5000; while (read().length < n && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); return read(); };
  const rollouts = () => (existsSync(join(root, "data", "lass", "rollouts.jsonl")) ? readFileSync(join(root, "data", "lass", "rollouts.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, build, state, run, started, rollouts };
}

const A = "aaaaaaaaaaaa", B = "bbbbbbbbbbbb", C = "cccccccccccc";

test("no pending build: the current one starts", { skip: !have && "no C# compiler", timeout: 120_000 }, () => {
  const t = setup();
  t.build(A, "ready"); t.state({ current: A });
  assert.equal(t.run(), 0);
  assert.deepEqual(t.started(), [A]);
});

test("a pending build that reports ready with a matching record becomes current", { skip: !have && "no C# compiler", timeout: 120_000 }, () => {
  const t = setup();
  t.build(A, "ready"); t.build(B, "ready"); t.state({ current: A, pending: B });
  assert.equal(t.run(), 0);
  assert.deepEqual(t.state(), { current: B, previous: A });
  assert.deepEqual(t.started(), [B]);
  assert.equal(t.rollouts()[0].ok, true);
});

test("rollback: a mismatched security record, a hang, or an early exit restarts the previous build", { skip: !have && "no C# compiler", timeout: 180_000 }, () => {
  for (const [mode, reason] of [["bad-suite", /security-test record does not match/], ["hang", /did not report ready within 2 s/], ["exit", /exited/]] as const) {
    const t = setup();
    t.build(A, "ready"); t.build(B, mode); t.state({ current: A, previous: C, pending: B });
    assert.equal(t.run("--timeout", "2"), 3, mode);
    assert.deepEqual(t.state(), { current: A, previous: C }, `${mode}: state unchanged, pending dropped`);
    assert.deepEqual(t.started(2), [B, A], `${mode}: tried B, then started A again`);
    const r = t.rollouts()[0];
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  }
});

test("only well-formed build ids count; a missing pending build rolls back; old builds are cleaned up", { skip: !have && "no C# compiler", timeout: 120_000 }, () => {
  const t = setup();
  t.build(A, "ready");
  t.state({ current: A, pending: "..\\..\\evil" });
  assert.equal(t.run(), 0, "an invalid pending id is ignored: the current build starts");
  assert.deepEqual(t.started(), [A]);
  const u = setup();
  u.build(A, "ready"); u.state({ current: A, pending: B });
  assert.equal(u.run("--timeout", "2"), 3);
  assert.match(u.rollouts()[0].reason, /not installed/);
  const v = setup();
  for (const id of ["111111111111", "222222222222", "333333333333", A]) v.build(id, "ready");
  v.build(B, "ready"); v.state({ current: A, pending: B });
  assert.equal(v.run(), 0);
  const left = ["111111111111", "222222222222", "333333333333", A, B].filter((id) => existsSync(join(v.root, "app", id)));
  assert.ok(left.includes(A) && left.includes(B), "current and previous stay");
  assert.equal(left.length, 3, `three builds kept: ${left.join(",")}`);
});

test("a packaged build finds its instance: side by side (app/<build-id>/) and the older flat layout", async () => {
  const { instanceRootFrom } = await import("../../src/main/instance.js");
  const root = resolve("D:/X/Build");
  assert.equal(instanceRootFrom([], true, join(root, "app", "02d730f76660", "Dashboard.exe"), "C:/"), root, "side by side: three folders up (2026-10-19 bug: it took Build/app)");
  assert.equal(instanceRootFrom([], true, join(root, "app", "Dashboard.exe"), "C:/"), root, "flat: two folders up");
  assert.equal(instanceRootFrom([], true, join(root, "other", "02d730f76660", "Dashboard.exe"), "C:/"), join(root, "other"), "only under an app folder");
  assert.equal(instanceRootFrom(["--instance=D:/Y"], true, join(root, "app", "02d730f76660", "Dashboard.exe"), "C:/"), resolve("D:/Y"), "--instance wins");
});
