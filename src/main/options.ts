/**
 * File > Options, saved to data/config/options.json (ARCHITECTURE.md, "Menu and Options").
 * General settings and the watched feeds; every edit is validated here before it is saved.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TASK_ID_RE } from "./reports/report.js";

export interface FeedConfig {
  taskId: string;
  name: string;
  /** When the task runs; used for the "overdue" check. "none" = no overdue check. */
  schedule: "daily" | "weekdays" | "none";
  /** Hours after the expected run before the feed counts as offline (PRESETS.md: default 2). */
  graceHours: number;
  /** Reports kept per task (PRESETS.md: default 30). */
  keep: number;
}

export interface General { startWithWindows: boolean; closeToTray: boolean }
export interface Options { schema: 1; general: General; feeds: FeedConfig[] }
const DEFAULT_GENERAL: General = { startWithWindows: false, closeToTray: true };

/** The three connected tasks (EXCHANGE.md, "Connected tasks"). */
export const DEFAULT_FEEDS: FeedConfig[] = [
  { taskId: "trig_01ErEFUF3HVkStP55y82wGH1", name: "Weekday morning brief", schedule: "weekdays", graceHours: 2, keep: 30 },
  { taskId: "trig_01JKJw5sKmS7HACpjCGdDWw8", name: "Daily gamedev industry moves watch", schedule: "daily", graceHours: 2, keep: 30 },
  { taskId: "trig_01AmX52WU9gtbFB6fHLAW7A6", name: "Daily Kessler Syndrome watch", schedule: "daily", graceHours: 2, keep: 30 },
];

function cleanFeed(f: Partial<FeedConfig>): FeedConfig | null {
  if (typeof f.taskId !== "string" || !TASK_ID_RE.test(f.taskId)) return null;
  return {
    taskId: f.taskId,
    name: typeof f.name === "string" && f.name.length > 0 && f.name.length <= 200 ? f.name : f.taskId,
    schedule: f.schedule === "daily" || f.schedule === "weekdays" ? f.schedule : "none",
    graceHours: typeof f.graceHours === "number" && f.graceHours >= 0 && f.graceHours <= 168 ? f.graceHours : 2,
    keep: typeof f.keep === "number" && Number.isInteger(f.keep) && f.keep >= 1 && f.keep <= 1000 ? f.keep : 30,
  };
}

export class OptionsStore {
  private value: Options;
  constructor(private readonly file: string) {
    let v: Options | null = null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Options>;
      if (raw && Array.isArray(raw.feeds)) {
        const g = (raw.general ?? {}) as Partial<General>;
        v = {
          schema: 1,
          general: { startWithWindows: g.startWithWindows === true, closeToTray: g.closeToTray !== false },
          feeds: raw.feeds.map(cleanFeed).filter((x): x is FeedConfig => !!x),
        };
      }
    } catch { /* missing or unreadable: defaults */ }
    this.value = v ?? { schema: 1, general: { ...DEFAULT_GENERAL }, feeds: DEFAULT_FEEDS.map((f) => ({ ...f })) };
    if (!v) this.save();
  }

  get feeds(): readonly FeedConfig[] { return this.value.feeds; }
  feed(taskId: string): FeedConfig | undefined { return this.value.feeds.find((f) => f.taskId === taskId); }
  get general(): Readonly<General> { return this.value.general; }

  setGeneral(patch: Partial<Record<keyof General, unknown>>): void {
    for (const k of ["startWithWindows", "closeToTray"] as const) if (typeof patch[k] === "boolean") this.value.general[k] = patch[k] as boolean;
    this.save();
  }

  /** Edits one feed's schedule, grace period or retention; the task id and name are not editable here. */
  setFeed(taskId: string, patch: Partial<Record<"schedule" | "graceHours" | "keep", unknown>>): boolean {
    const f = this.feed(taskId);
    if (!f) return false;
    const next = cleanFeed({ ...f, ...patch } as Partial<FeedConfig>);
    if (!next) return false;
    if (patch.schedule !== undefined && next.schedule !== patch.schedule) return false;
    if (patch.graceHours !== undefined && next.graceHours !== patch.graceHours) return false;
    if (patch.keep !== undefined && next.keep !== patch.keep) return false;
    Object.assign(f, next);
    this.save();
    return true;
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.value, null, 2));
    renameSync(this.file + ".tmp", this.file);
  }
}
