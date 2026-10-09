import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyCli, sha256File, GeneratorGate, GateError, parseApproval, compareVersions } from "../src/main/generator/cli-gate.js";

// Fake CLI: prints a version for --version, otherwise stays alive (like a running generation).
function makeFakeCli(dir: string, version: string): string {
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version} (Claude Code)"; exit 0; fi\nexec sleep 30\n`);
  chmodSync(p, 0o755);
  return p;
}

async function setup(opts: { cliVersion?: string; approval?: Partial<Record<string, unknown>> | null; hashOverride?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  const exePath = makeFakeCli(dir, opts.cliVersion ?? "2.1.293");
  const approvalPath = join(dir, "cli-approval.json");
  if (opts.approval !== null) {
    const rec = {
      schema: 1, status: "approved", version: "2.1.293", sha256: opts.hashOverride ?? (await sha256File(exePath)),
      harness: "3.8", decidedAt: new Date().toISOString(), runs: ["r1"], failed: [], missing: [], ...(opts.approval ?? {}),
    };
    writeFileSync(approvalPath, JSON.stringify(rec));
  }
  return { dir, exePath, approvalPath, baseEnv: { PATH: process.env.PATH } };
}

test("approved build passes", async () => {
  const s = await setup();
  const r = await verifyCli(s);
  assert.equal(r.ok, true);
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

test("launch refused when not approved, and nothing is started", async () => {
  const s = await setup({ approval: { status: "blocked" } });
  const gate = new GeneratorGate(s);
  await assert.rejects(gate.launch([], {}), GateError);
  assert.equal(gate.runningCount, 0);
  assert.equal(gate.state.enabled, false);
});

test("binary changed while a generation runs: the gate kills it and disables itself", async () => {
  const s = await setup();
  const gate = new GeneratorGate(s);
  const child = await gate.launch(["-p"], { stdio: "pipe" });
  assert.equal(gate.state.enabled, true);
  assert.equal(gate.runningCount, 1);
  const exited = new Promise<string | null>((res) => child.once("exit", (_c, sig) => res(sig)));
  const disabled = new Promise<string>((res) => gate.once("disabled", res));
  gate.startWatching();
  appendFileSync(s.exePath, "\n# tampered\n");          // same version text, different bytes
  const reason = await disabled;
  assert.match(reason, /not the build the spike approved/);
  assert.equal(await exited, "SIGKILL");
  assert.equal(gate.runningCount, 0);
  await assert.rejects(gate.launch([], {}), GateError); // stays refused
  gate.stopWatching();
});

test("approval file revoked while a generation runs: killed", async () => {
  const s = await setup();
  const gate = new GeneratorGate(s);
  const child = await gate.launch([], { stdio: "pipe" });
  const exited = new Promise<string | null>((res) => child.once("exit", (_c, sig) => res(sig)));
  gate.startWatching();
  writeFileSync(s.approvalPath, JSON.stringify({ ...JSON.parse('{"schema":1}'), schema: 1, status: "blocked", version: "2.1.293", sha256: await sha256File(s.exePath), harness: "3.8", decidedAt: "", runs: [], failed: ["x"], missing: [] }));
  assert.equal(await exited, "SIGKILL");
  assert.equal(gate.state.enabled, false);
  gate.stopWatching();
});
