/**
 * Investigations (docs/LASS.md, section 5): one active at a time, others queued first in, first out,
 * each in Build\data\lass\investigations\<id>.json so the queue survives a restart. While one is open
 * (queued or active), only its function is blocked; the user can always cancel it.
 *
 *   queued -> rechecking -> triage -> (identified | asking-user) -> fixing -> verifying -> closed
 *
 * Phase 1 (2026-10-17) has no triage yet: an investigation that reaches triage without one closes as
 * "failed: triage is not built yet", keeping its record, and unblocks its function at once.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** The function an investigation blocks. "general": a "Something's wrong" report blocks nothing. */
export type LassFunction = "newcard.create" | "general";
export type InvState = "queued" | "rechecking" | "triage" | "identified" | "asking-user" | "fixing" | "verifying" | "closed";
export type CloseReason = "fixed" | "not a bug" | "resolved earlier" | "dismissed" | `failed: ${string}`;

export interface Signal {
  kind: "repeat-failure" | "user-report";
  function: LassFunction;
  /** The request ids behind a repeat-failure signal. */
  requests?: string[];
  /** What the user typed (user-report): an instruction, not data. */
  userText?: string;
}

export interface Investigation {
  id: string;
  opened: string;
  signal: Signal;
  state: InvState;
  history: Array<{ at: string; state: InvState; note?: string }>;
  closeReason?: CloseReason;
  /** For the user (shown on the New card and later in the LASS bar). */
  summary?: string;
  /** Steps only the user can do (LASS.md 7). */
  userSteps?: string[];
}

export interface InvestigationDeps {
  /** Is the signal still true? (rechecking; host-only, no model) */
  stillTrue: (inv: Investigation) => Promise<boolean>;
  /** Triage (phase 2): returns where the investigation goes next. Absent in phase 1. */
  triage?: (inv: Investigation) => Promise<{ next: "closed"; reason: CloseReason; summary?: string; userSteps?: string[] } | { next: "asking-user" | "identified"; summary?: string }>;
  /** Time limits per state, ms (a timeout closes the investigation as "failed: timeout"). */
  limits?: Partial<Record<InvState, number>>;
  now?: () => Date;
}

const DEFAULT_LIMITS: Partial<Record<InvState, number>> = { rechecking: 30_000, triage: 180_000, "asking-user": 30 * 60_000, fixing: 2 * 3_600_000, verifying: 30 * 60_000 };
/** A dismissed repeat-failure signal for the same function does not reopen for 24 hours (LASS.md 7). */
export const DISMISS_COOLDOWN_MS = 24 * 3_600_000;

export class Investigations extends EventEmitter {
  private readonly items = new Map<string, Investigation>();
  private running = false;
  private readonly now: () => Date;

