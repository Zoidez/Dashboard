/**
 * The LASS fix run against the real Podman machine (docs/LASS.md 8): the development image, the egress
 * proxy, the source as a git bundle of HEAD, npm ci through the proxy, the patch and the checks out.
 * Claude is replaced by a stand-in command that edits one file, so the test costs no plan usage.
 * Needs setup\lass-dev.ps1 to have built the images and started the proxy. Run: npm run test:podman.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installedPodman, PodmanBackend, podmanEnv } from "../../src/main/containers/podman.js";
import { runFix } from "../../src/main/lass/fix-run.js";
import { reviewPatch } from "../../src/main/lass/patch.js";

const REPO = resolve(__dirname, "..", "..");
const opts = installedPodman(join(REPO, "Build", "data"));

test("fix run: bundle in, npm ci through the proxy, patch and checks out, container removed", { skip: !opts && "portable Podman not installed", timeout: 45 * 60_000 }, async () => {
  const b = new PodmanBackend(opts!);
  const out = mkdtempSync(join(tmpdir(), "lass-fix-"));
  const steps: string[] = [];
  const r = await runFix({
    backend: b, prepare: (p) => b.prepare(p), image: () => b.latestImage("dashboard-lass-dev"), outDir: out, pollMs: 5000,
    bundle: async () => {
      const f = join(out, "repo.bundle");
      execFileSync("git", ["-C", REPO, "bundle", "create", f, "HEAD"], { stdio: "ignore" });
      return { data: readFileSync(f), base: execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString().trim() };
    },
    claudeCommand: "printf '\\nLASS fix-run test line.\\n' >> docs/CARDS.md && printf 'Test fix: one line added to docs/CARDS.md.\\n' > /work/out/summary.md",
    progress: (s) => { if (steps[steps.length - 1] !== s) steps.push(s); },
  }, { invId: "inv-20261018000000-000000", branch: "lass/inv-20261018000000-000000", problem: "test", evidence: "none" });
  console.log("steps:", steps.join(" / "), "\nstatus:", JSON.stringify(r.status), "\nresults in", out);
  assert.equal(r.base, execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"]).toString().trim());
  assert.equal(r.status.npmCi, 0, `npm ci through the proxy (log: ${join(out, "npm-ci.log")})`);
  assert.equal(r.status.claude, 0);
  assert.equal(r.status.typecheck, 0, `typecheck in the container (log: ${join(out, "typecheck.log")})`);
  const review = reviewPatch(r.patch);
  assert.deepEqual(review.refused, []);
  assert.deepEqual(review.files.map((f) => f.path), ["docs/CARDS.md"]);
  assert.match(r.summary, /^Test fix/);
  const pods = execFileSync(opts!.podmanExe, ["pod", "ls", "--format", "{{.Name}}"], { env: podmanEnv(opts!.podmanDir) }).toString();
  assert.doesNotMatch(pods, /job-lass-fix-/, "the fix container is removed");
});
