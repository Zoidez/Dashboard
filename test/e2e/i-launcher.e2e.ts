/**
 * The Dashboard's side of the launcher (docs/LASS.md 8): once its window is up it writes the ready report
 * (its pid, its build, whether its security-test record matches), and it remembers where its window was.
 * The launcher itself is tested in test/unit/launcher.test.ts.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeInstance, ready, waitFor } from "./helpers";

test("I: ready report for the launcher, window position remembered", async () => {
  const inst = makeInstance();
  const app = await launch(inst);
  try {
    await ready(app);
    await app.firstWindow();
    const readyFile = join(inst, "data", "launcher", "ready.json");
    const r = await waitFor(() => (existsSync(readyFile) ? JSON.parse(readFileSync(readyFile, "utf8")) : null), "the ready report");
    expect(r.pid).toBe(await app.evaluate(() => process.pid));
    expect(r.build).toMatch(/^[0-9a-f]{12}$/);
    expect(r.hostSuiteOk).toBe(false);            // a throwaway instance has no security-test record
    await app.evaluate(() => (globalThis as any).__dashboard.win.setBounds({ x: 120, y: 90, width: 1000, height: 700 }));
    const winFile = join(inst, "data", "window.json");
    const b = await waitFor(() => { if (!existsSync(winFile)) return null; const j = JSON.parse(readFileSync(winFile, "utf8")); return j.width === 1000 ? j : null; }, "the saved window position");
    expect(b).toMatchObject({ x: 120, y: 90, width: 1000, height: 700 });
  } finally {
    await app.close();
  }
});
