/**
 * Dashboard host API, apiVersion 0.
 *
 * This is the ONLY interface a card may use. Card code never has Node.js. Each card runs in its own
 * sandboxed view (its own renderer process and origin, card://<card-id>/): ui.js in the view's page,
 * worker.js (optional) as a Web Worker inside the same view. Every call below is a message over the
 * card's own port to the host's broker, which performs the operation itself after checking it.
 * Every call is checked by the capability broker against the permissions the user approved
 * (manifest.json -> permissions). A call outside them throws PermissionDenied and is logged.
 * Grants are lazy: a capability is granted on the card's first request for it and withdrawn when
 * the card shuts down for any reason (RULES.md, host invariant 4).
 *
 * Card code has no direct network: fetch, XHR, WebSocket, sendBeacon and resource loads are blocked
 * by the host. Network access exists only through api.net.request.
 * The host identifies the calling card by its channel; any card id inside a message is ignored.
 *
 * All calls are async. All paths are absolute Windows paths or instance-relative ("./...").
 */

export type ApiVersion = 0;

// ---------- errors ----------

export type ErrorCode =
  | "PermissionDenied"   // not covered by an approved permission
  | "NotFound"
  | "Timeout"            // host timeout hit (see each call)
  | "TooLarge"           // over a size limit
  | "InvalidArgument"
  | "Reserved"           // reserved feature, disabled in apiVersion 0 (api.claude, api.bus, api.process)
  | "IOError"
  | "NetworkError";

export interface HostError extends Error {
  code: ErrorCode;
}

// ---------- files: fs.read / fs.write / fs.delete ----------

export interface FileStat {
  path: string;
  isDirectory: boolean;
  size: number;          // bytes
  modifiedAt: string;    // ISO-8601
}

export interface FsApi {
  /** Needs fs.read covering the path. Max 10 MB per call. Every fs call passes the file check protocol
   *  (ARCHITECTURE.md 4a): plain drive paths only, no links, and the file must really be the type its extension says. */
  readText(path: string): Promise<string>;
  /** Needs fs.read. Max 10 MB per call. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Needs fs.read on the directory. Non-recursive. */
  list(dir: string): Promise<FileStat[]>;
  /** Needs fs.read. */
  stat(path: string): Promise<FileStat>;
  /** Needs fs.write covering the path. Creates or overwrites. Max 10 MB. */
  writeText(path: string, text: string): Promise<void>;
  /** Needs fs.write. Max 10 MB. */
  writeBytes(path: string, data: Uint8Array): Promise<void>;
  /** Needs fs.write. Appends; creates the file if missing. */
  appendText(path: string, text: string): Promise<void>;
  /** Needs fs.write on the parent directory. */
  mkdir(dir: string): Promise<void>;
  /** Needs fs.delete covering the path. Files only, of a known type. Moves to the Windows Recycle Bin; never a permanent delete
   *  (if Windows cannot recycle the file, it asks the user).
   *  Rename, copy and recursive operations are not available in apiVersion 0. */
  remove(path: string): Promise<void>;
  /** Needs fs.read on the directory. Calls back on changes until the returned function is called. */
  watch(dir: string, onChange: (event: "add" | "change" | "unlink", path: string) => void): Promise<() => void>;
}

// ---------- network: net.http ----------

export interface HttpRequest {
  url: string;                          // must match an approved origin + pathPrefix
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"; // must be approved; default GET
  headers?: Record<string, string>;     // cookies are never sent; the host keeps no cookie jar
  body?: string | Uint8Array;
  timeoutMs?: number;                   // default 15000, max 60000
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Body as text. Max 10 MB; larger responses throw TooLarge. */
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  bytes(): Promise<Uint8Array>;
}

export interface NetApi {
  /** Needs net.http for the URL's origin, path prefix and method. Redirects are followed only within approved origins. */
  request(req: HttpRequest): Promise<HttpResponse>;
}

// ---------- processes: RESERVED in apiVersion 0 ----------
// Running or launching executables (incl. console interaction) is removed from v1 by user decision
// (2026-10-08). The name stays reserved so a later apiVersion can add it without breaking cards.
// In apiVersion 0, api.process throws Reserved and the validator rejects the process.run and
// process.launch permissions.
//
// DLL calls: removed from cards permanently (user decision 2026-10-09). There is no api.ffi and
// no ffi.call permission. Only the host itself calls Windows functions (its file helper).

// ---------- system info: sysinfo ----------

export interface SysinfoApi {
  /** Needs sysinfo with "cpu". */
  cpu(): Promise<{ model: string; cores: number; loadPercent: number; temperatureC?: number }>;
  /** Needs "memory". */
  memory(): Promise<{ totalBytes: number; usedBytes: number; freeBytes: number }>;
  /** Needs "disk". */
  disks(): Promise<Array<{ mount: string; totalBytes: number; usedBytes: number }>>;
  /** Needs "network". */
  network(): Promise<Array<{ iface: string; rxBytesPerSec: number; txBytesPerSec: number }>>;
  /** Needs "os". */
  os(): Promise<{ platform: string; release: string; hostname: string; uptimeSeconds: number }>;
  /** Needs "battery". */
  battery(): Promise<{ present: boolean; percent?: number; charging?: boolean }>;
  /** Needs "gpu". */
  gpus(): Promise<Array<{ model: string; loadPercent?: number; memoryUsedBytes?: number }>>;
  /** Needs "processes". Names and resource use only; no command lines. */
  processes(): Promise<Array<{ pid: number; name: string; cpuPercent: number; memoryBytes: number }>>;
}

