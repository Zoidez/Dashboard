/**
 * LASS phase 1 (docs/LASS.md): "Something's wrong" opens an investigation with the user's text; an open
 * investigation of new-card requests blocks only new cards, shown on the New card with Cancel; every
 * New-card request lands in the prompt history; the activity log records host and user events.
 */
import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeInstance, ready, waitFor } from "./helpers";

const readJsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("H: Something's wrong, blocking with Cancel, prompt history, activity log", async () => {
  const inst = makeInstance();
  const app = await launch(inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    await page.locator('section[data-card="new"]').waitFor();

    // 1. Help > Something's wrong: the user's text becomes an investigation (phase 1: no triage yet).
    await app.evaluate(() => (globalThis as any).__dashboard.shell.openReport());
    const report = await waitFor(async () => app.windows().find((w) => w.url().endsWith("report.html")) ?? null, "the report window");
    await report.locator("textarea").fill("The card I asked for keeps failing.");
    await report.getByRole("button", { name: "Send" }).click();
    const msg = await report.getByRole("status").textContent();
    expect(msg).toMatch(/Recorded as inv-/);
    expect(msg).toMatch(/triage step is the next phase/);
    const invDir = join(inst, "data", "lass", "investigations");
    const rec = JSON.parse(readFileSync(join(invDir, readdirSync(invDir).find((f) => f.endsWith(".json"))!), "utf8"));
    expect(rec.signal).toMatchObject({ kind: "user-report", function: "general", userText: "The card I asked for keeps failing." });
    expect(rec.closeReason).toBe("failed: triage is not built yet (LASS phase 2)");
    await report.getByRole("button", { name: "Close" }).click();

    // 2. An investigation of new-card requests that is still running blocks only new cards.
    // (This instance has no CLI, so the New card would show the gate panel; mark the gate as on for the page.)
    await app.evaluate(() => {
      const d = (globalThis as any).__dashboard;
      d.pipeline.set({ gate: { ok: true, version: "test" } });
      d.investigations.d.stillTrue = () => new Promise(() => undefined);   // keeps it open for the test
      d.investigations.open({ kind: "repeat-failure", function: "newcard.create", requests: [] });
    });
    const note = page.locator(".newcard .lass-note");
    await note.waitFor();
    await page.getByLabel("Describe the card").fill("a clock");
    await expect(page.getByRole("button", { name: "Create" })).toBeDisabled();
    // The host refuses too, whatever the page does.
    await app.evaluate(() => (globalThis as any).__dashboard.pipeline.start({ text: "a clock", target: { kind: "new" }, preset: null }));
    expect(await app.evaluate(() => (globalThis as any).__dashboard.pipeline.current.message)).toMatch(/LASS is looking into the failed requests/);
    await page.getByRole("button", { name: "Cancel investigation" }).click();
    await expect(note).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as any).__dashboard.investigations.list().filter((i: any) => i.closeReason === "dismissed").length)).toBe(1);

    // 3. A New-card request lands in the prompt history with its outcome (here the generator is off).
    await page.getByRole("button", { name: "Create" }).click();
    const history = join(inst, "data", "lass", "prompts.jsonl");
    await waitFor(() => readJsonl(history).some((l) => l.t === "outcome") || null, "the request's outcome in the history");
    const lines = readJsonl(history);
    expect(lines.find((l) => l.t === "submit").r).toMatchObject({ kind: "new", text: "a clock" });
    expect(lines.find((l) => l.t === "outcome").outcome).toBe("failed: run");

    // 4. The activity log has the host start, the user's actions and the pre-filter result.
    const day = readdirSync(join(inst, "data", "activity")).find((f) => f.endsWith(".jsonl"))!;
    const kinds = readJsonl(join(inst, "data", "activity", day)).map((e) => e.kind);
    for (const k of ["start", "window.report", "lass.report", "lass.cancel", "newcard.submit", "newcard.outcome", "prefilter"]) expect(kinds).toContain(k);
  } finally {
    await app.close();
  }
});
