/**
 * The generator pipeline through the app (TESTPLAN B2, B4, B5, C3, C4, D), with a fake claude.exe
 * (test/e2e/fake-cli) installed as an approved build in a throwaway instance. Real Claude is never called.
 */
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHash } from "../../src/main/generator/host-suite";
import { launch, makeInstance, ready, REPO, snapshot, waitFor } from "./helpers";

const CSC = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
let fakeExe = "";
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "fakecli-"));
  fakeExe = join(dir, "claude.exe");
  execFileSync(CSC, ["/nologo", "/target:exe", "/r:System.Web.Extensions.dll", `/out:${fakeExe}`, join(REPO, "test", "e2e", "fake-cli", "FakeClaude.cs")], { windowsHide: true });
});

const GOOD_UI = `export function mount(el, api) {
  el.textContent = "memory";
  api.sysinfo.memory().then((m) => { el.textContent = Math.round(m.usedBytes / 1048576) + " MB used"; api.ui.setStatus({ state: "ok" }); }, (e) => api.ui.setStatus({ state: "error", message: e.message }));
}
export function unmount() {}`;
const manifest = (version = "1.0.0", extra: object[] = []) => JSON.stringify({
  id: "{{CARD_ID}}", name: "Memory meter", version, apiVersion: 0, description: "Shows memory use.",
  permissions: [{ type: "sysinfo", fields: ["memory"], reason: "shows how much memory is in use" }, ...extra],
});
const card = (o: { ui?: string; version?: string; extra?: object[] } = {}) => ({ "manifest.json": manifest(o.version, o.extra), "ui.js": o.ui ?? GOOD_UI, "DEVLOG.md": "# Memory meter\n\n- created from the request\n" });

