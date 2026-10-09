/**
 * TESTPLAN F (app): grid placement, layout persistence, Stop/Start/Revoke from the grid, the
 * Options window, close to tray, hot-loading. Native dialogs are answered by a stub in the main process.
 */
import { expect, test } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { addCard, launch, makeInstance, ready, snapshot, waitFor } from "./helpers";

const ok = (label: string) => `export function mount(el, api) { el.textContent = ${JSON.stringify(label)}; api.ui.setStatus({ state: "ok" }); }`;

test("F: grid places views, saves layout, Stop/Start/Revoke, Options, close to tray, hot-loading", async () => {
  const inst = makeInstance();
  addCard(inst, { id: "card-a", name: "Card A", ui: ok("A"), manifest: { defaultSize: { w: 4, h: 3 } } });
  addCard(inst, { id: "card-b", name: "Card B", ui: ok("B"), permissions: [{ type: "links.open", any: true, reason: "opens links from its list" }] });
  const app = await launch(inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    await page.waitForSelector('section[data-card="card-b"]');
    await waitFor(async () => (await snapshot(app)).running.every((c) => c.status.state === "ok") && (await snapshot(app)).running.length === 2, "both cards ok");

    // Each view sits exactly on its frame body and is visible.
    const placed = await waitFor(async () => {
      const views = await app.evaluate(() => [...(globalThis as any).__dashboard.host.cards.values()].map((c: any) => ({ id: c.cardId, b: c.view.getBounds(), visible: c.view.getVisible() })));
      return views.every((v: any) => v.visible) ? views : null;
    }, "views to be placed");
    for (const v of placed as Array<{ id: string; b: { x: number; y: number; width: number; height: number } }>) {
      const r = await page.locator(`section[data-card="${v.id}"] .body`).boundingBox();
      expect(Math.abs(v.b.x - r!.x) + Math.abs(v.b.y - r!.y) + Math.abs(v.b.width - r!.width) + Math.abs(v.b.height - r!.height), v.id).toBeLessThanOrEqual(4);
    }
    // Manifest defaultSize is used: card A spans 4 columns x 3 rows.
    expect(await page.locator('section[data-card="card-a"]').getAttribute("style")).toContain("span 4");

    // Resize card B with the handle, then check layout.json.
    const handle = page.locator('section[data-card="card-b"] .resize');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 260, hb.y + 100, { steps: 8 });
    await page.mouse.up();
    const saved = await waitFor(() => { try { return JSON.parse(readFileSync(join(inst, "data", "layout.json"), "utf8")); } catch { return null; } }, "layout.json");
    console.log("layout:", JSON.stringify(saved));
    expect(saved.sizes["card-b"].w).toBeGreaterThan(4);
    expect(saved.order).toEqual(["card-a", "card-b"]);

    // Stop and Start from the grid buttons.
    await page.locator('section[data-card="card-a"] button', { hasText: "Stop" }).click();
    await waitFor(async () => (await snapshot(app)).stopped.some((s) => s.cardId === "card-a" && s.status.message === "stopped by you"), "card A stopped");
    await page.locator('section[data-card="card-a"] button', { hasText: "Start" }).click();
    await waitFor(async () => (await snapshot(app)).running.some((c) => c.cardId === "card-a"), "card A running again");

    // Revoke from the grid: the confirmation dialog is answered "Revoke" by a stub.
    await app.evaluate(({ dialog }) => { (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false }); });
    await page.locator('section[data-card="card-a"] button', { hasText: "Revoke" }).click();
    await waitFor(async () => (await snapshot(app)).stopped.some((s) => s.cardId === "card-a" && s.status.message === "approval revoked"), "card A revoked");
    expect(JSON.parse(readFileSync(join(inst, "data", "approvals", "card-a.json"), "utf8")).revoked).toBe(true);
    await expect(page.locator('section[data-card="card-a"] button', { hasText: "Start" })).toHaveCount(0);

    // Options window: tabs, the card's permissions with the yellow marking, a feed edit, General switches.
    await page.locator("#top button", { hasText: "Options" }).click();
    const opts = await app.waitForEvent("window", (p) => p.url().endsWith("options.html"));
    await opts.waitForSelector(".tabs");
    await opts.locator(".tabs button", { hasText: "Cards" }).click();
    await opts.locator(".card-detail", { hasText: "Card B" }).locator("button", { hasText: "Details" }).click();
    await expect(opts.locator(".card-detail", { hasText: "Card B" }).locator(".mark.yellow")).toHaveCount(1);
    await expect(opts.locator(".card-detail", { hasText: "Card B" })).toContainText("Open any web link in your browser");
    await opts.locator(".tabs button", { hasText: "Feeds" }).click();
    const grace = opts.locator("tbody tr", { hasText: "Daily Kessler Syndrome watch" }).locator('input[type="number"]').first();
    await grace.fill("5");
    await waitFor(() => JSON.parse(readFileSync(join(inst, "data", "config", "options.json"), "utf8")).feeds.find((f: any) => f.taskId === "trig_01AmX52WU9gtbFB6fHLAW7A6").graceHours === 5, "grace saved");
    await opts.locator(".tabs button", { hasText: "General" }).click();
    await opts.locator("#sww").check();
    await waitFor(() => JSON.parse(readFileSync(join(inst, "data", "config", "options.json"), "utf8")).general.startWithWindows === true, "start with Windows saved");
    const unpackaged = await waitFor(async () => (await snapshot(app)).audit.some((e) => /^start with Windows not applied: (unpackaged run|disabled for this run)$/.test(e.detail)), "the dev run not to touch Windows");
    expect(unpackaged).toBe(true);
    await opts.locator("#sww").uncheck();
    await opts.locator(".tabs button", { hasText: "Security log" }).click();
    await expect(opts.locator("h2")).toHaveText("Security log");
    await opts.close();

    // Close to tray: the window hides, cards keep running; showWindow brings it back.
    await app.evaluate(() => (globalThis as any).__dashboard.win.close());
    const hidden = await waitFor(async () => {
      const h = await app.evaluate(() => ({ visible: (globalThis as any).__dashboard.win.isVisible(), running: (globalThis as any).__dashboard.host.cards.size }));
      return h.visible ? null : h;                       // close() hides the window asynchronously
    }, "the window to hide", 5000);
    expect(hidden).toEqual({ visible: false, running: 1 });
    await app.evaluate(() => (globalThis as any).__dashboard.shell.showWindow());
    expect(await app.evaluate(() => (globalThis as any).__dashboard.win.isVisible())).toBe(true);

    // Hot-loading: a new approved card folder starts without a restart; a removed one stops.
    addCard(inst, { id: "card-c", name: "Card C", ui: ok("C") });
    await waitFor(async () => (await snapshot(app)).running.some((c) => c.cardId === "card-c" && c.status.state === "ok"), "card C hot-loaded", 15_000);
    await page.waitForSelector('section[data-card="card-c"]');
    rmSync(join(inst, "data", "cards", "card-c"), { recursive: true, force: true });
    await waitFor(async () => !(await snapshot(app)).running.some((c) => c.cardId === "card-c"), "card C stopped after removal", 15_000);
  } finally {
    await app.evaluate(() => { (globalThis as any).__dashboard.options.setGeneral({ closeToTray: false }); }).catch(() => undefined);
    await app.close();
  }
});
