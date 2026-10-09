/**
 * Feed service (PRESETS.md, watch feed): watches ClaudeExchange/reports/<task-id>/, validates
 * reports, keeps the feed state, and prunes old reports.
 *
 * State (spec/host-api.d.ts FeedState):
 *   latest   the newest valid report with status "ok" (kept on screen when the feed goes offline)
 *   offline  invalid-file: the newest file does not parse or fails the schema
 *            run-failed:   the newest report says status "failed"
 *            overdue:      no report by the next expected run + grace period
 * The host reads report files itself (never a card): only regular files named
 * <YYYYMMDDTHHMMSSZ>.json, at most 1 MB, links skipped.
 */
import { watch, type FSWatcher, promises as fsp } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "../audit.js";
import type { FeedConfig } from "../options.js";
import { fileTime, MAX_REPORT_BYTES, REPORT_FILE_RE, validateReport, type Report } from "./report.js";

export interface FeedState {
  latest: Report | null;
  offline: null | { reason: "invalid-file" | "run-failed" | "overdue"; detail: string; since: string };
}

interface Parsed { mtimeMs: number; size: number; result: { ok: true; report: Report } | { ok: false; reason: string } }

const SETTLE_MS = 750;        // a file must be unchanged this long before it is read (write-finish detection)

/** When the next run is expected after a run that finished at `last` (local time for weekdays). */
export function nextExpectedRun(last: Date, schedule: FeedConfig["schedule"]): Date | null {
  if (schedule === "none") return null;
  const next = new Date(last.getTime() + 24 * 3600 * 1000);
  if (schedule === "weekdays") while (next.getDay() === 0 || next.getDay() === 6) next.setTime(next.getTime() + 24 * 3600 * 1000);
  return next;
}

export class FeedService {
  private readonly states = new Map<string, FeedState>();
  private readonly cache = new Map<string, Map<string, Parsed>>();
  private readonly history = new Map<string, Report[]>();
  private readonly listeners = new Map<string, Set<(s: FeedState) => void>>();
  private readonly watchers: FSWatcher[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private overdueTimer: NodeJS.Timeout | null = null;

  constructor(private readonly reportsDir: string, private readonly feeds: () => readonly FeedConfig[], private readonly audit: AuditLog, private readonly now: () => number = Date.now) {}

  async start(): Promise<void> {
    for (const f of this.feeds()) {
      const dir = join(this.reportsDir, f.taskId);
      await fsp.mkdir(dir, { recursive: true });
      try {
        const w = watch(dir, { persistent: false }, () => this.schedule(f.taskId, 200));
        w.on("error", () => undefined);
        this.watchers.push(w);
      } catch { /* folder vanished; rescans still run on the minute timer */ }
      await this.rescan(f.taskId);
    }
    this.overdueTimer = setInterval(() => { for (const f of this.feeds()) void this.rescan(f.taskId); }, 60_000);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers.length = 0;
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.overdueTimer) clearInterval(this.overdueTimer);
  }

  isFeed(taskId: string): boolean { return this.feeds().some((f) => f.taskId === taskId); }

  state(taskId: string): FeedState {
    return this.states.get(taskId) ?? { latest: null, offline: null };
  }

  historyOf(taskId: string, limit = 30): Report[] {
    return (this.history.get(taskId) ?? []).slice(0, Math.max(0, Math.min(30, limit)));
  }

  onChange(taskId: string, cb: (s: FeedState) => void): () => void {
    if (!this.listeners.has(taskId)) this.listeners.set(taskId, new Set());
    this.listeners.get(taskId)!.add(cb);
    return () => this.listeners.get(taskId)?.delete(cb);
  }

  private schedule(taskId: string, ms: number): void {
    const t = this.timers.get(taskId);
    if (t) clearTimeout(t);
    this.timers.set(taskId, setTimeout(() => { this.timers.delete(taskId); void this.rescan(taskId); }, ms));
  }

