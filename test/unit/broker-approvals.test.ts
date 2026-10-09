/** Broker (lazy grants, identity, approval re-checks) and approval records, without Electron. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog } from "../../src/main/audit.js";
import { Broker, type HostServices, type PortLike } from "../../src/main/broker/broker.js";
import { ApprovalStore, hashCardFolder, parseApproval, versionHash, type ApprovalRecord } from "../../src/main/cards/approvals.js";
import type { RetMsg } from "../../src/shared/protocol.js";

function env(permissions: ApprovalRecord["permissions"]) {
  const dir = mkdtempSync(join(tmpdir(), "broker-"));
  const files = { "manifest.json": "a".repeat(64), "ui.js": "b".repeat(64) };
  const rec: ApprovalRecord = { schema: 1, cardId: "test-card", version: "1.0.0", versionHash: versionHash(files), files, permissions, approvedAt: "", revoked: false };
  mkdirSync(join(dir, "approvals"));
  writeFileSync(join(dir, "approvals", "test-card.json"), JSON.stringify(rec));
  const approvals = new ApprovalStore(join(dir, "approvals"));
  const audit = new AuditLog(join(dir, "audit"));
  const stopped: string[] = [];
  const services: HostServices = {
    config: () => ({}),
    sysinfo: async (f) => ({ field: f }),
    ui: { setStatus() {}, notify() {}, setAccent() {}, openLink: async () => {}, confirm: async () => false },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {} },
    stopCard: (id, reason) => stopped.push(`${id}: ${reason}`),
  };
  const broker = new Broker(approvals, audit, services, { instanceRoot: join(dir, "Build"), resolvePath: (p) => p, maxDenials: 3 });
  return { dir, rec, approvals, audit, broker, stopped };
}

function port() {
  const sent: RetMsg[] = [];
  let closed = false;
  const p: PortLike = { postMessage: (m) => { if (!closed) sent.push(m as RetMsg); }, close: () => { closed = true; } };
  return { p, sent, isClosed: () => closed };
}

const call = (id: number, m: string, ...a: unknown[]) => ({ t: "call", id, m, a });

test("grants are lazy, recorded once, and dropped with the session", async () => {
  const e = env([{ type: "sysinfo", fields: ["cpu"], reason: "shows the CPU load" }]);
  await e.approvals.load("test-card");
  const { p, sent, isClosed } = port();
  const s = e.broker.openSession("test-card", e.rec.versionHash, p);
  assert.equal(s.grants.size, 0);
  await e.broker.handle(s, call(1, "sysinfo.cpu"));
  await e.broker.handle(s, call(2, "sysinfo.cpu"));
  assert.deepEqual(sent.map((m) => m.ok), [true, true]);
  assert.equal(s.grants.size, 1);
  assert.equal(e.audit.entries({ kind: "grant" }).length, 1);
  const ctl = new AbortController();
  s.inflight.add(ctl);
  let watchClosed = false;
  s.resources.add({ close: () => { watchClosed = true; } });
  e.broker.endSession(s, "Stop");
  assert.equal(s.grants.size, 0);
  assert.ok(ctl.signal.aborted && watchClosed && isClosed());
  assert.equal(e.broker.liveSessions().length, 0);
  await e.broker.handle(s, call(3, "sysinfo.cpu"));   // an ended session answers nothing
  assert.equal(sent.length, 2);
});

test("calls outside the approval are denied, logged, and repeated denials stop the card", async () => {
  const e = env([]);
  await e.approvals.load("test-card");
  const { p, sent } = port();
  const s = e.broker.openSession("test-card", e.rec.versionHash, p);
  for (let i = 1; i <= 3; i++) await e.broker.handle(s, call(i, "sysinfo.memory"));
  assert.ok(sent.every((m) => !m.ok && m.e.code === "PermissionDenied"));
  assert.equal(s.grants.size, 0);
  assert.equal(e.audit.entries({ kind: "denied" }).length, 3);
  assert.deepEqual(e.stopped, ["test-card: made too many requests it is not allowed to make"]);
});

test("revoked or mismatched approvals refuse the next call and stop the card", async () => {
  const e = env([{ type: "sysinfo", fields: ["cpu"], reason: "shows the CPU load" }]);
  await e.approvals.load("test-card");
  const a = port();
  const s1 = e.broker.openSession("test-card", "f".repeat(64), a.p);      // not the approved version
  await e.broker.handle(s1, call(1, "sysinfo.cpu"));
  assert.equal(a.sent[0].ok === false && a.sent[0].e.code, "PermissionDenied");
  const b = port();
  const s2 = e.broker.openSession("test-card", e.rec.versionHash, b.p);
  await e.broker.handle(s2, call(1, "sysinfo.cpu"));
  assert.equal(b.sent[0].ok, true);
  await e.approvals.revoke("test-card");
  await e.broker.handle(s2, call(2, "sysinfo.cpu"));
  assert.equal(b.sent[1].ok === false && b.sent[1].e.code, "PermissionDenied");
  assert.equal(e.stopped.length, 2);
});

test("file scopes inside the instance are refused even when approved (invariant 12)", async () => {
  const e = env([{ type: "fs.read", path: "X", reason: "reads a folder" }]);
  const inside = join(e.dir, "Build", "data", "cards");
  (e.rec.permissions[0] as { path: string }).path = inside;
  writeFileSync(join(e.dir, "approvals", "test-card.json"), JSON.stringify(e.rec));
  await e.approvals.load("test-card");
  const { p, sent } = port();
  const s = e.broker.openSession("test-card", e.rec.versionHash, p);
  await e.broker.handle(s, call(1, "fs.readText", join(inside, "x", "ui.js")));
  assert.equal(sent[0].ok === false && sent[0].e.message, "cards can never access the Dashboard's own folder");
  assert.equal(s.grants.size, 0);
});

test("approval records are self-consistent; tampering is detected", () => {
  const files = { "manifest.json": "1".repeat(64), "ui.js": "2".repeat(64) };
  const good = { schema: 1, cardId: "abc", version: "1.0.0", versionHash: versionHash(files), files, permissions: [], approvedAt: "", revoked: false };
  assert.equal(parseApproval(JSON.stringify(good), "abc").cardId, "abc");
  assert.throws(() => parseApproval(JSON.stringify(good), "other"), /another card/);
  assert.throws(() => parseApproval(JSON.stringify({ ...good, files: { ...files, "ui.js": "3".repeat(64) } }), "abc"), /does not match/);
  assert.throws(() => parseApproval(JSON.stringify({ ...good, files: { ...files, "../x.js": "3".repeat(64) } }), "abc"), /invalid file entry/);
});

test("card folders with links, unexpected files or folders are refused", async () => {
  const base = mkdtempSync(join(tmpdir(), "cardfolder-"));
  const mk = (name: string, extra: (d: string) => void) => {
    const d = join(base, name);
    mkdirSync(d);
    writeFileSync(join(d, "manifest.json"), "{}");
    writeFileSync(join(d, "ui.js"), "");
    extra(d);
    return d;
  };
  assert.deepEqual(Object.keys(await hashCardFolder(mk("ok", () => {}))).sort(), ["manifest.json", "ui.js"]);
  await assert.rejects(hashCardFolder(mk("junction", (d) => symlinkSync(base, join(d, "assets"), "junction"))), /link/);
  await assert.rejects(hashCardFolder(mk("claude", (d) => mkdirSync(join(d, ".claude")))), /unexpected folder/);
  await assert.rejects(hashCardFolder(mk("mcp", (d) => writeFileSync(join(d, ".mcp.json"), "{}"))), /unexpected file/);
});

test("alternate data streams: invisible to the walker, never part of the hash, never servable", async () => {
  // Directory listings do not show ADS, so hashCardFolder cannot see them. They are harmless for an
  // installed card (only main streams are hashed and served; ':' is rejected in every served path),
  // but VALIDATOR.md V0 rejects them in staging: that needs FindFirstStreamW in the native file helper.
  const d = mkdtempSync(join(tmpdir(), "ads-"));
  writeFileSync(join(d, "manifest.json"), "{}");
  writeFileSync(join(d, "ui.js"), "main");
  const before = await hashCardFolder(d);
  writeFileSync(join(d, "ui.js:hidden"), "planted");
  assert.deepEqual(await hashCardFolder(d), before);
  const { isCardFilePath } = await import("../../src/main/cards/approvals.js");
  assert.equal(isCardFilePath("ui.js:hidden"), false);
});
