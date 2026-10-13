/**
 * Grid layout: card order and sizes, saved to data/layout.json (ARCHITECTURE.md, Storage).
 *
 * Sizes are in fine grid units (user request 2026-10-09: resizing in much finer steps):
 * the grid has COLUMNS = 96 columns across the window and ROW_PX = 10 px rows, with no gap between
 * tracks; the visual spacing between cards comes from each frame's margin. One step is therefore
 * 1/96 of the grid width sideways and 10 px downwards.
 *
 * Manifest defaultSize stays in the coarse units of manifest.schema.json (1-12 columns of the old
 * 12-column grid, 80 px rows with 12 px gaps) and is converted here. layout.json files written
 * before this change (no "unit" field) are converted on load, so cards keep their size.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { LayoutUpdate } from "../shared/ui-state.js";

export const COLUMNS = 96;
export const ROW_PX = 10;
export const MAX_ROWS = 120;
export const MIN_W = 6;
export const MIN_H = 6;
const UNIT = "fine-96x10";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const cell = (n: unknown, min: number, max: number) => (typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null);

/** Coarse (12 columns, 80 px rows + 12 px gaps) to fine units, keeping the same visual size. */
export function coarseToFine(s: { w: number; h: number }): { w: number; h: number } {
  return {
    w: Math.min(COLUMNS, Math.max(MIN_W, Math.round(s.w * (COLUMNS / 12)))),
    h: Math.min(MAX_ROWS, Math.max(MIN_H, Math.round((s.h * 80 + (s.h - 1) * 12 + 12) / ROW_PX))),
  };
}

export class LayoutStore {
  private order: string[] = [];
  private sizes: Record<string, { w: number; h: number }> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LayoutUpdate> & { unit?: string };
      if (raw.unit !== UNIT && raw.sizes && typeof raw.sizes === "object") {
        // Older file in coarse units: convert each valid size.
        const converted: Record<string, { w: number; h: number }> = {};
        for (const [id, s] of Object.entries(raw.sizes)) {
          const w = cell((s as { w?: unknown })?.w, 1, 12), h = cell((s as { h?: unknown })?.h, 1, 12);
          if (w && h) converted[id] = coarseToFine({ w, h });
        }
        raw.sizes = converted;
      }
      this.apply(raw);
    } catch { /* new instance */ }
  }

  /** Validates and takes over a layout sent by the grid page (fine units). */
  apply(raw: Partial<LayoutUpdate>): void {
    if (Array.isArray(raw.order)) this.order = [...new Set(raw.order.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, 500);
    if (raw.sizes && typeof raw.sizes === "object") {
      const next: Record<string, { w: number; h: number }> = {};
      for (const [id, s] of Object.entries(raw.sizes).slice(0, 500)) {
        const w = cell((s as { w?: unknown })?.w, MIN_W, COLUMNS), h = cell((s as { h?: unknown })?.h, MIN_H, MAX_ROWS);
        if (ID_RE.test(id) && w && h) next[id] = { w, h };
      }
      this.sizes = next;
    }
  }

  save(): void {
    writeFileSync(this.file + ".tmp", JSON.stringify({ unit: UNIT, order: this.order, sizes: this.sizes }, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }

  /** Cards in layout order; unknown cards go to the end (sorted), sizes default from the manifest. */
  arrange<T extends { cardId: string }>(items: T[], defaultSize: (id: string) => { w: number; h: number }): Array<T & { size: { w: number; h: number } }> {
    const pos = new Map(this.order.map((id, i) => [id, i]));
    return [...items]
      .sort((a, b) => (pos.get(a.cardId) ?? 1e9) - (pos.get(b.cardId) ?? 1e9) || a.cardId.localeCompare(b.cardId))
      .map((it) => ({ ...it, size: this.sizes[it.cardId] ?? defaultSize(it.cardId) }));
  }
}

/** A manifest defaultSize (coarse units, 1-12) as a fine-unit size; 4 x 4 coarse if missing or invalid. */
export function clampSize(s: { w?: number; h?: number } | undefined): { w: number; h: number } {
  return coarseToFine({ w: cell(s?.w, 1, 12) ?? 4, h: cell(s?.h, 1, 12) ?? 4 });
}
