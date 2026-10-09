// Builds the portable Dashboard into Build/app/ (ARCHITECTURE.md: builds write only Build/app/).
//   1. npm run build  2. electron-builder, unpacked folder  3. Build/app/ replaced by that folder.
// Build/data/ and Build/ClaudeExchange/ are never touched. Build/Dashboard.lnk is made once by
// scripts/make-shortcut.ps1, not here.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeIcon } from "./icon.mjs";

const run = (cmd) => { if (spawnSync(cmd, { stdio: "inherit", shell: true }).status !== 0) { console.error(`failed: ${cmd}`); process.exit(1); } };
const instance = resolve(process.argv.find((a) => a.startsWith("--instance="))?.slice(11) ?? "Build");
if (!existsSync(join(instance, "data")) && !existsSync(join(instance, "ClaudeExchange"))) { console.error(`${instance} does not look like a Dashboard instance`); process.exit(1); }

run("npm run build");
mkdirSync("pack-resources", { recursive: true });
writeIcon("pack-resources/icon.png", 256);
rmSync("pack", { recursive: true, force: true });
run("npx electron-builder --dir --config electron-builder.json");

const out = join("pack", "win-unpacked");
if (!existsSync(join(out, "Dashboard.exe"))) { console.error("electron-builder produced no Dashboard.exe"); process.exit(1); }
const app = join(instance, "app");
// Build/app/ is build output only: replaced as a whole.
for (const entry of existsSync(app) ? readdirSync(app) : []) rmSync(join(app, entry), { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(out, app, { recursive: true });
console.log(`\nPortable Dashboard written to ${join(app, "Dashboard.exe")}`);
