/**
 * Scheduled-task reports, schemaVersion 0 (spec/report.schema.json, PRESETS.md "Report file schema v0").
 * Report content is untrusted: it summarizes web pages and messages. The host only validates and
 * passes it on as data; nothing ever acts on it (severity only picks a colour).
 */

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
  body: string;
  sources: Array<{ title: string; url: string }>;
}

export const TASK_ID_RE = /^trig_[A-Za-z0-9]{10,64}$/;
export const REPORT_FILE_RE = /^(\d{8}T\d{6}Z)\.json$/;
export const MAX_REPORT_BYTES = 1024 * 1024;
const SEVERITIES = new Set(["none", "low", "medium", "high", "critical"]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export type ReportResult = { ok: true; report: Report } | { ok: false; reason: string };

/** Validates one parsed report file for the task whose folder it came from. Unknown extra fields are dropped. */
export function validateReport(data: unknown, folderTaskId: string): ReportResult {
  const bad = (reason: string): ReportResult => ({ ok: false, reason });
  if (typeof data !== "object" || data === null || Array.isArray(data)) return bad("the file is not a JSON object");
  const o = data as Record<string, unknown>;
  const str = (k: string, min: number, max: number) => typeof o[k] === "string" && (o[k] as string).length >= min && (o[k] as string).length <= max;
  if (o.schemaVersion !== 0) return bad("schemaVersion must be 0");
  if (typeof o.taskId !== "string" || !TASK_ID_RE.test(o.taskId)) return bad("taskId is missing or malformed");
  if (o.taskId !== folderTaskId) return bad(`taskId ${o.taskId} does not match its folder (${folderTaskId})`);
  if (!str("taskName", 1, 200)) return bad("taskName must be 1-200 characters");
  for (const k of ["runStartedAt", "runFinishedAt"]) {
    if (typeof o[k] !== "string" || !ISO_RE.test(o[k] as string) || Number.isNaN(Date.parse(o[k] as string))) return bad(`${k} must be an ISO-8601 date-time`);
  }
  if (o.status !== "ok" && o.status !== "failed") return bad("status must be ok or failed");
  if (typeof o.severity !== "string" || !SEVERITIES.has(o.severity)) return bad("severity is missing or not one of none, low, medium, high, critical");
  if (!str("bottomLine", 1, 1000)) return bad("bottomLine must be 1-1000 characters");
  if (!str("body", 0, 200000)) return bad("body must be a string of at most 200000 characters");
  if (!Array.isArray(o.sources) || o.sources.length > 200) return bad("sources must be an array of at most 200 items");
  const sources: Report["sources"] = [];
  for (const s of o.sources) {
    const x = s as Record<string, unknown>;
    if (typeof x !== "object" || x === null || typeof x.title !== "string" || x.title.length > 300 || typeof x.url !== "string" || x.url.length > 2000 || !/^https?:\/\//.test(x.url)) {
      return bad("every source needs a title (max 300) and an http(s) url (max 2000)");
    }
    sources.push({ title: x.title, url: x.url });
  }
  return {
    ok: true,
    report: {
      schemaVersion: 0, taskId: o.taskId, taskName: o.taskName as string,
      runStartedAt: o.runStartedAt as string, runFinishedAt: o.runFinishedAt as string,
      status: o.status, severity: o.severity as Severity, bottomLine: o.bottomLine as string,
      body: o.body as string, sources,
    },
  };
}

/** "20261009T061500Z.json" -> epoch ms, or NaN. */
export function fileTime(name: string): number {
  const m = REPORT_FILE_RE.exec(name);
  if (!m) return NaN;
  const t = m[1];
  return Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15));
}
