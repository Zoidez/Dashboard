/**
 * LASS phase 2 (docs/LASS.md 4-7): triage behind the investigations. Builds the host bundle (signal,
 * recent requests, recent activity, host state), runs the triage model through the gate (purpose
 * "triage"), checks its JSON answer, and turns it into the investigation's next step. Also runs the
 * same-card check after a third failed new-card request, and keeps the daily budget.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ActivityEvent, ActivityLog } from "./activity.js";
import type { DailyBudget } from "./budget.js";
import type { FixBrief } from "./fix-run.js";
import { Investigations, type CloseReason, type Investigation } from "./investigations.js";
import type { PromptHistory, PromptRecord } from "./prompts.js";
import { parseSameCard, parseTriage, runTriage, sameCardPrompt, triagePrompt, type RequestForTriage, type TriageAnswer } from "./triage.js";

export interface LassServiceDeps {
  activity: ActivityLog;
  prompts: PromptHistory;
  budget: DailyBudget;
  /** The gate's launch with purpose "triage". */
  launchTriage: (args: string[], options: SpawnOptions) => Promise<ChildProcess>;
  kill: (child: ChildProcess) => void;
  hostDir: string;
  configDir: string;
  /** Build/data/lass: investigations, work folders. */
  lassDir: string;
  /** Gate and host-suite state in plain words (host-made). */
  hostState: () => string;
  /** Replaces the model call in tests. */
  ask?: (prompt: string) => Promise<string>;
}

/** What the LASS bar and the New card show (LASS.md 5, 7). */
export interface LassView {
  /** The bar asks the user to describe the problem. */
  asking: { id: string; title: string; summary?: string } | null;
  /** A finished investigation's answer and the steps only the user can do. */
  notice: { id: string; summary: string; userSteps: string[]; closeReason: string; function: string } | null;
}

const toTriage = (r: PromptRecord): RequestForTriage => ({ at: r.at, text: r.text, outcome: r.outcome ?? "no outcome", ...(r.reply ? { reply: r.reply } : {}) });

export class LassService {
  readonly investigations: Investigations;
  private seq = 0;

  constructor(private readonly d: LassServiceDeps) {
    this.investigations = new Investigations(join(d.lassDir, "investigations"), {
      stillTrue: async (inv) => this.stillTrue(inv),
      triage: async (inv) => this.triage(inv),
    });
  }

