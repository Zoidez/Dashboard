/**
 * LASS usage budget (docs/LASS.md, decision 2026-10-17): at most 10 triage calls and 2 fix runs per
 * day, counted in Build\data\lass\budget.json. Triage and fix runs count toward the user's plan limits.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type BudgetKind = "triage" | "fix";
export const DAILY_LIMITS: Record<BudgetKind, number> = { triage: 10, fix: 2 };

export class DailyBudget {
  constructor(private readonly file: string, private readonly limits = DAILY_LIMITS, private readonly now = () => new Date()) {}

  private read(): { day: string; used: Record<BudgetKind, number> } {
    const day = this.now().toISOString().slice(0, 10);
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { day?: string; used?: Partial<Record<BudgetKind, number>> };
      if (j.day === day) return { day, used: { triage: Number(j.used?.triage) || 0, fix: Number(j.used?.fix) || 0 } };
    } catch { /* first use today */ }
    return { day, used: { triage: 0, fix: 0 } };
  }

  left(kind: BudgetKind): number { return Math.max(0, this.limits[kind] - this.read().used[kind]); }

  /** Returns a unit taken today (a fix run the model never answered). */
  giveBack(kind: BudgetKind): void {
    const s = this.read();
    if (s.used[kind] <= 0) return;
    s.used[kind]--;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(s));
  }

  /** Takes one unit; false when today's limit is reached. */
  take(kind: BudgetKind): boolean {
    const s = this.read();
    if (s.used[kind] >= this.limits[kind]) return false;
    s.used[kind]++;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(s));
    return true;
  }
}
