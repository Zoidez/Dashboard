/**
 * State the host sends to its own pages (the grid and the Options window), and the messages they
 * send back. Card-provided text (names, status messages) is data: the pages render it as text only.
 */

/** Permission groups the user switches (main/broker/permissions.ts PermissionCategory). */
export type PermissionCategory = "web" | "files" | "system" | "reports";
/** A group's state on one card: all on, all off, some of each, or not asked for by the card. */
export type CategoryState = "on" | "off" | "mixed" | "none";

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
  /** The user revoked its approval; the grid offers Grant to undo that. */
  revoked: boolean;
  /** Per permission group, for the grid's permission menu. null = no approval (or revoked). */
  permissions: Record<PermissionCategory, { state: CategoryState; count: number }> | null;
  size: { w: number; h: number };
}

/** The New card (CARDS.md 1): the generator pipeline's state and the CLI gate's. */
export interface GeneratorView {
  phase: "idle" | "checking" | "writing" | "validating" | "approval" | "installing" | "done" | "failed" | "stopped";
  message?: string;
  progress?: string;
  errors?: string;
  /** Theme warnings for a card that passed (generator rule 10): fixed colours or pixel font sizes. */
  warnings?: string;
  cardId?: string;
  attempt?: number;
  gate?: { ok: boolean; code?: string; reason?: string; version?: string };
  /** The CLI build in use, "<version>-<sha12>", if any. */
  build?: string;
  testing: boolean;
  canTest: boolean;
  targets: Array<{ cardId: string; name: string }>;
  /** An open LASS investigation of new-card requests (LASS.md 5): the New card refuses new cards until it ends. */
  lass?: { id: string; state: string; summary?: string } | null;
  /** A finished investigation of new-card requests: its answer and the steps only the user can do (LASS.md 5, 7). */
  lassNotice?: { id: string; summary: string; userSteps: string[] } | null;
}

/** The LASS bar at the bottom of the window (LASS.md 7). */
export interface LassBarView {
  asking: { id: string; title: string; summary?: string } | null;
  notice: { id: string; summary: string; userSteps: string[]; closeReason: string; function: string } | null;
}

export interface NewCardRequest { text: string; target: string; preset: "watch-feed" | null }

export interface DashboardState {
  frames: CardFrame[];
  summary: string;
  generator: GeneratorView;
  lass?: LassBarView;
}

/**
 * The frame body rectangle of a running card, in window content coordinates (CSS px), and `clip`: the
 * grid's visible area. The host shows the part of the body inside the clip; `visible` is false when none
 * of it is (or while dragging/resizing).
 */
export interface FrameRect {
  cardId: string; x: number; y: number; width: number; height: number;
  clip: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface LayoutUpdate { order: string[]; sizes: Record<string, { w: number; h: number }> }

export type CardAction = "stop" | "start" | "revoke" | "grant";

export interface PermissionLineView {
  text: string; reason: string; marks: Array<{ level: "red" | "yellow"; tag: string; why: string }>;
  category: PermissionCategory;
  /** Switched on (the broker allows it) or off by the user. */
  on: boolean;
}

export interface OptionsState {
  general: { startWithWindows: boolean; closeToTray: boolean; packaged: boolean; theme: string; themeMode: "system" | "light" | "dark" };
  /** Built-in themes for the picker (THEMES.md): which of light/dark each one has. */
  themes: Array<{ id: string; name: string; light: boolean; dark: boolean; font: string }>;
  feeds: Array<{ taskId: string; name: string; schedule: "daily" | "weekdays" | "none"; graceHours: number; keep: number; folder: string; state: string }>;
  cards: Array<{
    cardId: string; name: string; state: string; message?: string; running: boolean; revoked: boolean;
    versionHash: string | null; approvedAt: string | null; permissions: PermissionLineView[];
  }>;
  generator: { ok: boolean; version?: string; reason?: string };
  security: Array<{ at: string; cardId: string; kind: string; detail: string }>;
}

export type OptionsPatch =
  | { general: { startWithWindows?: boolean; closeToTray?: boolean; theme?: string; themeMode?: "system" | "light" | "dark" } }
  | { feed: { taskId: string; schedule?: "daily" | "weekdays" | "none"; graceHours?: number; keep?: number } };