  /** One model call, in a fresh empty folder that is removed afterwards. */
  private async ask(prompt: string): Promise<string> {
    if (this.d.ask) return this.d.ask(prompt);
    const workDir = join(this.d.lassDir, "work", `${Date.now()}-${++this.seq}`);
    try {
      return await runTriage({ launch: this.d.launchTriage, kill: this.d.kill, hostDir: this.d.hostDir, configDir: this.d.configDir, workDir, prompt });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  /** Rechecking (LASS.md 5): a repeat failure is gone once a new-card request succeeded after it. */
  private stillTrue(inv: Investigation): boolean {
    if (inv.signal.kind !== "repeat-failure") return true;
    const ids = inv.signal.requests ?? [];
    const last = ids.map((id) => this.d.prompts.get(id)).filter(Boolean).sort((a, b) => b!.at.localeCompare(a!.at))[0];
    return !(last && this.d.prompts.all().some((x) => x.at > last.at && x.kind === "new" && x.outcome === "installed"));
  }

  /** After a failed new-card request (LASS.md 4.3-4.4): pre-filter, then the same-card check, then maybe an investigation. */
  async afterRequest(historyId: string): Promise<void> {
    const pf = this.d.prompts.preFilter(historyId);
    this.d.activity.write("lass", "prefilter", historyId, { pass: pf.pass, reason: pf.reason, requests: pf.requests.map((r) => r.id) });
    if (!pf.pass) return;
    if (!this.d.budget.take("triage")) { this.d.activity.write("lass", "budget.exhausted", historyId, { kind: "triage" }); return; }
    try {
      const a = parseSameCard(await this.ask(sameCardPrompt([...pf.requests].reverse().map(toTriage))));
      this.d.activity.write("lass", "same-card", historyId, { ...a });
      if (a.sameCard && a.confidence !== "low") {
        this.investigations.open({ kind: "repeat-failure", function: "newcard.create", requests: pf.requests.map((r) => r.id) });
      }
    } catch (e) {
      this.d.activity.write("lass", "same-card.failed", historyId, { error: (e as Error).message });
    }
  }

  /** The bundle (LASS.md 6): host-made text; everything from cards, reports or models goes in untrusted blocks. */
  private bundle(inv: Investigation) {
    const reqs = inv.signal.kind === "repeat-failure"
      ? (inv.signal.requests ?? []).map((id) => this.d.prompts.get(id)).filter((r): r is PromptRecord => !!r).sort((a, b) => a.at.localeCompare(b.at))
      : this.d.prompts.all().filter((r) => Date.parse(r.at) > Date.parse(inv.opened) - 24 * 3_600_000).slice(-3);
    const line = (e: ActivityEvent) => `#${e.seq} ${e.at.slice(11, 19)} ${e.source} ${e.kind}${e.target ? ` ${e.target}` : ""}${e.data ? ` ${JSON.stringify(e.data).slice(0, 300)}` : ""}`;
    const activity = this.d.activity.since(15, (e) => e.source !== "lass").slice(-80).map(line).join("\n") || "(no events)";
    const signal = inv.signal.kind === "repeat-failure"
      ? "three failed new-card requests in 24 hours that the same-card check judged to be for the same card"
      : "the user reported a problem through Help > Something's wrong";
    const userText = [inv.signal.userText, inv.userAnswer].filter(Boolean).join("\n\n") || undefined;
    return { signal, ...(userText ? { userText } : {}), requests: reqs.map(toTriage), activity, hostState: this.d.hostState() };
  }

  /** The fix run's brief (LASS.md 8): the same bundle as triage, as text; the user's words separate. */
  fixBrief(inv: Investigation): FixBrief {
    const b = this.bundle(inv);
    const evidence = [
      ...b.requests.map((r, i) => `Request ${i + 1} (${r.at.slice(0, 16).replace("T", " ")} UTC, outcome ${r.outcome}):\n${r.text.slice(0, 4000)}${r.reply ? `\nGenerator's last reply:\n${r.reply.slice(0, 4000)}` : ""}`),
      `Recent activity of the Dashboard (newest last):\n${b.activity}`,
    ].join("\n\n");
    return {
      invId: inv.id, branch: `lass/${inv.id}`,
      problem: `Signal: ${b.signal}.\nHost state: ${b.hostState}.\nInvestigation ${inv.id}, opened ${inv.opened}.`,
      ...(inv.summary ? { triageSummary: inv.summary } : {}),
      ...(b.userText ? { userText: b.userText } : {}),
      evidence,
    };
  }

  /** Triage (LASS.md 6), and what its answer means for the investigation. */
  private async triage(inv: Investigation): Promise<{ next: "closed"; reason: CloseReason; summary?: string; userSteps?: string[] } | { next: "asking-user" | "identified"; summary?: string }> {
    if (!this.d.budget.take("triage")) return { next: "closed", reason: "failed: today's 10 quick checks are used up", summary: "LASS has used today's quick checks; it can look into this again tomorrow." };
    let a: TriageAnswer;
    try {
      a = parseTriage(await this.ask(triagePrompt(this.bundle(inv))));
    } catch (e) {
      this.d.activity.write("lass", "triage.failed", inv.id, { error: (e as Error).message });
      return { next: "closed", reason: `failed: ${(e as Error).message.slice(0, 160)}` };
    }
    this.d.activity.write("lass", "triage", inv.id, { ...a });
    if (!a.identified) return { next: "asking-user", summary: a.summary };
    if (a.fixable === "by-user") return { next: "closed", reason: "not a bug", summary: a.summary, userSteps: a.userSteps };
    if (a.fixable === "by-fix-run") return { next: "identified", summary: a.summary };
    return { next: "closed", reason: "failed: LASS cannot fix this", summary: a.summary };
  }

  /** For the bar and the New card. */
  view(): LassView {
    const list = this.investigations.list();
    const ask = list.find((i) => i.state === "asking-user");
    const title = (i: Investigation) => {
      if (i.signal.kind === "user-report") return "your report";
      const last = (i.signal.requests ?? []).map((id) => this.d.prompts.get(id)).filter(Boolean).sort((a, b) => b!.at.localeCompare(a!.at))[0];
      return last ? `"${last.text.replace(/\s+/g, " ").slice(0, 60)}${last.text.length > 60 ? "…" : ""}"` : "a card";
    };
    const dayAgo = Date.now() - 24 * 3_600_000;
    const done = [...list].reverse().find((i) => i.state === "closed" && !i.acknowledged && (i.summary || i.userSteps?.length) && Date.parse(i.history[i.history.length - 1].at) > dayAgo);
    return {
      asking: ask ? { id: ask.id, title: title(ask), ...(ask.summary ? { summary: ask.summary } : {}) } : null,
      notice: done ? { id: done.id, summary: done.summary ?? "", userSteps: done.userSteps ?? [], closeReason: done.closeReason ?? "", function: done.signal.function } : null,
    };
  }
}
