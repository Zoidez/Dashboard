// Builds the portable Dashboard into Build/app/ (ARCHITECTURE.md: builds write only Build/app/).
//   1. npm run build  2. electron-builder, unpacked folder  3. Build/app/ replaced by that folder.
// Build/data/ and Build/ClaudeExchange/ are never touched. Build/Dashboard.lnk is made once by
// scripts/make-shortcut.ps1, not here.
//
// Everything printed is also written to pack-resources/package.log, and any failure ends with a
// "PACKAGE FAILED" line: a failed run must not look like a finished one (2026-10-10: two runs failed
// silently and Build/app kept the old build).
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeIcon } from "./icon.mjs";
import { ensureProjectNode } from "./project-node.mjs";

ensureProjectNode();

mkdirSync("pack-resources", { recursive: true });
const log = resolve("pack-resources", "package.log");
writeFileSync(log, `npm run package  ${new Date().toISOString()}  node ${process.version}  cwd ${process.cwd()}\n`);
const say = (s) => { process.stdout.write(s); try { appendFileSync(log, s); } catch { /* log is best effort */ } };
const fail = (why) => {
  say(`\nPACKAGE FAILED: ${why}\nBuild\\app was NOT updated. Full output: ${log}\n`);
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
if (!existsSync(join(instance, "data")) && !existsSync(join(instance, "ClaudeExchange"))) fail(`${instance} does not look like a Dashboard instance`);
const app = join(instance, "app");
const old = join(instance, "app.old");

// A running Dashboard locks Build/app. Find out now, not after a long build: on Windows a folder
// with an open file in it cannot be renamed.
if (existsSync(old)) fail(`${old} is left over from an earlier run. Delete it, then run again.`);
if (existsSync(app)) {
  try { renameSync(app, old); renameSync(old, app); }
  catch (e) { fail(`Build\\app is in use (${e.code ?? e.message}). Close the Dashboard (tray icon too) and run again.`); }
}

await run("npm run build");
writeIcon("pack-resources/icon.png", 256);
rmSync("pack", { recursive: true, force: true });
await run("npx electron-builder --dir --config electron-builder.json");

const out = join("pack", "win-unpacked");
if (!existsSync(join(out, "Dashboard.exe"))) fail("electron-builder produced no Dashboard.exe");

// Swap: move the old app aside, copy the new one in, then remove the old one.
try {
  if (existsSync(app)) renameSync(app, old);
  cpSync(out, app, { recursive: true });
} catch (e) {
  fail(`could not replace Build\\app (${e.code ?? e.message}). The previous app is in ${old} if the copy failed halfway.`);
}
rmSync(old, { recursive: true, force: true });

const asar = statSync(join(app, "resources", "app.asar"));
say(`\nPACKAGED OK  ${new Date().toISOString()}\n  ${join(app, "Dashboard.exe")}\n  app.asar ${asar.size} bytes\n`);
