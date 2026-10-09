/**
 * TESTPLAN A4, delete: the same 5-minute race as toctou.test.ts, for api.fs.remove.
 * <approved>\swap flips between a real folder and a junction to <outside> at random 50-400 ms
 * intervals. Both folders hold files with the same names (d0.txt, d1.txt, ...). Every 0.5 s the
 * checker deletes the next <approved>\swap\d<n>.txt. Deletes that meet the real folder recycle the
 * decoy; deletes that meet the junction must be refused.
 * Pass: >= 300 swaps, deletes that met both states, and every outside file still present and unchanged.
 * Note: the decoys that are deleted go to this user's Recycle Bin (a few hundred small files named d<n>.txt).
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

test(`delete race: junction swapped during deletes every ${INTERVAL_MS} ms for ${SECONDS} s`, { timeout: (SECONDS + 60) * 1000 }, async () => {
  const SECRET = "OUTSIDE-" + Math.random().toString(36).slice(2);
  const base = mkdtempSync(join(tmpdir(), "delrace-"));
  const S = join(base, "approved"), O = join(base, "outside");
  const real = join(S, "swap"), parked = join(S, "swap-real");
  mkdirSync(real, { recursive: true });
  mkdirSync(O);
  const N = Math.ceil((SECONDS * 1000) / INTERVAL_MS) + 50;
  for (let i = 0; i < N; i++) { writeFileSync(join(real, `d${i}.txt`), `decoy ${i}`); writeFileSync(join(O, `d${i}.txt`), SECRET); }
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

  const res = { recycled: 0, refused: {} as Record<string, number>, other: [] as string[] };
  const end = Date.now() + SECONDS * 1000;
  let n = 0;
  while (Date.now() < end && n < N) {
    try { ops.remove(join(real, `d${n}.txt`), ctx); res.recycled++; }
    catch (e) {
      if (e instanceof FileCheckError) res.refused[`${e.code}/${e.check}`] = (res.refused[`${e.code}/${e.check}`] ?? 0) + 1;
      else res.other.push((e as Error).message);
    }
    n++;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  await finished;
  if (existsSync(parked)) { try { rmdirSync(real); } catch { /* real folder */ } try { renameSync(parked, real); } catch { /* ignore */ } }

  const sw = JSON.parse(out || "{}") as { toJunction: number; toReal: number; failures: Record<string, number> };
  const refused = Object.values(res.refused).reduce((a, b) => a + b, 0);
  const outside = readdirSync(O);
  const missing = Array.from({ length: N }, (_, i) => `d${i}.txt`).filter((f) => !outside.includes(f));
  const changed = outside.filter((f) => /^d\d+\.txt$/.test(f) && readFileSync(join(O, f), "utf8") !== SECRET);
  const strays = outside.filter((f) => !/^d\d+\.txt$/.test(f));
  console.log(`deletes: ${n} (every ${INTERVAL_MS} ms for ${SECONDS} s)${OFFICIAL ? "" : "  [shortened run: not a pass]"}`);
  console.log(`swapper: to-junction ${sw.toJunction}, back-to-real ${sw.toReal}, failed attempts ${JSON.stringify(sw.failures)}`);
  console.log(`results: recycled ${res.recycled}, refused ${JSON.stringify(res.refused)}, other errors ${res.other.length}${res.other.length ? " " + JSON.stringify(res.other.slice(0, 3)) : ""}`);
  console.log(`outside folder: missing ${missing.length}, changed ${changed.length}, stray files ${strays.length}`);

  assert.deepEqual(missing, [], "files outside the approved folder were deleted");
  assert.deepEqual(changed, [], "files outside were changed");
  assert.deepEqual(strays, [], "something was left in the outside folder");
  assert.deepEqual(res.other, [], "unexpected errors (not refusals)");
  assert.ok(sw.toJunction + sw.toReal >= (OFFICIAL ? 300 : 10), `the swapper must really swap (completed ${sw.toJunction + sw.toReal})`);
  assert.ok(res.recycled > 0, "no delete met the real folder");
  assert.ok(refused > 0, "no delete met the junction");
  assert.ok(OFFICIAL, "shortened run: results shown above, but only the 5-minute run at 0.5 s counts");
});