interface Env { inst: string; exeDir: string }
function genInstance(steps: object[], opts: { approved?: boolean; suite?: boolean } = {}): Env {
  const inst = makeInstance();
  const sha = createHash("sha256").update(readFileSync(fakeExe)).digest("hex");
  const exeDir = join(inst, "data", "vendor", "claude", `2.1.293-${sha.slice(0, 12)}`);
  mkdirSync(exeDir, { recursive: true });
  writeFileSync(join(exeDir, "claude.exe"), readFileSync(fakeExe));
  writeFileSync(join(exeDir, "scenario.json"), JSON.stringify({ steps }));
  mkdirSync(join(inst, "data", "generator"), { recursive: true });
  if (opts.approved !== false) {
    writeFileSync(join(inst, "data", "generator", "cli-approvals.json"), JSON.stringify({ schema: 2, builds: [{ schema: 1, status: "approved", version: "2.1.293", sha256: sha, harness: "3.9", decidedAt: new Date().toISOString(), runs: ["test"], failed: [], missing: [] }] }));
  }
  if (opts.suite !== false) {
    writeFileSync(join(inst, "data", "generator", "host-suite.json"), JSON.stringify({ schema: 1, buildHash: buildHash(join(REPO, "dist")), passedAt: new Date().toISOString(), suites: ["test"] }));
  }
  return { inst, exeDir };
}
const calls = (e: Env) => (existsSync(join(e.exeDir, "calls.jsonl")) ? readFileSync(join(e.exeDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const gen = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__dashboard.pipeline.current);

async function ask(page: Page, text: string, target?: string) {
  if (target) await page.locator('section[data-card="new"] select').first().selectOption({ label: target });
  await page.locator('section[data-card="new"] textarea').fill(text);
  await page.locator('section[data-card="new"] textarea').press("Control+Enter");
}

test("B/C/D: a request becomes a validated, approved, running card; updates show a diff; the lockdown flags are used", async () => {
  const e = genInstance([
    { files: card({ ui: GOOD_UI.replace('el.textContent = "memory";', 'el.innerHTML = "<b>memory</b>";') }) },  // fails V4
    { files: card() },                                                                                     // fixed
    { files: card({ version: "1.0.1", extra: [{ type: "sysinfo", fields: ["memory", "cpu"], reason: "x" }] }) }, // invalid update (duplicate sysinfo, unused cpu)
    { files: card({ version: "1.0.1", ui: GOOD_UI.replace("m.usedBytes", "m.totalBytes - m.freeBytes") }) },  // fixed update
  ]);
  const app = await launch(e.inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    await waitFor(async () => (await gen(app)).gate?.ok === true, "the gate to accept the fake build");
    await ask(page, "Show how much memory is in use");
    const canvasPage = await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("canvas.html"), timeout: 60_000 }).catch(async (err) => { console.log("DIAG pipeline:", JSON.stringify(await gen(app)).slice(0, 3000)); console.log("DIAG calls:", JSON.stringify(calls(e).map((c: any) => c.args.length))); throw err; });
    await canvasPage.waitForSelector(".perms li");
    await expect(canvasPage.locator(".perms li").first()).toContainText("Read your computer's memory use");
    await expect(canvasPage.locator(".perms li").first()).toContainText("Card says: shows how much memory is in use");
    await expect(canvasPage.locator(".banner.red")).toHaveCount(0);
    await Promise.all([canvasPage.waitForEvent("close"), canvasPage.locator("button", { hasText: "Approve" }).click().catch(() => undefined)]);
    await waitFor(async () => (await gen(app)).phase === "done", "install", 30_000);
    const st = await gen(app);
    const cardId = st.cardId as string;
    console.log("generated card:", cardId, "-", st.message);
    expect(cardId).toMatch(/^memory-use-[0-9a-f]{4}$/);
    await waitFor(async () => (await snapshot(app)).running.some((c) => c.cardId === cardId && c.status.state === "ok"), "the new card to run");

    // One retry happened, in the same conversation, with the validator's errors.
    const c = calls(e);
    expect(c.length).toBe(2);
    expect(c[1].args).toEqual(expect.arrayContaining(["--resume", "sess-0"]));
    expect(c[1].stdin).toContain("Validator errors (fix these, change nothing else):");
    expect(c[1].stdin).toContain("innerHTML");
    // The exact lockdown (RULES.md, Run lockdown) and environment.
    for (const flag of ["-p", "--restricted", "--strict-mcp-config", "--disable-slash-commands", "--verbose", "--append-system-prompt"]) expect(c[0].args).toContain(flag);
    const pair = (k: string) => c[0].args[c[0].args.indexOf(k) + 1];
    expect([pair("--tools"), pair("--disallowedTools"), pair("--permission-mode"), pair("--permission-prompts"), pair("--max-turns"), pair("--output-format")]).toEqual(["Read,Edit,Write", "mcp__*", "dontAsk", "none", "12", "stream-json"]);
    expect(pair("--settings").startsWith(join(e.inst, "data", "generator", "host"))).toBe(true);
    expect(c[0].args).not.toContain("--resume");
    expect(c[0].stdin).toContain(`Card ID: ${cardId}`);
    expect(pair("--append-system-prompt")).toContain("Generator rules");
    expect(c[0].cwd.startsWith(join(e.inst, "ClaudeExchange", "staging", cardId))).toBe(true);
    expect(c[0].CLAUDE_CONFIG_DIR).toBe(join(e.inst, "data", "claude"));
    expect(c[0].USERPROFILE.startsWith(join(e.inst, "data", "claude"))).toBe(true);
    expect([c[0].DISABLE_UPDATES, c[0].ENABLE_CLAUDEAI_MCP_SERVERS]).toEqual(["1", "false"]);
    expect(JSON.parse(readFileSync(join(e.inst, "data", "config", cardId, "generator.json"), "utf8")).sessionId).toBe("sess-1");

    // Update: the same conversation; the canvas shows the diff.
    await ask(page, "Compute used memory from total minus free", "Change: Memory meter");
    const cv2 = await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("canvas.html"), timeout: 60_000 });
    await cv2.waitForSelector(".files, table.list");
    await expect(cv2.locator("h1")).toContainText("Approve the update");
    await expect(cv2.locator("table.list")).toContainText("changed");
    await Promise.all([cv2.waitForEvent("close"), cv2.locator("button", { hasText: "Approve" }).click().catch(() => undefined)]);
    await waitFor(async () => (await gen(app)).phase === "done", "the update to install", 30_000);
    const c2 = calls(e);
    expect(c2.length).toBe(4);
    expect(c2[2].args).toEqual(expect.arrayContaining(["--resume", "sess-1"]));
    expect(c2[2].stdin).toContain("Kind: update");
    expect(JSON.parse(readFileSync(join(e.inst, "data", "approvals", `${cardId}.json`), "utf8")).version).toBe("1.0.1");
    expect(readFileSync(join(e.inst, "data", "cards", cardId, "ui.js"), "utf8")).toContain("m.totalBytes - m.freeBytes");
    await waitFor(async () => (await snapshot(app)).running.some((x) => x.cardId === cardId && x.status.state === "ok"), "the updated card to run");
  } finally {
    await app.close();
  }
});

