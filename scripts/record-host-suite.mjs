// Runs the host security suite (TESTPLAN part A) on the current build and, only if every test
// passed, writes Build/data/generator/host-suite.json for this build's hash. The validator refuses
// to approve cards from a build without a matching record (VALIDATOR.md).
//   node scripts/record-host-suite.mjs [--instance=Build]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const instance = resolve(process.argv.find((a) => a.startsWith("--instance="))?.slice(11) ?? "Build");
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", shell: true }).status === 0;

const suites = [
  ["build", "npm run build"],
  ["unit: broker, net, files (A3-A6, A11)", "node --import tsx --test test/unit/*.test.ts"],
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
const { buildHash } = require("../src/main/generator/host-suite.ts");
const hash = buildHash(resolve("dist"));
const out = join(instance, "data", "generator", "host-suite.json");
mkdirSync(join(instance, "data", "generator"), { recursive: true });
writeFileSync(out, JSON.stringify({ schema: 1, buildHash: hash, passedAt: new Date().toISOString(), suites: suites.map((s) => s[0]) }, null, 2));
console.log(`\nAll security suites passed. Recorded build ${hash.slice(0, 12)}… in ${out}`);
