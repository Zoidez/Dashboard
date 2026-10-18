// Runs the host security suite (TESTPLAN part A) on the current build and, only if every test
// passed, records this build's hash in Build/data/generator/host-suite.json. The validator refuses
// to approve cards from a build without a matching record (VALIDATOR.md). Schema 2 (LASS phase 4):
// records of earlier builds stay (newest first, at most 5), so testing a LASS fix's build does not
// void the record of the build that is running.
//   node scripts/record-host-suite.mjs [--instance=Build]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { ensureProjectNode } from "./project-node.mjs";

ensureProjectNode();   // Node >= 22.12, else re-run with tools/node (2026-10-10)

const instance = resolve(process.argv.find((a) => a.startsWith("--instance="))?.slice(11) ?? "Build");
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: true }).status === 0;

const suites = [
  ["build", "npm run build"],
  ["unit: broker, net, files (A3-A6, A11)", "node scripts/run-tests.mjs test/unit"],
  ["race: junction swap, 5 minutes each (A4)", "npm run test:race"],
  ["e2e: A1-A11", "npx playwright test -c test/e2e/playwright.config.ts a1 a2 a3 a4 a7 a10"],
];
for (const [name, cmd] of suites) {
  console.log(`\n=== ${name}`);
  if (!run(cmd, [])) { console.error(`\nFAILED: ${name}. No record written; the validator stays closed.`); process.exit(1); }
}

// Hash the build exactly as the app does (src/main/generator/host-suite.ts, bundled in dist/main).
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { buildHash, recordedHashes, MAX_RECORDS } = require("../src/main/generator/host-suite.ts");
const hash = buildHash(resolve("dist"));
const out = join(instance, "data", "generator", "host-suite.json");
mkdirSync(join(instance, "data", "generator"), { recursive: true });
let earlier = [];
if (recordedHashes(out)) {
  const old = JSON.parse(readFileSync(out, "utf8"));
  earlier = old.schema === 2 ? old.records : [{ buildHash: old.buildHash, passedAt: old.passedAt, suites: old.suites }];
}
const records = [{ buildHash: hash, passedAt: new Date().toISOString(), suites: suites.map((s) => s[0]) }, ...earlier.filter((r) => r.buildHash !== hash)].slice(0, MAX_RECORDS);
writeFileSync(out + ".tmp", JSON.stringify({ schema: 2, records }, null, 2));
renameSync(out + ".tmp", out);
console.log(`\nAll security suites passed. Recorded build ${hash.slice(0, 12)}… in ${out} (${records.length} build${records.length === 1 ? "" : "s"} on record)`);
