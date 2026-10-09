/** Reports and feeds (TESTPLAN E1, E2, E4), Markdown safety (E3, parser side), permission display (D1, D2 logic). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog } from "../../src/main/audit.js";
import { FeedService, nextExpectedRun } from "../../src/main/reports/feeds.js";
import { fileTime, validateReport } from "../../src/main/reports/report.js";
import { parse, inline, safeHref, type Block, type Inline } from "../../src/shared/markdown.js";
import { display } from "../../src/main/cards/permission-lines.js";

const TASK = "trig_01AmX52WU9gtbFB6fHLAW7A6";
const report = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 0, taskId: TASK, taskName: "Daily Kessler Syndrome watch",
  runStartedAt: "2026-10-09T06:00:00Z", runFinishedAt: "2026-10-09T06:10:00Z",
  status: "ok", severity: "medium", bottomLine: "Two notable items.", body: "# Digest\n\nText.", sources: [{ title: "ESA", url: "https://esa.int/x" }],
  ...over,
});
const stamp = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "").replace("Z", "Z");

test("report validation: required fields, severity, taskId vs folder, extra fields dropped", () => {
  const ok = validateReport({ ...report(), extra: 1 }, TASK);
  assert.equal(ok.ok, true);
  assert.equal("extra" in (ok as { report: object }).report, false);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ severity: undefined }, /severity/], [{ severity: "urgent" }, /severity/], [{ taskId: "trig_9999999999" }, /does not match its folder/],
    [{ status: "partial" }, /status/], [{ bottomLine: "" }, /bottomLine/], [{ runFinishedAt: "yesterday" }, /runFinishedAt/],
    [{ sources: [{ title: "x", url: "javascript:alert(1)" }] }, /source/], [{ schemaVersion: 1 }, /schemaVersion/],
  ];
  for (const [o, re] of bad) { const r = validateReport(report(o), TASK); assert.equal(r.ok, false, JSON.stringify(o)); assert.match((r as { reason: string }).reason, re); }
  assert.equal(validateReport([], TASK).ok, false);
  assert.equal(fileTime("20261009T061000Z.json"), Date.parse("2026-10-09T06:10:00Z"));
  assert.ok(Number.isNaN(fileTime("x.json")));
});

test("next expected run: daily +24 h; weekdays skip Saturday and Sunday", () => {
  const fri = new Date(2026, 9, 9, 7, 0);          // Friday 9 Oct 2026, local time
  assert.equal(nextExpectedRun(fri, "daily")!.getDay(), 6);
  assert.equal(nextExpectedRun(fri, "weekdays")!.getDay(), 1);
  assert.equal(nextExpectedRun(fri, "none"), null);
});

function feedEnv(now: number) {
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  mkdirSync(join(dir, TASK));
  const svc = new FeedService(dir, () => [{ taskId: TASK, name: "Kessler", schedule: "daily", graceHours: 2, keep: 30 }], new AuditLog(join(dir, "audit")), () => now);
  const put = (name: string, content: string) => {
    const f = join(dir, TASK, name);
    writeFileSync(f, content);
    const old = new Date(now - 60_000);
    utimesSync(f, old, old);                          // settled: older than the write-finish window
  };
  return { dir, svc, put };
}

test("feed state: latest valid ok report; invalid newest file, failed run and overdue go offline but keep the last good one", async () => {
  const now = Date.parse("2026-10-09T09:00:00Z");
  const { svc, put } = feedEnv(now);
  await svc.rescan(TASK);
  assert.deepEqual(svc.state(TASK), { latest: null, offline: null });

  put("20261009T061000Z.json", JSON.stringify(report()));
  await svc.rescan(TASK);
  assert.equal(svc.state(TASK).latest?.severity, "medium");
  assert.equal(svc.state(TASK).offline, null);

  put("20261009T071000Z.json", "{ not json");
  await svc.rescan(TASK);
  assert.equal(svc.state(TASK).offline?.reason, "invalid-file");
  assert.equal(svc.state(TASK).latest?.runFinishedAt, "2026-10-09T06:10:00Z");

  put("20261009T081000Z.json", JSON.stringify(report({ runFinishedAt: "2026-10-09T08:10:00Z", status: "failed", severity: "none", bottomLine: "The source was down." })));
  await svc.rescan(TASK);
  assert.deepEqual([svc.state(TASK).offline?.reason, svc.state(TASK).offline?.detail], ["run-failed", "The source was down."]);
  assert.equal(svc.state(TASK).latest?.runFinishedAt, "2026-10-09T06:10:00Z");

  const late = feedEnv(Date.parse("2026-10-10T09:00:00Z"));      // 26 h 50 min after the last run: past 24 h + 2 h grace
  late.put("20261009T061000Z.json", JSON.stringify(report()));
  await late.svc.rescan(TASK);
  assert.equal(late.svc.state(TASK).offline?.reason, "overdue");
  assert.equal(late.svc.state(TASK).latest?.severity, "medium");
});

test("feed retention keeps the newest 30 report files; history is newest first", async () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  const { dir, svc, put } = feedEnv(now);
  for (let i = 0; i < 35; i++) {
    const t = new Date(Date.parse("2026-10-01T06:00:00Z") + i * 86400_000).toISOString().replace(/\.\d+Z$/, "Z");
    put(`${stamp(t)}.json`, JSON.stringify(report({ runFinishedAt: t, bottomLine: `day ${i}` })));
  }
  await svc.rescan(TASK);
  const left = readdirSync(join(dir, TASK)).filter((f) => f.endsWith(".json")).sort();
  assert.equal(left.length, 30);
  assert.equal(left[0], `${stamp("2026-10-06T06:00:00Z")}.json`);
  assert.equal(svc.historyOf(TASK, 3).map((r) => r.bottomLine).join(","), "day 34,day 33,day 32");
});

// ---------- Markdown ----------

function texts(nodes: Array<Block | Inline>): string {
  return JSON.stringify(nodes);
}

test("markdown: HTML stays text, images become alt text, only https links become links", () => {
  const doc = parse([
    "# Title <script>alert(1)</script>",
    "<img src=\"http://127.0.0.1/x.png\" onerror=\"alert(1)\">",
    "![tracker](https://evil.example/pixel.png) and [click](javascript:alert(1)) and [data](data:text/html,<b>x</b>)",
    "[ok](https://example.com/a) <https://example.com/b> https://example.com/c.",
    "<iframe src=https://evil.example></iframe>",
  ].join("\n\n"));
  const j = texts(doc);
  assert.ok(!/"t":"(img|script|iframe)"/.test(j));
  assert.ok(j.includes("<script>alert(1)</script>"), "the script tag is kept as literal text");
  assert.ok(j.includes("[image: tracker]"));
  assert.ok(j.includes("[click](javascript:alert(1))"), "a javascript: link stays text");
  const links = j.match(/"t":"link","href":"[^"]+"/g) ?? [];
  // The iframe's https URL is literal text that happens to contain a URL: shown as a link, never loaded.
  assert.deepEqual(links.map((l) => l.split('"href":"')[1].slice(0, -1)), ["https://example.com/a", "https://example.com/b", "https://example.com/c", "https://evil.example/"]);
  assert.equal(safeHref("http://example.com"), null);
  assert.equal(safeHref("https://user:pw@example.com"), null);
  assert.equal(safeHref("file:///C:/Windows/win.ini"), null);
});

test("markdown: structure (lists, nesting, tables, quotes, code, emphasis)", () => {
  const doc = parse("- a\n- b\n  - b1\n\n1. one\n2. two\n\n| Item | Rating |\n|---|---|\n| X | High |\n\n> quoted **bold**\n\n```\ncode <b>\n```\n\n***\n\nsome *em* and ~~del~~ `x`");
  assert.deepEqual(doc.map((b) => b.t), ["list", "list", "table", "quote", "pre", "hr", "p"]);
  const ul = doc[0] as Extract<Block, { t: "list" }>;
  assert.equal(ul.items.length, 2);
  assert.equal(ul.items[1][1]?.t, "list", "b1 is nested under b");
  assert.equal((doc[4] as { v: string }).v, "code <b>");
  assert.deepEqual(inline("some *em* and ~~del~~ `x`").map((n) => n.t), ["text", "em", "text", "del", "text", "code"]);
  const deep = "> ".repeat(50) + "x";
  assert.doesNotThrow(() => parse(deep));
  assert.doesNotThrow(() => parse("*".repeat(5000) + "_".repeat(5000)));
});

// ---------- permission display ----------

test("permission display: lines, red and yellow markings, combinations", () => {
  const feed = display([
    { type: "reports.read", taskId: TASK, reason: "shows the reports" },
    { type: "links.open", any: true, reason: "opens source links" },
  ], () => "Daily Kessler Syndrome watch");
  assert.equal(feed.lines[0].text, 'Read the reports of your scheduled task "Daily Kessler Syndrome watch"');
  assert.equal(feed.red, false);
  assert.equal(feed.yellow, true);
  assert.equal(feed.lines[1].marks[0].tag, "Y");

  const risky = display([
    { type: "fs.read", path: "C:\\Data", reason: "reads data files" },
    { type: "net.http", origin: "https://api.example.com", methods: ["POST"], reason: "uploads results" },
    { type: "net.http", origin: "https://192.168.1.10", methods: ["GET"], reason: "talks to the NAS" },
    { type: "fs.write", path: "C:\\", reason: "writes everywhere" },
  ]);
  assert.match(risky.lines[1].text, /^Send data to/);
  assert.ok(risky.lines[2].marks.some((m) => m.level === "red" && /local network/.test(m.why)), "private IP literal is red");
  assert.ok(risky.lines[3].marks.some((m) => m.level === "red" && /large part/.test(m.why)), "drive root write is red");
  assert.deepEqual(risky.combinations.map((c) => c.id).sort(), ["D1", "D2", "D3"]);
  assert.equal(risky.red, true);
});