test("B5 and run lockdown: extra tools, writes outside the request folder, an unapproved CLI, an untested host, Stop", async () => {
  // Extra tools in the session: aborted.
  {
    const e = genInstance([{ files: card(), tools: ["Read", "Edit", "Write", "Bash"] }]);
    const app = await launch(e.inst);
    try {
      await ready(app);
      const page = await app.firstWindow();
      await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
      await ask(page, "Show memory");
      const st = await waitFor(async () => { const s = await gen(app); return s.phase === "failed" ? s : null; }, "the run to be refused");
      expect(st.message).toContain("tools beyond Read/Edit/Write (Bash)");
      await expect(page.locator('section[data-card="new"] textarea')).toHaveValue("Show memory");     // text kept on failure
    } finally { await app.close(); }
  }
  // A file appears outside the request folder: refused before validation.
  {
    const e = genInstance([{ files: { ...card(), "../escaped.txt": "x" } }]);
    const app = await launch(e.inst);
    try {
      await ready(app);
      await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
      await ask(await app.firstWindow(), "Show memory");
      const st = await waitFor(async () => { const s = await gen(app); return s.phase === "failed" ? s : null; }, "refusal");
      expect(st.message).toContain("outside the request folder");
      expect(readdirSync(join(e.inst, "data", "cards"))).toEqual([]);
    } finally { await app.close(); }
  }
  // No tested-list entry for the build: the New card shows the CLI state and the test button; the CLI never runs.
  {
    const e = genInstance([{ files: card() }], { approved: false });
    const app = await launch(e.inst);
    try {
      await ready(app);
      const page = await app.firstWindow();
      await expect(page.locator('section[data-card="new"] .gate-state')).toContainText("has not been tested", { timeout: 15_000 });
      await expect(page.locator('section[data-card="new"] button', { hasText: "Test the new CLI version" })).toBeVisible();
      expect(calls(e)).toEqual([]);
    } finally { await app.close(); }
  }
  // The host build has not passed its security suite: no Claude usage at all.
  {
    const e = genInstance([{ files: card() }], { suite: false });
    const app = await launch(e.inst);
    try {
      await ready(app);
      await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
      await ask(await app.firstWindow(), "Show memory");
      const st = await waitFor(async () => { const s = await gen(app); return s.phase === "failed" ? s : null; }, "refusal");
      expect(st.message).toContain("has not passed its security tests");
      expect(calls(e)).toEqual([]);
    } finally { await app.close(); }
  }
  // Stop kills the run.
  {
    const e = genInstance([{ files: card(), sleepMs: 30_000 }]);
    const app = await launch(e.inst);
    try {
      await ready(app);
      const page = await app.firstWindow();
      await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
      await ask(page, "Show memory");
      await waitFor(async () => (await gen(app)).phase === "writing" && calls(e).length === 1, "the run to start");
      await page.locator('section[data-card="new"] button', { hasText: "Stop" }).click();
      const st = await waitFor(async () => { const s = await gen(app); return s.phase === "stopped" ? s : null; }, "stop", 10_000);
      expect(st.message).toBe("stopped by you");
      expect(await app.evaluate(() => (globalThis as any).__dashboard.gate.runningCount)).toBe(0);
    } finally { await app.close(); }
  }
});

