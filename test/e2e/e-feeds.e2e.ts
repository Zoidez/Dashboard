/**
 * TESTPLAN E1-E3 through the app, plus the install flow for the watch-feed reference cards.
 * Approval is given by a test stand-in for the user's click (the decide function), which also
 * checks what the dialog would show.
 */
import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, makeInstance, ready, snapshot, waitFor } from "./helpers";

const KESSLER = "trig_01AmX52WU9gtbFB6fHLAW7A6";
const MORNING = "trig_01ErEFUF3HVkStP55y82wGH1";

function putReport(inst: string, task: string, name: string, content: string) {
  mkdirSync(join(inst, "ClaudeExchange", "reports", task), { recursive: true });
  const f = join(inst, "ClaudeExchange", "reports", task, name);
  writeFileSync(f, content);
  const old = new Date(Date.now() - 60_000);
  utimesSync(f, old, old);
}

async function cardDom(app: Awaited<ReturnType<typeof launch>>, cardId: string) {
  return app.evaluate(async (_e, id) => {
    const c = (globalThis as any).__dashboard.host.cards.get(id);
    if (!c) return null;
    return c.view.webContents.executeJavaScript(`(() => {
      const root = document.getElementById("card");
      return {
        severity: root.dataset.severity ?? null,
        label: root.querySelector(".feed-sev")?.textContent ?? null,
        bottom: root.querySelector(".feed-bottom")?.textContent ?? null,
        offline: root.querySelector(".feed-offline")?.textContent ?? null,
        text: root.textContent,
        dangerous: root.querySelectorAll("img, script, iframe, object, embed, link, style:not(#feed-style), form, [href], [src], [onerror], [onclick]").length,
        links: [...root.querySelectorAll(".md-link")].map((a) => a.title),
      };
    })()`);
  }, cardId);
}

test("E1-E3: watch-feed cards install, show reports, render hostile Markdown inert, and go offline", async () => {
  let hits = 0;
  const server = createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const inst = makeInstance();
  // A report from an hour ago, so the daily feed is not overdue whenever the test runs.
  const finished = new Date(Date.now() - 3600_000);
  const stampOf = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const stamp = stampOf(finished);
  putReport(inst, KESSLER, `${stamp}.json`, JSON.stringify({
    schemaVersion: 0, taskId: KESSLER, taskName: "Daily Kessler Syndrome watch",
    runStartedAt: new Date(finished.getTime() - 600_000).toISOString(), runFinishedAt: finished.toISOString(), status: "ok", severity: "high",
    bottomLine: "A fragmentation event raised collision risk in LEO.",
    body: [
      "## Items", "", "- **High:** breakup of a rocket body", "",
      `<img src="http://127.0.0.1:${port}/pixel.png" onerror="alert(1)">`, "",
      `![tracker](https://127.0.0.1:${port}/t.png)`, "",
      "<script>document.title='pwned'</script> [click me](javascript:alert(1)) [source](https://celestrak.org/x)",
    ].join("\n"),
    sources: [{ title: "CelesTrak", url: "https://celestrak.org/" }],
  }));

  const app = await launch(inst);
  try {
    await ready(app);
    const reviews: Array<{ cardId: string; yellow: boolean; red: boolean; lines: string[] }> = [];
    const result = await app.evaluate(async () => {
      const d = (globalThis as any).__dashboard;
      const seen: unknown[] = [];
      (globalThis as any).__reviews = seen;
      return d.installFeedCards(async (r: any) => {
        seen.push({ cardId: r.cardId, yellow: r.display.yellow, red: r.display.red, lines: r.display.lines.map((l: any) => l.text) });
        return r.cardId !== "feed-weekday-morning-brief";       // decline one
      });
    });
    reviews.push(...(await app.evaluate(() => (globalThis as any).__reviews)));
    console.log("install:", JSON.stringify(result));
    expect(result).toEqual({
      "feed-weekday-morning-brief": "declined",
      "feed-daily-gamedev-industry-moves-watch": "installed",
      "feed-daily-kessler-syndrome-watch": "installed",
    });
    expect(existsSync(join(inst, "data", "cards", "feed-weekday-morning-brief"))).toBe(false);
    expect(existsSync(join(inst, "data", "approvals", "feed-weekday-morning-brief.json"))).toBe(false);
    for (const r of reviews) {
      expect(r.yellow, r.cardId).toBe(true);
      expect(r.red, r.cardId).toBe(false);
      expect(r.lines[1]).toBe("Open any web link in your browser");
    }

    // E1: the report is shown with its severity colour and label.
    const dom = await waitFor(async () => { const d = await cardDom(app, "feed-daily-kessler-syndrome-watch"); return d?.bottom ? d : null; }, "the Kessler card to render");
    console.log("kessler card:", JSON.stringify(dom));
    expect(dom.severity).toBe("high");
    expect(dom.label).toBe("Severity: High");
    expect(dom.bottom).toBe("A fragmentation event raised collision risk in LEO.");
    expect(dom.offline).toBeNull();
    // E3: hostile Markdown is inert.
    expect(dom.dangerous).toBe(0);
    expect(dom.text).toContain("<script>document.title='pwned'</script>");
    expect(dom.text).toContain("[image: tracker]");
    expect(dom.links).toEqual(["https://celestrak.org/x", "https://celestrak.org/"]);
    const gamedev = await waitFor(async () => { const d = await cardDom(app, "feed-daily-gamedev-industry-moves-watch"); return d?.text ? d : null; }, "the gamedev card");
    expect(gamedev.text).toContain("No report has arrived yet");

    // E2: a newer invalid file -> "Feed offline", the last good report stays.
    putReport(inst, KESSLER, `${stampOf(new Date())}.json`, JSON.stringify({ schemaVersion: 0, taskId: KESSLER, status: "ok" }));
    const off = await waitFor(async () => { const d = await cardDom(app, "feed-daily-kessler-syndrome-watch"); return d?.offline ? d : null; }, "the offline banner", 20_000);
    console.log("offline banner:", off.offline);
    expect(off.offline).toContain("Feed offline");
    expect(off.offline).toContain("the newest report file is invalid");
    expect(off.bottom).toBe("A fragmentation event raised collision risk in LEO.");
    const snap = await snapshot(app);
    expect(snap.running.find((c) => c.cardId === "feed-daily-kessler-syndrome-watch")?.status.state).toBe("stale");
    expect(snap.audit.filter((e) => e.cardId.startsWith("feed-") && e.kind === "blocked-request")).toEqual([]);
    expect(hits, "the hostile image reached the listener").toBe(0);
  } finally {
    await app.close();
    server.close();
  }
});
