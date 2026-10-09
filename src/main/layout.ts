/**
 * Grid layout: card order and sizes in cells, saved to data/layout.json (ARCHITECTURE.md, Storage).
 * Sizes start from the manifest's defaultSize; the user can resize afterwards.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LayoutUpdate } from "../shared/ui-state.js";

export const COLUMNS = 12;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const cell = (n: unknown, max: number) => (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max ? n : null);

export class LayoutStore {
  private order: string[] = [];
  private sizes: Record<string, { w: number; h: number }> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LayoutUpdate>;
      this.apply(raw);
    } catch { /* new instance */ }
  }

  /** Validates and takes over a layout sent by the grid page. */
  apply(raw: Partial<LayoutUpdate>): void {
    if (Array.isArray(raw.order)) this.order = [...new Set(raw.order.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, 500);
    if (raw.sizes && typeof raw.sizes === "object") {
      const next: Record<string, { w: number; h: number }> = {};
      for (const [id, s] of Object.entries(raw.sizes).slice(0, 500)) {
        const w = cell((s as { w?: unknown })?.w, COLUMNS), h = cell((s as { h?: unknown })?.h, 12);
        if (ID_RE.test(id) && w && h) next[id] = { w, h };
      }
      this.sizes = next;
    }
  }

  save(): void {
    writeFileSync(this.file + ".tmp", JSON.stringify({ order: this.order, sizes: this.sizes }, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }

  /** Cards in layout order; unknown cards go to the end (sorted), sizes default from the manifest. */
  arrange<T extends { cardId: string }>(items: T[], defaultSize: (id: string) => { w: number; h: number }): Array<T & { size: { w: number; h: number } }> {
    const pos = new Map(this.order.map((id, i) => [id, i]));
    return [...items]
      .sort((a, b) => (pos.get(a.cardId) ?? 1e9) - (pos.get(b.cardId) ?? 1e9) || a.cardId.localeCompare(b.cardId))
      .map((it) => ({ ...it, size: this.sizes[it.cardId] ?? clampSize(defaultSize(it.cardId)) }));
  }
}

export function clampSize(s: { w?: number; h?: number } | undefined): { w: number; h: number } {
  return { w: cell(s?.w, COLUMNS) ?? 4, h: cell(s?.h, 12) ?? 4 };
}
