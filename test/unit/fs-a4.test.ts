/**
 * TESTPLAN A4: file attacks against the file check protocol (src/filehelper).
 * Every attack must be refused, and the secret outside the approved folder must never be read or
 * written. A test whose attack could not be set up on this machine reports INCONCLUSIVE (skip with
 * the reason), never PASS.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import koffi from "koffi";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ops from "../../src/filehelper/fs-ops.js";
import { FileCheckError, type CheckContext } from "../../src/filehelper/file-checks.js";

const SECRET = "SECRET-" + Math.random().toString(36).slice(2);
const base = mkdtempSync(join(tmpdir(), "a4-"));
const S = join(base, "approved");          // the approved folder
const O = join(base, "outside");           // never approved
const INSTANCE = join(base, "Build");
const ctx: CheckContext = { instanceRoot: INSTANCE, scope: { path: S, recursive: true } };
const flat: CheckContext = { instanceRoot: INSTANCE, scope: { path: S, recursive: false } };

before(() => {
  for (const d of [S, O, join(S, "inner"), join(S, "deep"), INSTANCE]) mkdirSync(d, { recursive: true });
  writeFileSync(join(S, "ok.txt"), "safe");
  writeFileSync(join(S, "inner", "f.txt"), "safe");
  writeFileSync(join(S, "deep", "d.txt"), "deep");
  writeFileSync(join(O, "f.txt"), SECRET);
  writeFileSync(join(O, "secret.txt"), SECRET);
});

function refused(fn: () => unknown, code?: string, re?: RegExp): FileCheckError {
  try { fn(); } catch (e) {
    assert.ok(e instanceof FileCheckError, `expected a FileCheckError, got ${String(e)}`);
    if (code) assert.equal(e.code, code, e.message);
    if (re) assert.match(e.message, re);
    return e;
  }
  assert.fail("the operation was NOT refused");
}

const noSecretOutside = () => assert.equal(readFileSync(join(O, "secret.txt"), "utf8"), SECRET);

test("baseline: reads and writes inside the approved folder work", () => {
  assert.equal(ops.readText(join(S, "ok.txt"), ctx), "safe");
  ops.writeText(join(S, "w.txt"), "x", ctx);
  assert.equal(readFileSync(join(S, "w.txt"), "utf8"), "x");
});

test("'..' traversal is refused (read and write)", () => {
  refused(() => ops.readText(`${S}\\..\\outside\\secret.txt`, ctx), "InvalidArgument", /"\.\."/);
  refused(() => ops.writeText(`${S}\\..\\outside\\new.txt`, "x", ctx), "InvalidArgument");
  refused(() => ops.readText(`${S}/../outside/secret.txt`, ctx), "InvalidArgument");
  assert.equal(existsSync(join(O, "new.txt")), false);
});

test("\\\\?\\, \\\\.\\ and UNC paths are refused", () => {
  for (const p of [`\\\\?\\${O}\\secret.txt`, `\\\\.\\${O}\\secret.txt`, `\\\\localhost\\${O[0]}$${O.slice(2)}\\secret.txt`, `//localhost/${O[0]}$/x.txt`, `\\\\?\\UNC\\localhost\\c$\\x.txt`]) {
    refused(() => ops.readText(p, ctx), "InvalidArgument", /network, device/);
    refused(() => ops.writeText(p, "x", ctx), "InvalidArgument");
  }
});

test("alternate data streams are refused", () => {
  writeFileSync(join(S, "ok.txt:hidden"), SECRET);
  for (const p of [`${S}\\ok.txt:hidden`, `${S}\\ok.txt::$DATA`, `${S}\\ok.txt:hidden:$DATA`]) {
    refused(() => ops.readText(p, ctx), "InvalidArgument", /alternate data stream/);
    refused(() => ops.writeText(p, "x", ctx), "InvalidArgument");
  }
  assert.equal(ops.readText(join(S, "ok.txt"), ctx), "safe");   // the main stream is untouched
});

test("reserved device names are refused", () => {
  for (const n of ["NUL", "con", "CON.txt", "aux.json", "COM1", "lpt9.log", "COM¹.txt", "CONIN$", "nul .txt"]) {
    refused(() => ops.readText(`${S}\\${n}`, ctx), "InvalidArgument");
    refused(() => ops.writeText(`${S}\\${n}`, "x", ctx), "InvalidArgument");
  }
  refused(() => ops.writeText(`${S}\\trailing.txt.`, "x", ctx), "InvalidArgument", /dot or a space/);
  refused(() => ops.writeText(`${S}\\trailing.txt `, "x", ctx), "InvalidArgument", /dot or a space/);
});

test("a junction inside the approved folder is never followed (last component and on the way)", () => {
  symlinkSync(O, join(S, "jlink"), "junction");
  refused(() => ops.readText(join(S, "jlink", "secret.txt"), ctx), "PermissionDenied", /leads to/);
  refused(() => ops.writeText(join(S, "jlink", "planted.txt"), "x", ctx), "PermissionDenied");
  refused(() => ops.list(join(S, "jlink"), ctx), "PermissionDenied", /is a link/);
  refused(() => ops.stat(join(S, "jlink"), ctx), "PermissionDenied", /is a link/);
  refused(() => ops.mkdir(join(S, "jlink", "newdir"), ctx), "PermissionDenied");
  assert.ok(!ops.list(S, ctx).some((e) => e.path.endsWith("jlink")), "junctions are hidden from listings");
  assert.equal(existsSync(join(O, "planted.txt")), false);
  assert.equal(existsSync(join(O, "newdir")), false);
  noSecretOutside();
});

test("a file symbolic link is never followed", (t) => {
  try { symlinkSync(join(O, "secret.txt"), join(S, "slink.txt"), "file"); }
  catch (e) { t.skip(`INCONCLUSIVE: this account cannot create symbolic links (${(e as NodeJS.ErrnoException).code}); Developer Mode or admin is needed`); return; }
  refused(() => ops.readText(join(S, "slink.txt"), ctx), "PermissionDenied", /is a link/);
  refused(() => ops.writeText(join(S, "slink.txt"), "x", ctx), "PermissionDenied", /is a link/);
  noSecretOutside();
});

test("an 8.3 short name is refused (the real path must equal the requested one)", (t) => {
  const long = join(S, "averyveryverylongfilename.txt");
  writeFileSync(long, "safe");
  // Ask Windows for the short form, and swap in only the file name, so the lexical scope check
  // passes and the refusal must come from the real-path check on the opened handle.
  const k32 = koffi.load("kernel32.dll");
  const GetShortPathNameW = k32.func("uint32_t __stdcall GetShortPathNameW(str16 longPath, _Out_ uint8_t *buf, uint32_t len)");
  const buf = Buffer.alloc(2048);
  const n = GetShortPathNameW(long, buf, 1024) as number;
  const shortName = n ? buf.toString("utf16le", 0, n * 2).split("\\").pop()! : "";
  if (!shortName || shortName.toLowerCase() === "averyveryverylongfilename.txt") { t.skip("INCONCLUSIVE: 8.3 names are disabled on this volume"); return; }
  const short = join(S, shortName);
  console.log(`8.3: ${short}`);
  refused(() => ops.readText(short, ctx), "PermissionDenied", /leads to/);
  refused(() => ops.writeText(short, "x", ctx), "PermissionDenied", /leads to/);
  assert.equal(readFileSync(long, "utf8"), "safe");
});

test("a hard link to an outside file cannot be written through", () => {
  linkSync(join(O, "secret.txt"), join(S, "hard.txt"));
  refused(() => ops.writeText(join(S, "hard.txt"), "overwritten", ctx), "PermissionDenied", /hard link/);
  refused(() => ops.appendText(join(S, "hard.txt"), "more", ctx), "PermissionDenied", /hard link/);
  noSecretOutside();
});

test("paths outside the scope, inside the instance, or below a non-recursive scope are refused", () => {
  refused(() => ops.readText(join(O, "secret.txt"), ctx), "PermissionDenied", /outside the approved folder/);
  refused(() => ops.readText(join(base, "approvedX", "a.txt"), ctx), "PermissionDenied");
  const inInstance: CheckContext = { instanceRoot: INSTANCE, scope: { path: base, recursive: true } };
  refused(() => ops.writeText(join(INSTANCE, "x.txt"), "x", inInstance), "PermissionDenied", /Dashboard's own folder/);
  refused(() => ops.readText(join(S, "deep", "d.txt"), flat), "PermissionDenied");
  refused(() => ops.list(join(S, "deep"), flat), "PermissionDenied");
  assert.equal(ops.readText(join(S, "ok.txt"), flat), "safe");
});

test("type rules: unknown, program and mismatched types are refused; content must match the extension", () => {
  writeFileSync(join(S, "fake.png"), Buffer.from("PK\x03\x04 actually a zip"));
  writeFileSync(join(S, "real.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  writeFileSync(join(S, "bin.txt"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  writeFileSync(join(S, "tool.exe"), Buffer.from("MZ"));
  writeFileSync(join(S, "noext"), "x");
  writeFileSync(join(S, "data.xyz"), "x");
  writeFileSync(join(S, "bad.json"), "{nope");
  refused(() => ops.readBytes(join(S, "fake.png"), ctx), "InvalidArgument", /not a PNG file/);
  assert.equal(ops.readBytes(join(S, "real.png"), ctx).length, 11);
  refused(() => ops.readText(join(S, "real.png"), ctx), "InvalidArgument", /not text/);
  refused(() => ops.readText(join(S, "bin.txt"), ctx), "InvalidArgument", /not (valid )?text/);
  refused(() => ops.readBytes(join(S, "tool.exe"), ctx), "PermissionDenied", /programs and scripts/);
  refused(() => ops.readText(join(S, "noext"), ctx), "PermissionDenied", /no extension/);
  refused(() => ops.readText(join(S, "data.xyz"), ctx), "PermissionDenied", /not supported/);
  refused(() => ops.readText(join(S, "bad.json"), ctx), "InvalidArgument", /not valid JSON/);
  refused(() => ops.writeBytes(join(S, "evil.ps1"), new Uint8Array([1]), ctx), "PermissionDenied", /programs and scripts/);
  refused(() => ops.writeText(join(S, "page.html"), "<html><script>x</script></html>", ctx), "PermissionDenied", /cannot create or change HTML/);
  refused(() => ops.writeBytes(join(S, "pic.png"), new TextEncoder().encode("not a png"), ctx), "InvalidArgument", /not a PNG file/);
  refused(() => ops.appendText(join(S, "bad.json"), "x", ctx), "PermissionDenied", /line-based/);
  refused(() => ops.appendText(join(S, "bin.txt"), "more", ctx), "InvalidArgument");
  for (const n of ["evil.ps1", "page.html", "pic.png"]) assert.equal(existsSync(join(S, n)), false, n);
});

// The junction-swap race (TOCTOU) runs for 5 minutes: test/race/toctou.test.ts (npm run test:race).
