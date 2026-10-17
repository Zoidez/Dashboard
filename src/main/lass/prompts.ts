/**
 * Prompt history and repeat detection (docs/LASS.md, section 4). Every New-card request is kept in
 * Build\data\lass\prompts.jsonl with its outcome, for 90 days. The host pre-filter decides when a
 * repeated failure is worth a look; only then (phase 2) does the triage model compare the texts.
 * Up to two earlier failed requests also go to the generator, as data (section 4.6).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type Outcome = "installed" | "rejected" | "failed: validation" | "failed: run" | "stopped";
export interface PromptRecord {
  id: string;
  at: string;
  kind: "new" | "update";
  target: string;
  preset: string | null;
  text: string;
  cardId?: string;
  outcome?: Outcome;
  outcomeAt?: string;
  /** Claude's last reply for a failed request (from the run log), shortened. */
  reply?: string;
}

type Line = { t: "submit"; r: Omit<PromptRecord, "outcome" | "outcomeAt" | "reply"> } | { t: "outcome"; id: string; at: string; outcome: Outcome; cardId?: string; reply?: string };

export const KEEP_DAYS = 90;
export const WINDOW_HOURS = 24;
const failed = (r: PromptRecord) => !!r.outcome && r.outcome.startsWith("failed");

export class PromptHistory {
  private records: PromptRecord[] = [];

  constructor(private readonly file: string, private readonly now = () => new Date()) {
    mkdirSync(dirname(file), { recursive: true });
    let lines: Line[] = [];
    try { lines = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Line]; } catch { return []; } }); } catch { /* none yet */ }
    const byId = new Map<string, PromptRecord>();
    for (const l of lines) {
      if (l.t === "submit") byId.set(l.r.id, { ...l.r });
      else { const r = byId.get(l.id); if (r) Object.assign(r, { outcome: l.outcome, outcomeAt: l.at, ...(l.cardId ? { cardId: l.cardId } : {}), ...(l.reply ? { reply: l.reply } : {}) }); }
    }
    const keepFrom = this.now().getTime() - KEEP_DAYS * 86_400_000;
    this.records = [...byId.values()].filter((r) => Date.parse(r.at) >= keepFrom).sort((a, b) => a.at.localeCompare(b.at));
    if (this.records.length < byId.size) this.rewrite();
  }

  private rewrite(): void {
    const lines: Line[] = [];
    for (const r of this.records) {
      const { outcome, outcomeAt, reply, ...sub } = r;
      lines.push({ t: "submit", r: sub });
      if (outcome) lines.push({ t: "outcome", id: r.id, at: outcomeAt ?? r.at, outcome, ...(r.cardId ? { cardId: r.cardId } : {}), ...(reply ? { reply } : {}) });
    }
    writeFileSync(this.file, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""));
  }

  private append(l: Line): void { try { appendFileSync(this.file, JSON.stringify(l) + "\n"); } catch { /* history never breaks a request */ } }

  submit(r: { kind: "new" | "update"; target: string; preset: string | null; text: string; cardId?: string }): string {
    const rec: PromptRecord = { id: `${this.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`, at: this.now().toISOString(), ...r, text: r.text.slice(0, 20_000) };
    this.records.push(rec);
    const { outcome: _o, outcomeAt: _a, reply: _r, ...sub } = rec;
    this.append({ t: "submit", r: sub });
    return rec.id;
  }

  outcome(id: string, outcome: Outcome, extra: { cardId?: string; reply?: string } = {}): void {
    const r = this.records.find((x) => x.id === id);
    if (!r) return;
    const reply = extra.reply ? extra.reply.trim().slice(0, 1500) : undefined;
    Object.assign(r, { outcome, outcomeAt: this.now().toISOString(), ...(extra.cardId ? { cardId: extra.cardId } : {}), ...(reply ? { reply } : {}) });
    this.append({ t: "outcome", id, at: r.outcomeAt!, outcome, ...(extra.cardId ? { cardId: extra.cardId } : {}), ...(reply ? { reply } : {}) });
  }

  get(id: string): PromptRecord | undefined { return this.records.find((r) => r.id === id); }
  all(): readonly PromptRecord[] { return this.records; }

  /** The two most recent new-card requests before `id`, within the last 24 hours (section 4.2). */
  candidates(id: string): PromptRecord[] {
    const cur = this.get(id);
    if (!cur) return [];
    const from = Date.parse(cur.at) - WINDOW_HOURS * 3_600_000;
    return this.records.filter((r) => r.id !== id && r.kind === "new" && r.at < cur.at && Date.parse(r.at) >= from).slice(-2).reverse();
  }

  /** Earlier failed new-card requests for the generator (section 4.6): up to two, from the last 24 hours. */
  previousFailed(id: string): PromptRecord[] {
    const cur = this.get(id);
    if (!cur || cur.kind !== "new") return [];
    const from = Date.parse(cur.at) - WINDOW_HOURS * 3_600_000;
    return this.records.filter((r) => r.id !== id && r.kind === "new" && r.at < cur.at && Date.parse(r.at) >= from && failed(r)).slice(-2).reverse();
  }

  /**
   * The host pre-filter (section 4.3): no model is called unless this request failed, both earlier
   * candidates failed too, and none of the three was stopped by the user.
   */
  preFilter(id: string): { pass: boolean; reason: string; requests: PromptRecord[] } {
    const cur = this.get(id);
    if (!cur) return { pass: false, reason: "unknown request", requests: [] };
    const c = this.candidates(id);
    const three = [cur, ...c];
    if (cur.kind !== "new") return { pass: false, reason: "not a new-card request", requests: three };
    if (!failed(cur)) return { pass: false, reason: `this request: ${cur.outcome ?? "no outcome"}`, requests: three };
    if (c.length < 2) return { pass: false, reason: `only ${c.length} earlier request(s) in the last 24 hours`, requests: three };
    if (three.some((r) => r.outcome === "stopped")) return { pass: false, reason: "one of them was stopped by the user", requests: three };
    if (!c.every(failed)) return { pass: false, reason: "an earlier request did not fail", requests: three };
    return { pass: true, reason: "three failed new-card requests in 24 hours", requests: three };
  }
}
