/**
 * State the host sends to its own pages (the grid and the Options window), and the messages they
 * send back. Card-provided text (names, status messages) is data: the pages render it as text only.
 */

export interface CardFrame {
  cardId: string;
  name: string;
  /** starting | loading | ok | stale | error | stopped | refused */
  state: string;
  message?: string;
  updatedAt?: string;
  accent: string;
  running: boolean;
  /** Can the user start it again from the grid (stopped, still approved)? */
  startable: boolean;
  size: { w: number; h: number };
}

/** The New card (CARDS.md 1): the generator pipeline's state and the CLI gate's. */
export interface GeneratorView {
  phase: "idle" | "checking" | "writing" | "validating" | "approval" | "installing" | "done" | "failed" | "stopped";
  message?: string;
  progress?: string;
  errors?: string;
  cardId?: string;
  attempt?: number;
  gate?: { ok: boolean; code?: string; reason?: string; version?: string };
  /** The CLI build in use, "<version>-<sha12>", if any. */
  build?: string;
  testing: boolean;
  canTest: boolean;
  targets: Array<{ cardId: string; name: string }>;
}

export interface NewCardRequest { text: string; target: string; preset: "watch-feed" | null }

export interface DashboardState {
  frames: CardFrame[];
  summary: string;
  generator: GeneratorView;
}

/** The frame body rectangle of a running card, in window content coordinates (CSS px). */
export interface FrameRect { cardId: string; x: number; y: number; width: number; height: number; visible: boolean }

export interface LayoutUpdate { order: string[]; sizes: Record<string, { w: number; h: number }> }

export type CardAction = "stop" | "start" | "revoke";

export interface PermissionLineView { text: string; reason: string; marks: Array<{ level: "red" | "yellow"; tag: string; why: string }> }

export interface OptionsState {
  general: { startWithWindows: boolean; closeToTray: boolean; packaged: boolean };
  feeds: Array<{ taskId: string; name: string; schedule: "daily" | "weekdays" | "none"; graceHours: number; keep: number; folder: string; state: string }>;
  cards: Array<{
    cardId: string; name: string; state: string; message?: string; running: boolean; revoked: boolean;
    versionHash: string | null; approvedAt: string | null; permissions: PermissionLineView[];
  }>;
  generator: { ok: boolean; version?: string; reason?: string };
  security: Array<{ at: string; cardId: string; kind: string; detail: string }>;
}

export type OptionsPatch =
  | { general: { startWithWindows?: boolean; closeToTray?: boolean } }
  | { feed: { taskId: string; schedule?: "daily" | "weekdays" | "none"; graceHours?: number; keep?: number } };
