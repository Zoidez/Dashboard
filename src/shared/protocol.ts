/**
 * Card <-> broker wire protocol over the card's MessagePort (ARCHITECTURE.md, "The wrapper" 3).
 *   card -> host  { t: "call", id, m, a }      exactly these keys; anything else is rejected
 *   host -> card  { t: "ret", id, ok: true, v } | { t: "ret", id, ok: false, e: { code, message } }
 *   host -> card  { t: "evt", ch, v }          subscriptions (config changes, watches)
 * There is no card id in any message: the host knows the caller from the port.
 */

export type ErrorCode =
  | "PermissionDenied" | "NotFound" | "Timeout" | "TooLarge" | "InvalidArgument"
  | "Reserved" | "IOError" | "NetworkError";

export interface CallMsg { t: "call"; id: number; m: string; a: unknown[] }
export type RetMsg =
  | { t: "ret"; id: number; ok: true; v: unknown }
  | { t: "ret"; id: number; ok: false; e: { code: ErrorCode; message: string } };
export interface EvtMsg { t: "evt"; ch: string; v: unknown }

export const MAX_MESSAGE_BYTES = 11 * 1024 * 1024;   // 10 MB payload limit + envelope
const MAX_DEPTH = 8;
const MAX_ARGS = 16;
const MAX_KEYS = 256;

/** Methods the broker implements in apiVersion 0. */
export const METHODS: ReadonlySet<string> = new Set([
  "card.config", "card.tickDone",
  "ui.setStatus", "ui.notify", "ui.setAccent", "ui.openLink", "ui.confirm",
  "storage.get", "storage.set", "storage.remove",
  "sysinfo.cpu", "sysinfo.memory", "sysinfo.disks", "sysinfo.network", "sysinfo.os",
  "sysinfo.battery", "sysinfo.gpus", "sysinfo.processes",
  "net.request",
  "fs.readText", "fs.readBytes", "fs.list", "fs.stat", "fs.writeText", "fs.writeBytes",
  "fs.appendText", "fs.mkdir", "fs.remove", "fs.watch", "fs.unwatch",
  "reports.state", "reports.history", "reports.watch", "reports.unwatch",
]);

/** Reserved namespaces: always refused with "Reserved" (host invariant 11). ffi is not reserved: it does not exist. */
export const RESERVED_RE = /^(process|claude|bus)\.[A-Za-z]{1,40}$/;

export type Validated = { ok: true; call: CallMsg } | { ok: false; reason: string; id?: number };

function isPlainObject(v: object): boolean {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Walks a value; returns its approximate size in bytes or throws on anything not plain data. */
function measure(v: unknown, depth: number, budget: { keys: number }): number {
  if (v === undefined || v === null || typeof v === "boolean") return 4;
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error("non-finite number"); return 8; }
  if (typeof v === "string") return v.length * 2;
  if (typeof v !== "object") throw new Error(`unsupported value type ${typeof v}`);
  if (depth > MAX_DEPTH) throw new Error("value nested too deeply");
  if (v instanceof Uint8Array) return v.byteLength;
  if (Array.isArray(v)) {
    let n = 0;
    for (const x of v) n += measure(x, depth + 1, budget);
    return n + 8;
  }
  if (!isPlainObject(v)) throw new Error("only plain objects are accepted");
  let n = 0;
  for (const k of Object.keys(v)) {
    if (++budget.keys > MAX_KEYS * 64) throw new Error("too many keys");
    n += k.length * 2 + measure((v as Record<string, unknown>)[k], depth + 1, budget);
  }
  return n + 8;
}

export function validateCall(data: unknown): Validated {
  if (typeof data !== "object" || data === null || Array.isArray(data) || !isPlainObject(data)) return { ok: false, reason: "message is not an object" };
  const o = data as Record<string, unknown>;
  const id = typeof o.id === "number" && Number.isInteger(o.id) && o.id >= 0 && o.id < 2 ** 31 ? o.id : undefined;
  const keys = Object.keys(o);
  const extra = keys.filter((k) => k !== "t" && k !== "id" && k !== "m" && k !== "a");
  if (extra.length) return { ok: false, reason: `unknown field(s): ${extra.slice(0, 4).join(", ")}`, id };
  if (o.t !== "call") return { ok: false, reason: "t must be \"call\"", id };
  if (id === undefined) return { ok: false, reason: "id must be an integer from 0 to 2^31-1" };
  if (typeof o.m !== "string" || o.m.length > 64) return { ok: false, reason: "m must be a method name", id };
  if (!Array.isArray(o.a) || o.a.length > MAX_ARGS) return { ok: false, reason: `a must be an array of at most ${MAX_ARGS} values`, id };
  let size: number;
  try { size = measure(o.a, 1, { keys: 0 }); } catch (e) { return { ok: false, reason: (e as Error).message, id }; }
  if (size > MAX_MESSAGE_BYTES) return { ok: false, reason: "message too large", id };
  return { ok: true, call: { t: "call", id, m: o.m, a: o.a } };
}