  /** Re-reads the folder and recomputes the state. Public for tests and the minute timer. */
  async rescan(taskId: string): Promise<void> {
    const feed = this.feeds().find((f) => f.taskId === taskId);
    if (!feed) return;
    const dir = join(this.reportsDir, taskId);
    let names: string[] = [];
    try { names = (await fsp.readdir(dir)).filter((n) => REPORT_FILE_RE.test(n)).sort().reverse(); } catch { names = []; }
    const cache = this.cache.get(taskId) ?? new Map<string, Parsed>();
    this.cache.set(taskId, cache);
    let unsettled = false;
    const parsed: Array<{ name: string; p: Parsed }> = [];
    for (const name of names) {
      const file = join(dir, name);
      let st;
      try { st = await fsp.lstat(file); } catch { continue; }
      if (!st.isFile()) continue;                                   // links and folders are never read
      if (this.now() - st.mtimeMs < SETTLE_MS) { unsettled = true; continue; }
      const hit = cache.get(name);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) { parsed.push({ name, p: hit }); continue; }
      let result: Parsed["result"];
      if (st.size > MAX_REPORT_BYTES) result = { ok: false, reason: "the file is larger than 1 MB" };
      else {
        try { result = validateReport(JSON.parse((await fsp.readFile(file, "utf8")).replace(/^﻿/, "")), taskId); }
        catch { result = { ok: false, reason: "the file is not valid JSON" }; }
      }
      const p = { mtimeMs: st.mtimeMs, size: st.size, result };
      cache.set(name, p);
      parsed.push({ name, p });
    }
    if (unsettled) this.schedule(taskId, SETTLE_MS);

    const valid = parsed.filter((x) => x.p.result.ok).map((x) => (x.p.result as { report: Report }).report);
    this.history.set(taskId, valid.slice(0, 30));
    const latest = valid.find((r) => r.status === "ok") ?? null;
    const newest = parsed[0];
    let offline: FeedState["offline"] = null;
    if (newest && !newest.p.result.ok) {
      offline = { reason: "invalid-file", detail: `${newest.name}: ${newest.p.result.reason}`, since: new Date(fileTime(newest.name) || newest.p.mtimeMs).toISOString() };
    } else if (newest && newest.p.result.ok && newest.p.result.report.status === "failed") {
      offline = { reason: "run-failed", detail: newest.p.result.report.bottomLine.slice(0, 300), since: newest.p.result.report.runFinishedAt };
    } else if (newest && newest.p.result.ok) {
      const expected = nextExpectedRun(new Date(newest.p.result.report.runFinishedAt), feed.schedule);
      if (expected && this.now() > expected.getTime() + feed.graceHours * 3600 * 1000) {
        offline = { reason: "overdue", detail: `no report since ${newest.p.result.report.runFinishedAt}; one was expected by ${expected.toISOString()}`, since: new Date(expected.getTime() + feed.graceHours * 3600 * 1000).toISOString() };
      }
    }
    const state: FeedState = { latest, offline };
    const before = JSON.stringify(this.states.get(taskId) ?? null);
    this.states.set(taskId, state);
    if (JSON.stringify(state) !== before) for (const cb of this.listeners.get(taskId) ?? []) { try { cb(state); } catch { /* listener's problem */ } }

    await this.prune(taskId, names, feed.keep);
  }

  /** Keeps the newest `keep` report files; older ones are removed by the host (PRESETS.md, retention). */
  private async prune(taskId: string, namesNewestFirst: string[], keep: number): Promise<void> {
    const dir = join(this.reportsDir, taskId);
    for (const name of namesNewestFirst.slice(keep)) {
      const file = join(dir, name);
      try {
        const st = await fsp.lstat(file);
        if (!st.isFile()) continue;
        await fsp.unlink(file);
        this.cache.get(taskId)?.delete(name);
        this.audit.write("_host", "fs", `pruned old report ${taskId}/${name}`);
      } catch { /* in use or gone; next scan */ }
    }
  }
}
