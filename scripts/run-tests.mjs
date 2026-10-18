// Runs every *.test.ts under a folder with the Node test runner (tsx for TypeScript).
// Lists the files itself instead of passing a glob to `node --test`: glob arguments need Node 21+
// and fail as "Could not find '...\**\*.test.ts'" on older Node (2026-10-10).
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectNode } from "./project-node.mjs";

ensureProjectNode();

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/run-tests.mjs <folder>"); process.exit(2); }
console.log(`node ${process.version} (${process.execPath})`);

const files = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".test.ts")).map((f) => join(dir, f)).sort();
if (files.length === 0) { console.error(`no *.test.ts files in ${dir}`); process.exit(1); }
// Further arguments go to the test runner (test:podman: --test-concurrency=1, the files share one machine).
const r = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(3), ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
