/**
 * LASS phase 4 (docs/LASS.md 8) in the LASS bar: an identified problem offers the fix only where it can
 * run; the fix's review lists security-relevant files first and in red, shows the patch, and needs the
 * user's confirmation of the red files before "Test on this PC"; Install hands over to the launcher.
 * The container, the Windows test and the restart are stand-ins here (real ones: test/podman, unit tests).
 */
import { test, expect } from "@playwright/test";
import { launch, makeInstance, ready } from "./helpers";

test("J: LASS fix in the bar: unavailable reason, review with red files, confirm, test, install", async () => {
  const inst = makeInstance();
  const app = await launch(inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    await page.locator('section[data-card="new"]').waitFor();
    await app.evaluate(() => {
      const d = (globalThis as any).__dashboard;
      d.investigations.d.stillTrue = async () => true;
      d.lass.d.ask = async () => JSON.stringify({ identified: true, category: "host-bug", summary: "The grid loses the layout after a resize.", evidence: [], fixable: "by-fix-run" });
      d.investigations.open({ kind: "user-report", function: "general", userText: "my layout resets" });
    });
    const bar = page.locator("footer.lass-bar");
    await expect(bar).toContainText("LASS found the problem");
    await expect(bar).toContainText("The grid loses the layout after a resize.");
    // A throwaway instance has no project folder next to it: no fix can run, and the bar says why.
    await expect(bar).toContainText("LASS cannot fix it on this PC");
    await expect(bar.getByRole("button", { name: "Start the fix" })).toHaveCount(0);

    // Stand-ins: a container that returns a patch touching the security core and a doc.
    await app.evaluate((_e, { inst }) => {
      const d = (globalThis as any).__dashboard;
      const diff = (p: string) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`;
      let polls = 0;
      d.fixes.d.repo = inst;
      d.fixes.d.bundle = async () => ({ data: Buffer.from("b"), base: "e".repeat(40) });
      d.fixes.d.container = {
        prepare: async () => undefined, image: async () => "localhost/dashboard-lass-dev:0123456789ab", pollMs: 5,
        backend: {
          start: async () => "job-lass-fix-0000000a", status: async () => ({ state: "running" }),
          logs: async function* () { yield polls++ < 3 ? '{"step":"claude"}' : '{"step":"finished"}'; }, copyIn: async () => undefined, stop: async () => undefined,
          copyOut: async () => ({ "out/fix.patch": Buffer.from(diff("src/main/layout.ts") + diff("docs/PROJECT.md")), "out/summary.md": Buffer.from("Keep the layout after a resize.\n\nThe resize handler saved before the snap."), "out/status.json": Buffer.from('{"npmCi":0,"claude":0,"typecheck":0,"unit":0}') }),
        },
      };
      d.fixes.d.test = async () => ({ build: "bbbbbbbbbbbb", buildHash: "h", worktree: "w", branch: "lass/x" });
      d.fixes.d.cleanUp = async () => undefined;
      d.fixes.d.setPending = (b: string) => { (globalThis as any).__pending = b; };
      d.fixes.d.restart = () => { (globalThis as any).__restarted = true; };
      d.shell.push();
    }, { inst });
    await expect(bar).toContainText("2 left");
    await bar.getByRole("button", { name: "Start the fix" }).click();

    await expect(bar).toContainText("LASS has a fix for you to review");
    await expect(bar).toContainText("Keep the layout after a resize.");
    await expect(bar).toContainText("1 security-relevant (red)");
    const files = bar.locator(".lass-files li");
    await expect(files.first()).toHaveClass(/red/);
    await expect(files.first()).toContainText("src/main/layout.ts");
    await expect(files.nth(1)).not.toHaveClass(/red/);
    await bar.getByRole("button", { name: "Show the changes" }).click();
    await expect(bar.getByLabel("The changes")).toContainText("+new");
    const testBtn = bar.getByRole("button", { name: "Test on this PC" });
    await expect(testBtn).toBeDisabled();
    // The host refuses too, whatever the page does.
    const id = await app.evaluate(() => (globalThis as any).__dashboard.investigations.list().find((i: any) => i.state === "fixing").id);
    expect(await app.evaluate((_e, id) => (globalThis as any).__dashboard.fixes.test(id, false), id)).toBe("confirm that you read the red changes first");
    await bar.getByLabel(/I have read the red changes/).check();
    await testBtn.click();

    await expect(bar).toContainText("The fix passed every test on this PC");
    await expect(bar).toContainText("Build bbbbbbbbbbbb");
    await bar.getByRole("button", { name: "Install and restart" }).click();
    await expect.poll(() => app.evaluate(() => [(globalThis as any).__pending, (globalThis as any).__restarted])).toEqual(["bbbbbbbbbbbb", true]);
    expect(await app.evaluate((_e, id) => (globalThis as any).__dashboard.investigations.get(id).fix.stage, id)).toBe("installing");
  } finally {
    await app.close();
  }
});