// ---------- scheduled-task reports: reports.read ----------

export type Severity = "none" | "low" | "medium" | "high" | "critical";

export interface Report {
  schemaVersion: 0;
  taskId: string;
  taskName: string;
  runStartedAt: string;
  runFinishedAt: string;
  status: "ok" | "failed";
  severity: Severity;
  bottomLine: string;
  body: string;            // Markdown; untrusted. Render with api.ui.markdown() only.
  sources: Array<{ title: string; url: string }>;
}

export interface FeedState {
  /** Latest valid report, or null if none has ever arrived. */
  latest: Report | null;
  /** Set when the feed is offline (PRESETS.md display rule 2). */
  offline: null | { reason: "invalid-file" | "run-failed" | "overdue"; detail: string; since: string };
}

export interface ReportsApi {
  /** Needs reports.read for the task. Validation and "offline" detection are done by the host. */
  state(taskId: string): Promise<FeedState>;
  /** Needs reports.read. Newest first, max 30. */
  history(taskId: string, limit?: number): Promise<Report[]>;
  /** Needs reports.read. Called whenever the state changes. */
  onChange(taskId: string, cb: (state: FeedState) => void): () => void;
}

// ---------- per-card storage (no permission needed) ----------

export interface StorageApi {
  /** The card's own key-value store under data/config/<card-id>/storage.json. Max 1 MB total. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------- UI helpers (ui.js only, no permission needed) ----------

export interface UiApi {
  /** Sanitized Markdown -> DOM fragment. No raw HTML, no scripts, no remote images; links open externally. */
  markdown(src: string): DocumentFragment;
  /** Opens an https:// URL in the user's default browser, after the user clicks a link. Needs links.open covering the
   *  URL's origin (or links.open with any: true). Rate-limited by the host. */
  openLink(url: string): Promise<void>;
  /** Host confirmation dialog. Required before destructive actions (generator rule 4). */
  confirm(message: string, opts?: { danger?: boolean; confirmLabel?: string }): Promise<boolean>;
  /** Small notification in the card's status line. */
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** Card status shown by the host frame (generator rule 7). */
  setStatus(status: { state: "loading" | "ok" | "stale" | "error"; message?: string; updatedAt?: string }): void;
  /** The card's severity (e.g. a watch feed's latest report). The host frame shows it in the way the user's theme
   *  chooses (outline, title bar, background, ...); the card never draws severity itself (generator rule 10). */
  setAccent(accent: "neutral" | Severity): void;
  /** The current theme. Prefer the CSS variables on the card page's :root, which follow theme changes by themselves:
   *  --bg (card background), --fg (text), --muted, --border, --accent / --link, --ok, --warn, --err,
   *  --sev-low / --sev-medium / --sev-high / --sev-critical, --font-family, --font-size, --line-height.
   *  Use these variables and relative font sizes (em/rem) instead of fixed colours and pixel sizes. */
  theme(): ThemeInfo;
  /** Called after the user changes the theme (or Windows switches light/dark). Returns an unsubscribe function. */
  onThemeChange(cb: (theme: ThemeInfo) => void): () => void;
}

export interface ThemeInfo {
  mode: "light" | "dark";
  /** Built-in theme id, e.g. "dashboard", "nord". */
  id: string;
  /** Colours as #rrggbb. background = the card's own background. */
  colors: {
    background: string; page: string; text: string; muted: string; border: string; accent: string;
    ok: string; warning: string; error: string; low: string; medium: string; high: string; critical: string;
  };
  font: { family: string; size: number; lineHeight: number };
}

// ---------- worker <-> ui messaging (no permission needed) ----------

export interface MessagingApi {
  /** ui.js -> its own worker.js, or worker.js -> its own ui.js. Never to other cards. */
  send(message: unknown): void;
  onMessage(cb: (message: unknown) => void): () => void;
}

// ---------- reserved in apiVersion 0 ----------

export interface ReservedApi {
  /** Always throws Reserved in apiVersion 0. */
  [method: string]: (...args: unknown[]) => Promise<never>;
}

// ---------- the object cards receive ----------

export interface CardContext {
  cardId: string;
  apiVersion: ApiVersion;
  /** Current values of the card's configSchema fields. */
  config: Record<string, string | number | boolean>;
  onConfigChange(cb: (config: Record<string, string | number | boolean>) => void): () => void;
}

export interface HostApi {
  card: CardContext;
  fs: FsApi;
  net: NetApi;
  process: ReservedApi;   // reserved in apiVersion 0
  sysinfo: SysinfoApi;
  reports: ReportsApi;
  storage: StorageApi;
  ui: UiApi;              // ui.js only (not available in worker.js)
  messaging: MessagingApi;
  bus: ReservedApi;       // inter-card bus, reserved
  claude: ReservedApi;    // card -> Claude, reserved
}

// ---------- what a card exports ----------

/** ui.js */
export interface CardUiModule {
  mount(el: HTMLElement, api: HostApi): void | Promise<void>;
  unmount?(): void | Promise<void>;
}

/** worker.js (optional) */
export interface CardWorkerModule {
  start?(api: HostApi): void | Promise<void>;
  /** Called every manifest.schedule.intervalSeconds. Must finish within 60 s. */
  tick?(api: HostApi): void | Promise<void>;
  stop?(): void | Promise<void>;
}