test("D2/D3: red combinations on the canvas, unchecking clears them, No / Yes always / Yes only now", async () => {
  const ui = `export function mount(el, api) {
  api.ui.setStatus({ state: "ok" });
  el.textContent = "sync";
  api.fs.readText("C:\\\\Data\\\\notes.txt").then((t) => api.net.request({ url: "https://api.example.com/notes", method: "POST", body: t })).catch((e) => api.ui.setStatus({ state: "error", message: e.message }));
}
export function unmount() {}`;
  const m = (version: string) => JSON.stringify({
    id: "{{CARD_ID}}", name: "Notes sync", version, apiVersion: 0,
    permissions: [
      { type: "fs.read", path: "C:\\Data", reason: "reads your notes file" },
      { type: "net.http", origin: "https://api.example.com", pathPrefix: "/notes", methods: ["POST"], reason: "uploads the notes to your service" },
    ],
  });
  const files = (v: string) => ({ "manifest.json": m(v), "ui.js": ui, "DEVLOG.md": "# Notes sync\n\n- created\n" });
  const e = genInstance([{ files: files("1.0.0") }, { files: files("1.0.1") }]);
  const app = await launch(e.inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
    await ask(page, "Upload my notes file to my notes service");
    const cv = await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("canvas.html"), timeout: 60_000 });
    await cv.waitForSelector(".perms li");
    await expect(cv.locator(".banner.red")).toContainText("D1");
    await expect(cv.locator(".perms li").nth(1)).toHaveClass(/red/);
    await expect(cv.locator(".perms li").nth(1)).toContainText("Send data to and fetch data from https://api.example.com");
    // Unchecking the read line breaks the combination: red disappears at once; checking it again brings it back.
    await cv.locator(".perms li").nth(0).locator("input").uncheck();
    await expect(cv.locator(".banner.red")).toHaveCount(0);
    await cv.locator(".perms li").nth(0).locator("input").check();
    await expect(cv.locator(".banner.red")).toHaveCount(1);
    // "No": nothing approved, the canvas stays.
    await app.evaluate(({ dialog }) => { (globalThis as any).__asked = 0; (dialog as any).showMessageBox = async () => { (globalThis as any).__asked++; return { response: 0, checkboxChecked: false }; }; });
    await cv.locator("button", { hasText: "Approve" }).click();
    await expect(cv.locator("button", { hasText: "Approve" })).toBeEnabled();
    expect((await gen(app)).phase).toBe("approval");
    // "Yes, always": approved and remembered for exactly these scopes.
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => { (globalThis as any).__asked++; return { response: 1, checkboxChecked: false }; }; });
    await Promise.all([cv.waitForEvent("close"), cv.locator("button", { hasText: "Approve" }).click().catch(() => undefined)]);
    await waitFor(async () => (await gen(app)).phase === "done", "install");
    const cardId = (await gen(app)).cardId as string;
    expect(await app.evaluate(() => (globalThis as any).__asked)).toBe(2);
    const allow = JSON.parse(readFileSync(join(e.inst, "data", "approvals", `${cardId}.allowances.json`), "utf8"));
    expect(allow).toHaveLength(1);
    // The next update with the same red combination does not ask again.
    await ask(page, "Same, new version", "Change: Notes sync");
    const cv2 = await app.waitForEvent("window", { predicate: (p) => p.url().endsWith("canvas.html"), timeout: 60_000 });
    await cv2.waitForSelector(".banner.red");
    await expect(cv2.locator(".banner.red")).toContainText("no question will be asked");
    await Promise.all([cv2.waitForEvent("close"), cv2.locator("button", { hasText: "Approve" }).click().catch(() => undefined)]);
    await waitFor(async () => (await gen(app)).phase === "done", "update install");
    expect(await app.evaluate(() => (globalThis as any).__asked)).toBe(2);
  } finally { await app.close(); }
});

test("C3/V5: a card that passes V0-V4 but misbehaves when run is refused by the smoke test", async () => {
  const silent = `export function mount(el, api) { el.textContent = "no status"; api.sysinfo.memory().catch(() => {}); }\nexport function unmount() {}`;
  const e = genInstance([{ files: card({ ui: silent }) }]);
  const app = await launch(e.inst);
  try {
    await ready(app);
    await waitFor(async () => (await gen(app)).gate?.ok === true, "gate");
    await ask(await app.firstWindow(), "Show memory without status");
    const st = await waitFor(async () => { const s = await gen(app); return s.phase === "failed" ? s : null; }, "the smoke test to refuse it", 120_000);
    console.log("V5:", st.errors);
    expect(st.errors).toContain("V5 Smoke test with zero capabilities");
    expect(st.errors).toContain("never reported its state");
    expect(calls(e).length).toBe(4);                       // first run + 3 retries
    expect(readdirSync(join(e.inst, "data", "cards"))).toEqual([]);
  } finally { await app.close(); }
});
