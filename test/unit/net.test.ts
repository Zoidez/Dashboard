/** The broker's HTTP client: address classification, DNS pinning, redirect re-checks (TESTPLAN A5). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { brokerRequest, nonPublicReason, v6Bytes, NetError } from "../../src/main/broker/net.js";
import type { Permission } from "../../src/main/broker/permissions.js";

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler!(req, res); });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port, hits })));
}
const net = (origin: string, methods: Permission extends never ? never : ("GET" | "POST")[] = ["GET"], pathPrefix = "/"): Permission =>
  ({ type: "net.http", origin, pathPrefix, methods, reason: "test permission for the broker" });

async function rejectsWith(p: Promise<unknown>, code: string, re?: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof NetError, String(e));
    assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
}

test("non-public addresses are recognised in every form", () => {
  const priv = ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::", "2001:0:4136:e378::1", "::127.0.0.1"];
  for (const ip of priv) assert.notEqual(nonPublicReason(ip), null, ip);
  for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "172.32.0.1"]) assert.equal(nonPublicReason(ip), null, ip);
  assert.equal(nonPublicReason("fe80::1%eth0"), "unparsable address");
  assert.deepEqual(v6Bytes("::ffff:1.2.3.4")?.slice(10), [0xff, 0xff, 1, 2, 3, 4]);
});

test("an explicitly named loopback origin works; the address is resolved once and pinned", async () => {
  const { server, port, hits } = await listen((_q, s) => { s.setHeader("set-cookie", "a=b"); s.end("hello"); });
  let lookups = 0;
  try {
    const r = await brokerRequest({ url: `http://localhost:${port}/x`, headers: { Cookie: "secret=1", "X-Ok": "1" } }, [net(`http://localhost:${port}`)], {
      resolve: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; },
    });
    assert.equal(r.status, 200);
    assert.equal(new TextDecoder().decode(r.body), "hello");
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(lookups, 1);
    assert.deepEqual(hits, ["GET /x"]);
  } finally { server.close(); }
});

test("a hostname that resolves to a private address is refused (DNS rebinding, mixed answers)", async () => {
  const { server, port, hits } = await listen((_q, s) => s.end("should not happen"));
  try {
    await rejectsWith(brokerRequest({ url: `http://rebind.example:${port}/` }, [net(`http://rebind.example:${port}`)], {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    }), "PermissionDenied", /loopback/);
    await rejectsWith(brokerRequest({ url: `http://mixed.example:${port}/` }, [net(`http://mixed.example:${port}`)], {
      resolve: async () => [{ address: "93.184.215.14", family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }],
    }), "PermissionDenied", /only public addresses/);
    assert.deepEqual(hits, []);
  } finally { server.close(); }
});

test("private IP literals: only a permission naming that exact address reaches it", async () => {
  // Not named: the mapped form of loopback is a different origin, so nothing covers it.
  await rejectsWith(brokerRequest({ url: "http://[::ffff:127.0.0.1]:9/" }, [net("http://127.0.0.1:9")]), "PermissionDenied");
  // Named explicitly: the broker connects (port 9 refuses, which proves the attempt was made).
  await rejectsWith(brokerRequest({ url: "http://[::ffff:127.0.0.1]:9/" }, [net("http://[::ffff:127.0.0.1]:9")]), "NetworkError", /ECONNREFUSED/);
  // A hostname permission never reaches a private address, whatever DNS says.
  await rejectsWith(brokerRequest({ url: "http://meta.example/latest" }, [net("http://meta.example")], {
    resolve: async () => [{ address: "169.254.169.254", family: 4 }],
  }), "PermissionDenied", /link-local/);
});

test("redirects are followed hop by hop and every hop is re-checked", async () => {
  const b = await listen((_q, s) => s.end("from b"));
  const a = await listen((q, s) => {
    if (q.url === "/to-b") { s.statusCode = 302; s.setHeader("location", `http://127.0.0.1:${b.port}/landed`); s.end(); return; }
    if (q.url === "/to-a") { s.statusCode = 301; s.setHeader("location", "/final"); s.end(); return; }
    if (q.url === "/loop") { s.statusCode = 302; s.setHeader("location", "/loop"); s.end(); return; }
    s.end("final");
  });
  try {
    const onlyA = [net(`http://127.0.0.1:${a.port}`)];
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${a.port}/to-b` }, onlyA), "PermissionDenied", /redirect/);
    assert.deepEqual(b.hits, []);
    const ok = await brokerRequest({ url: `http://127.0.0.1:${a.port}/to-a` }, onlyA);
    assert.equal(new TextDecoder().decode(ok.body), "final");
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${a.port}/loop` }, onlyA), "NetworkError", /redirects/);
  } finally { a.server.close(); b.server.close(); }
});

test("method, path prefix and request shape are enforced", async () => {
  const { server, port, hits } = await listen((_q, s) => s.end("x"));
  try {
    const p = [net(`http://127.0.0.1:${port}`, ["GET"], "/api")];
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/api/x`, method: "POST", body: "data" }, p), "PermissionDenied");
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/apix` }, p), "PermissionDenied");
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/api`, extra: 1 }, p), "InvalidArgument");
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/api`, headers: { "X-Bad": "a\r\nInjected: 1" } }, p), "InvalidArgument");
    await rejectsWith(brokerRequest({ url: `http://user:pw@127.0.0.1:${port}/api` }, p), "InvalidArgument");
    await rejectsWith(brokerRequest({ url: "file:///C:/Windows/win.ini" }, p), "PermissionDenied");
    assert.deepEqual(hits, []);
  } finally { server.close(); }
});

test("timeouts, oversized responses and cancellation", async () => {
  const { server, port } = await listen((q, s) => {
    if (q.url === "/big") { s.write(Buffer.alloc(6 * 1024 * 1024)); s.end(Buffer.alloc(6 * 1024 * 1024)); return; }
    /* /slow never answers */
  });
  try {
    const p = [net(`http://127.0.0.1:${port}`)];
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 }, p), "Timeout");
    await rejectsWith(brokerRequest({ url: `http://127.0.0.1:${port}/big` }, p), "TooLarge");
    const ctl = new AbortController();
    const pending = brokerRequest({ url: `http://127.0.0.1:${port}/slow` }, p, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    await rejectsWith(pending, "NetworkError", /card stopped/);
  } finally { server.closeAllConnections(); server.close(); }
});