  constructor(private readonly dir: string, private readonly d: InvestigationDeps) {
    super();
    this.now = d.now ?? (() => new Date());
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => /^inv-[\w-]+\.json$/.test(f))) {
      try { const inv = JSON.parse(readFileSync(join(dir, f), "utf8")) as Investigation; this.items.set(inv.id, inv); } catch { /* unreadable record: ignored */ }
    }
    // An investigation that was active when the host stopped starts over from the queue.
    for (const inv of this.items.values()) if (inv.state !== "closed" && inv.state !== "queued") this.move(inv, "queued", "the Dashboard restarted");
  }

  /** Starts working the queue (call once after start-up, when the host is ready). */
  start(): void { void this.pump(); }

  list(): Investigation[] { return [...this.items.values()].sort((a, b) => a.opened.localeCompare(b.opened)); }
  get(id: string): Investigation | undefined { return this.items.get(id); }

  /** The open investigation (queued or active) that blocks this function, if any. */
  blocking(fn: LassFunction): Investigation | undefined {
    return this.list().find((i) => i.state !== "closed" && i.signal.function === fn);
  }

  /** Opens an investigation, unless the same signal for the same function is already open, or was dismissed less than 24 h ago (repeat failures). */
  open(signal: Signal): Investigation | null {
    const open = this.list().find((i) => i.state !== "closed" && i.signal.kind === signal.kind && i.signal.function === signal.function);
    if (open) return null;
    if (signal.kind === "repeat-failure") {
      const cutoff = this.now().getTime() - DISMISS_COOLDOWN_MS;
      if (this.list().some((i) => i.closeReason === "dismissed" && i.signal.kind === "repeat-failure" && i.signal.function === signal.function && Date.parse(i.history[i.history.length - 1].at) >= cutoff)) return null;
    }
    const at = this.now().toISOString();
    const inv: Investigation = { id: `inv-${at.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`, opened: at, signal: { ...signal, ...(signal.userText ? { userText: signal.userText.slice(0, 4000) } : {}) }, state: "queued", history: [{ at, state: "queued" }] };
    this.items.set(inv.id, inv);
    this.save(inv);
    this.emit("change", inv);
    void this.pump();
    return inv;
  }

  /** The user's Cancel: closes as dismissed and unblocks the function. */
  cancel(id: string): boolean {
    const inv = this.items.get(id);
    if (!inv || inv.state === "closed") return false;
    this.close(inv, "dismissed", "cancelled by the user");
    return true;
  }

  private save(inv: Investigation): void {
    const f = join(this.dir, `${inv.id}.json`);
    writeFileSync(f + ".tmp", JSON.stringify(inv, null, 2));
    renameSync(f + ".tmp", f);
  }

  private move(inv: Investigation, state: InvState, note?: string): void {
    inv.state = state;
    inv.history.push({ at: this.now().toISOString(), state, ...(note ? { note } : {}) });
    this.save(inv);
    this.emit("change", inv);
  }

  private close(inv: Investigation, reason: CloseReason, note?: string): void {
    inv.closeReason = reason;
    this.move(inv, "closed", note ?? reason);
  }

  /** Runs a step with the state's time limit; a timeout closes the investigation. */
  private async limited<T>(inv: Investigation, state: InvState, step: () => Promise<T>): Promise<T | "timeout"> {
    const ms = this.d.limits?.[state] ?? DEFAULT_LIMITS[state] ?? 60_000;
    let timer: NodeJS.Timeout | undefined;
    const r = await Promise.race([step(), new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), ms); timer.unref?.(); })]);
    clearTimeout(timer);
    return r;
  }

  /** Read through a method: the user may cancel while a step is awaited. */
  private isClosed(inv: Investigation): boolean { return this.items.get(inv.id)?.state === "closed"; }

  /** Works the queue: one investigation at a time, oldest first. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const inv = this.list().find((i) => i.state === "queued");
        if (!inv) break;
        this.move(inv, "rechecking");
        const still = await this.limited(inv, "rechecking", () => this.d.stillTrue(inv).catch(() => true));
        if (this.isClosed(inv)) continue;                           // cancelled meanwhile
        if (still === "timeout") { this.close(inv, "failed: timeout", "rechecking took too long"); continue; }
        if (!still) { this.close(inv, "resolved earlier"); continue; }
        this.move(inv, "triage");
        if (!this.d.triage) { this.close(inv, "failed: triage is not built yet (LASS phase 2)"); continue; }
        const t = await this.limited(inv, "triage", () => this.d.triage!(inv));
        if (this.isClosed(inv)) continue;
        if (t === "timeout") { this.close(inv, "failed: timeout", "triage took too long"); continue; }
        if (t.summary) inv.summary = t.summary;
        if (t.next === "closed") { if (t.userSteps) inv.userSteps = t.userSteps; this.close(inv, t.reason); continue; }
        // asking-user and identified continue in phase 2 (the LASS bar, fix runs); until then they stay open
        // for the user to see and cancel.
        this.move(inv, t.next);
        break;
      }
    } finally {
      this.running = false;
    }
  }
}
