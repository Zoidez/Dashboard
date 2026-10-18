// Builds the portable Dashboard side by side (docs/LASS.md 8, "Updater"):
//   1. npm run build  2. electron-builder, unpacked folder
//   3. copied into Build/app/<build-id>/ (id = first 12 hex of the SHA-256 of its app.asar)
//   4. Build/data/current-build.json: the new build becomes current (the old current becomes previous),
//      or with --pending it becomes pending: the launcher tries it on the next start and rolls back if it
//      does not report ready with a matching security-test record. With --install-only the state is not
//      touched (LASS phase 4: a tested fix becomes pending only on the user's Install click).
//   5. the launcher Build/Dashboard.exe is compiled (launcher/Launcher.cs).
// A running Dashboard never blocks this: it runs from another build's folder. Build/data/ and
// Build/ClaudeExchange/ are never touched except current-build.json. Builds other than current,
// previous and pending are removed beyond the newest three (a folder still in use stays for later).
//
// Everything printed is also written to pack-resources/package.log, and any failure ends with a
// "PACKAGE FAILED" line: a failed run must not look like a finished one (2026-10-10: two runs failed
// silently and Build/app kept the old build).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildLauncher } from "./build-launcher.mjs";
import { writeIcon } from "./icon.mjs";
import { ensureProjectNode } from "./project-node.mjs";

ensureProjectNode();

mkdirSync("pack-resources", { recursive: true });
const log = resolve("pack-resources", "package.log");
writeFileSync(log, `npm run package  ${new Date().toISOString()}  node ${process.version}  cwd ${process.cwd()}\n`);
const say = (s) => { process.stdout.write(s); try { appendFileSync(log, s); } catch { /* log is best effort */ } };
const fail = (why) => {
  say(`\nPACKAGE FAILED: ${why}\nNo build was made current. Full output: ${log}\n`);
  process.exit(1);
};
const run = (cmd) => new Promise((done) => {
  say(`\n> ${cmd}\n`);
  const p = spawn(cmd, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  p.stdout.on("data", (d) => say(d.toString()));
  p.stderr.on("data", (d) => say(d.toString()));
  p.on("error", (e) => fail(`${cmd}: ${e.message}`));
  p.on("close", (code) => (code === 0 ? done() : fail(`${cmd} exited with code ${code}`)));
});

const instance = resolve(process.argv.find((a) => a.startsWith("--instance="))?.slice(11) ?? "Build");
const asPending = process.argv.includes("--pending");
const installOnly = process.argv.includes("--install-only");
if (!existsSync(join(instance, "data")) && !existsSync(join(instance, "ClaudeExchange"))) fail(`${instance} does not look like a Dashboard instance`);
const appRoot = join(instance, "app");
const ID = /^[0-9a-f]{12}$/;
const stateFile = join(instance, "data", "current-build.json");

await run("npm run build");
writeIcon("pack-resources/icon.png", 256);
rmSync("pack", { recursive: true, force: true });
await run("npx electron-builder --dir --config electron-builder.json");

const out = join("pack", "win-unpacked");
if (!existsSync(join(out, "Dashboard.exe"))) fail("electron-builder produced no Dashboard.exe");
const id = createHash("sha256").update(readFileSync(join(out, "resources", "app.asar"))).digest("hex").slice(0, 12);
const target = join(appRoot, id);

if (existsSync(join(target, "Dashboard.exe"))) say(`\nbuild ${id} is already installed (same content)\n`);
else {
  try { mkdirSync(appRoot, { recursive: true }); cpSync(out, target + ".part", { recursive: true }); renameSync(target + ".part", target); }
  catch (e) { fail(`could not install ${target} (${e.code ?? e.message})`); }
}

let state = {};
try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { /* first side-by-side build */ }
const clean = (v) => (typeof v === "string" && ID.test(v) ? v : undefined);
const cur = clean(state.current), prev = clean(state.previous);
const next = installOnly
  ? { current: cur, previous: prev, pending: clean(state.pending) }
  : asPending
    ? { current: cur, previous: prev, pending: id }
    : { current: id, previous: cur && cur !== id ? cur : prev };
for (const k of Object.keys(next)) if (!next[k]) delete next[k];
if (!installOnly) {
  writeFileSync(stateFile + ".tmp", JSON.stringify(next));
  renameSync(stateFile + ".tmp", stateFile);
}

// The launcher. It runs only for moments (start, restart), so it is rarely in use; if it is, the new one
// waits next to it. Not with --install-only: a LASS fix must not replace the launcher before the user's
// Install click (a launcher change reaches Build\Dashboard.exe with the next plain npm run package).
const launcher = join(instance, "Dashboard.exe");
if (!installOnly) {
  try { buildLauncher(launcher); }
  catch (e) {
    try { buildLauncher(launcher + ".new"); say(`note: ${launcher} is in use; the new launcher is ${launcher}.new (rename it when it is free)\n`); }
    catch (e2) { fail(`could not compile the launcher: ${String(e2.stdout ?? "")}${e2.message}`); }
  }
}

// Tidy: the flat app of the time before side-by-side builds, old app.old folders, and builds beyond three.
const keep = new Set([id, next.current, next.previous, next.pending].filter(Boolean));
const builds = readdirSync(appRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && ID.test(d.name)).map((d) => ({ name: d.name, t: statSync(join(appRoot, d.name)).birthtimeMs })).sort((a, b) => b.t - a.t);
for (const b of builds) if (keep.size < 3) keep.add(b.name);
const tryRemove = (p) => { try { rmSync(p, { recursive: true, force: true }); } catch (e) { say(`note: ${p} could not be removed yet (${e.code ?? e.message}); it is removed on a later run\n`); } };
for (const n of readdirSync(appRoot)) if (!keep.has(n)) tryRemove(join(appRoot, n));
for (const n of readdirSync(instance)) if (/^app\.old(-\d+)?$/.test(n)) tryRemove(join(instance, n));

const asar = statSync(join(target, "resources", "app.asar"));
say(`\nPACKAGED OK  ${new Date().toISOString()}\n  build ${id}${installOnly ? " (installed only: not current, not pending)" : asPending ? " (PENDING: tried on the next start, rolled back if it fails)" : " (current)"}\n  ${join(target, "Dashboard.exe")}\n  app.asar ${asar.size} bytes\n  launcher ${launcher}\n  state ${JSON.stringify(next)}\n`);
