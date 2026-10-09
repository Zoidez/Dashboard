/** Message validation (shared/protocol.ts), scope matching (broker/permissions.ts), instance checks. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCall, RESERVED_RE, METHODS } from "../../src/shared/protocol.js";
import { findCovering, fsScopeCovers, pathPrefixCovers, type Permission } from "../../src/main/broker/permissions.js";
import { isInsideInstance } from "../../src/main/instance.js";

test("only exact call messages pass validation", () => {
  assert.equal(validateCall({ t: "call", id: 1, m: "sysinfo.cpu", a: [] }).ok, true);
  const bad: unknown[] = [
    null, 5, "x", [], { t: "call", id: 1, m: "x", a: [], cardId: "other" },
    { t: "ret", id: 1, m: "x", a: [] }, { t: "call", id: -1, m: "x", a: [] }, { t: "call", id: 1.5, m: "x", a: [] },
    { t: "call", id: 1, m: 7, a: [] }, { t: "call", id: 1, m: "x", a: {} }, { t: "call", id: 1, m: "x", a: new Array(17).fill(0) },
    { t: "call", id: 1, m: "x", a: [new Date()] }, { t: "call", id: 1, m: "x", a: [() => 1] }, { t: "call", id: 1, m: "x", a: [NaN] },
    { t: "call", id: 1, m: "x", a: ["a".repeat(6 * 1024 * 1024)] },
  ];
  for (const b of bad) assert.equal(validateCall(b).ok, false, JSON.stringify(b)?.slice(0, 80));
  const deep: unknown[] = [];
  let cur = deep;
  for (let i = 0; i < 12; i++) { const n: unknown[] = []; cur.push(n); cur = n; }
  assert.equal(validateCall({ t: "call", id: 1, m: "x", a: deep }).ok, false);
  assert.equal(validateCall({ t: "call", id: 1, m: "x", a: [new Uint8Array(10), { a: undefined, b: null }] }).ok, true);
  const v = validateCall({ t: "call", id: 3, m: "x", a: [], extra: 1 });
  assert.equal(v.ok === false && v.id, 3);   // the id is echoed so the card gets an error reply
});

test("reserved namespaces are recognised; ffi is not even a method", () => {
  for (const m of ["process.run", "process.launch", "claude.ask", "bus.emit"]) assert.ok(RESERVED_RE.test(m), m);
  assert.equal(RESERVED_RE.test("ffi.call"), false);
  assert.equal(METHODS.has("ffi.call"), false);
});

test("path prefixes cover whole segments only", () => {
  assert.ok(pathPrefixCovers("/", "/anything"));
  assert.ok(pathPrefixCovers("/api", "/api"));
  assert.ok(pathPrefixCovers("/api", "/api/v1"));
  assert.ok(pathPrefixCovers("/api/", "/api/v1"));
  assert.equal(pathPrefixCovers("/api", "/apix"), false);
  assert.equal(pathPrefixCovers("/api", "/ap"), false);
});

test("file scopes: exact folder, direct children, recursive only when granted", () => {
  assert.ok(fsScopeCovers("C:\\Data", false, "C:\\data\\a.txt"));
  assert.equal(fsScopeCovers("C:\\Data", false, "C:\\Data\\sub\\a.txt"), false);
  assert.ok(fsScopeCovers("C:\\Data", true, "C:\\Data\\sub\\a.txt"));
  assert.equal(fsScopeCovers("C:\\Data", true, "C:\\Database\\a.txt"), false);
  assert.equal(fsScopeCovers("C:\\Data", true, "C:\\Data\\..\\Windows\\win.ini"), false);
});

test("the covering permission must match type, scope and method", () => {
  const perms: Permission[] = [
    { type: "net.http", origin: "https://api.example.com", pathPrefix: "/v1", methods: ["GET"], reason: "reads the example API" },
    { type: "sysinfo", fields: ["cpu"], reason: "shows the CPU load" },
    { type: "reports.read", taskId: "trig_0123456789", reason: "shows the task's reports" },
  ];
  const id = (p: string) => p;
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com/v1/x"), method: "GET" }, id), 0);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com:443/v1/x"), method: "GET" }, id), 0);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com/v1/x"), method: "POST" }, id), -1);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com/v2"), method: "GET" }, id), -1);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com/v1/../v2"), method: "GET" }, id), -1);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://api.example.com/v1/%2e%2e/v2"), method: "GET" }, id), -1);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("http://api.example.com/v1"), method: "GET" }, id), -1);
  assert.equal(findCovering(perms, { type: "net.http", url: new URL("https://evil.api.example.com/v1"), method: "GET" }, id), -1);
  assert.equal(findCovering(perms, { type: "sysinfo", field: "cpu" }, id), 1);
  assert.equal(findCovering(perms, { type: "sysinfo", field: "processes" }, id), -1);
  assert.equal(findCovering(perms, { type: "reports.read", taskId: "trig_0123456789" }, id), 2);
  assert.equal(findCovering(perms, { type: "reports.read", taskId: "trig_9999999999" }, id), -1);
});

test("instance containment is case-insensitive and segment-exact", () => {
  assert.ok(isInsideInstance("D:\\Dash\\Build", "d:\\dash\\build\\data\\x"));
  assert.ok(isInsideInstance("D:\\Dash\\Build", "D:\\Dash\\Build"));
  assert.equal(isInsideInstance("D:\\Dash\\Build", "D:\\Dash\\Build2\\x"), false);
  assert.ok(isInsideInstance("D:\\Dash\\Build", "D:\\Dash\\Other\\..\\Build\\data"));
});
