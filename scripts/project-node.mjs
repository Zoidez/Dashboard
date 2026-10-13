// The project needs Node >= 22.12 (package.json engines). electron-builder 26 require()s an ES module,
// which Node 20.11 cannot do (ERR_REQUIRE_ESM, 2026-10-10). When a script is started by an older
// Node, it re-runs itself with the project's own Node in tools/node and puts that folder first on
// PATH, so the npm/npx it calls are the project's too.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";

export function ensureProjectNode() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) return;
  const exe = resolve("tools", "node", process.platform === "win32" ? "node.exe" : "bin/node");
  if (process.env.DASHBOARD_PROJECT_NODE || !existsSync(exe)) {
    console.error(`Node ${process.version} is too old: the project needs >= 22.12, and ${exe} ${existsSync(exe) ? "is too old as well" : "does not exist"}.`);
    process.exit(1);
  }
  const env = { ...process.env, DASHBOARD_PROJECT_NODE: "1" };
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = dirname(exe) + delimiter + (env[pathKey] ?? "");
  console.log(`Node ${process.version} is too old for this project; re-running with ${exe}`);
  const r = spawnSync(exe, process.argv.slice(1), { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
