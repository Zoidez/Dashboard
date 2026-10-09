/**
 * TESTPLAN A4, "a junction swapped between check and use" (user design 2026-10-09).
 *
 * A separate process flips <approved>\swap between a real folder and a junction to an outside
 * folder at random intervals (50-400 ms) for the whole run. Every 0.5 s for 5 minutes, the checker
 * makes one read and one write through <approved>\swap with the file check protocol.
 *
 * Pass requires ALL of:
 *   - the swapper really swapped (at least 300 completed swaps; its failures are listed by reason);
 *   - the checks met both states: reads that succeeded on the real folder AND reads refused at the junction;
 *   - no read ever returned the outside secret, and no write ever created a file outside;
 *   - the outside secret file is unchanged.
 * Duration and interval can be shortened for a quick look with RACE_SECONDS / RACE_INTERVAL_MS (not a pass).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as ops from "../../src/filehelper/fs-ops.js";
import { FileCheckError, type CheckContext } from "../../src/filehelper/file-checks.js";

const SECONDS = Number(process.env.RACE_SECONDS ?? 300);
const INTERVAL_MS = Number(process.env.RACE_INTERVAL_MS ?? 500);
const OFFICIAL = SECONDS >= 300 && INTERVAL_MS === 500;

test(`TOCTOU: junction swapped during checks every ${INTERVAL_MS} ms for ${SECONDS} s`, { timeout: (SECONDS + 60) * 1000 }, async () => {
  const SECRET = "SECRET-" + Math.random().toString(36).slice(2);
  const base = mkdtempSync(join(tmpdir(), "race-"));
  const S = join(base, "approved"), O = join(base, "outside");
  const real = join(S, "swap"), parked = join(S, "swap-real");
  mkdirSync(real, { recursive: true });
  mkdirSync(O);
  writeFileSync(join(real, "f.txt"), "safe");
  writeFileSync(join(O, "f.txt"), SECRET);
  const ctx: CheckContext = { instanceRoot: join(base, "Build"), scope: { path: S, recursive: true } };

  const swapper = spawn(process.execPath, ["-e", `
    const fs = require("fs");
    const real = ${JSON.stringify(real)}, parked = ${JSON.stringify(parked)}, out = ${JSON.stringify(O)};
    const end = Date.now() + ${SECONDS * 1000};
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const stats = { toJunction: 0, toReal: 0, failures: {} };
    const fail = (step, e) => { const k = step + ":" + (e.code || e.message); stats.failures[k] = (stats.failures[k] || 0) + 1; };
    let junction = false;
    while (Date.now() < end) {
      sleep(50 + Math.floor(Math.random() * 350));
      if (!junction) {
        try { fs.renameSync(real, parked); } catch (e) { fail("park", e); continue; }
        try { fs.symlinkSync(out, real, "junction"); junction = true; stats.toJunction++; }
        catch (e) { fail("link", e); try { fs.renameSync(parked, real); } catch (e2) { fail("unpark", e2); } }
      } else {
        try { fs.rmdirSync(real); } catch (e) { fail("unlink", e); continue; }
        try { fs.renameSync(parked, real); junction = false; stats.toReal++; } catch (e) { fail("restore", e); }
      }
    }
    if (junction) { try { fs.rmdirSync(real); fs.renameSync(parked, real); } catch (e) { fail("final", e); } }
    process.stdout.write(JSON.stringify(stats));
  `]);
  let out = "";
  swapper.stdout.on("data", (d) => (out += d));
  const finished = new Promise<void>((r) => swapper.on("exit", () => r()));

  const reads = { safe: 0, leaked: 0, refused: {} as Record<string, number>, other: 0 };
  const writes = { done: 0, refused: 0, other: 0 };
  const end = Date.now() + SECONDS * 1000;
  let n = 0;
  while (Date.now() < end) {
    n++;
    try {
      const v = ops.readText(join(real, "f.txt"), ctx);
      if (v === SECRET) reads.leaked++; else reads.safe++;
    } catch (e) {
      if (e instanceof FileCheckError) reads.refused[`${e.code}/${e.check}`] = (reads.refused[`${e.code}/${e.check}`] ?? 0) + 1;
      else reads.other++;
    }
    try { ops.writeText(join(real, `w${n}.txt`), "planted?", ctx); writes.done++; }
    catch (e) { if (e instanceof FileCheckError) writes.refused++; else writes.other++; }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  await finished;
  if (existsSync(parked)) { try { rmdirSync(real); } catch { /* it is the real folder */ } try { renameSync(parked, real); } catch { /* ignore */ } }

  const sw = JSON.parse(out || "{}") as { toJunction: number; toReal: number; failures: Record<string, number> };
  const refusedReads = Object.values(reads.refused).reduce((a, b) => a + b, 0);
  const plantedOutside = readdirSync(O).filter((f) => f !== "f.txt");
  console.log(`checks: ${n} (every ${INTERVAL_MS} ms for ${SECONDS} s)${OFFICIAL ? "" : "  [shortened run: not a pass]"}`);
  console.log(`swapper: to-junction ${sw.toJunction}, back-to-real ${sw.toReal}, failed attempts ${JSON.stringify(sw.failures)}`);
  console.log(`reads: safe ${reads.safe}, refused ${JSON.stringify(reads.refused)}, LEAKED ${reads.leaked}, other errors ${reads.other}`);
  console.log(`writes: inside ${writes.done}, refused ${writes.refused}, other errors ${writes.other}; files planted outside: ${plantedOutside.length}`);

  assert.equal(reads.leaked, 0, "the secret was read through the junction");
  assert.deepEqual(plantedOutside, [], "a write created a file outside the approved folder");
  assert.equal(readFileSync(join(O, "f.txt"), "utf8"), SECRET, "the outside file was changed");
  assert.equal(reads.other + writes.other, 0, "unexpected errors (not refusals)");
  assert.ok(sw.toJunction + sw.toReal >= (OFFICIAL ? 300 : 10), `the swapper must really swap (completed ${sw.toJunction + sw.toReal})`);
  assert.ok(reads.safe > 0, "no read met the real folder: the race was not exercised in that state");
  assert.ok(refusedReads > 0, "no read met the junction: the race was not exercised in that state");
  assert.ok(OFFICIAL, "shortened run: results shown above, but only the 5-minute run at 0.5 s counts");
});
