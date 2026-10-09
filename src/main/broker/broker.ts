/**
 * The capability broker (ARCHITECTURE.md, "The wrapper"; RULES.md, host invariants 4, 7, 11, 12).
 *
 * - Identity comes from the session the port belongs to. Nothing in a message names the caller.
 * - Every message is validated strictly (shared/protocol.ts) before any permission check.
 * - Lazy grants: a session starts with an empty grant table. A capability is granted when the
 *   running card first asks for it, after re-checking the current approval (version hash, scope,
 *   not revoked). The approval is re-checked on every call, not only the first.
 * - Ending a session (Stop, Revoke, crash, reload, update, view closed, app quit) drops the table
 *   and closes everything opened under it: in-flight requests, watches, timers, the port.
 *
 * Electron-free on purpose, so the unit tests drive it directly.
 */
import { randomUUID } from "node:crypto";
import type { AuditLog } from "../audit.js";
import type { ApprovalStore, ApprovalRecord } from "../cards/approvals.js";
import { isInsideInstance } from "../instance.js";
import { METHODS, RESERVED_RE, validateCall, type ErrorCode, type RetMsg, type EvtMsg } from "../../shared/protocol.js";
import { brokerRequest, NetError, type NetDeps } from "./net.js";
import { findCovering, type CapabilityRequest, type Permission, type SysinfoField } from "./permissions.js";

export class HostError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

export interface PortLike {
  postMessage(msg: RetMsg | EvtMsg): void;
  close(): void;
}

export interface Closeable { close(): void }

export interface Grant { permission: Permission; grantedAt: string }

export class CardSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly grants = new Map<number, Grant>();
  readonly resources = new Set<Closeable>();
  readonly inflight = new Set<AbortController>();
  ended = false;
  endReason = "";
  denials = 0;
  private tokens: number;
  private last = Date.now();

  constructor(readonly cardId: string, readonly versionHash: string, readonly port: PortLike, private readonly rate: { perSecond: number; burst: number }) {
    this.tokens = rate.burst;
  }

  /** Token bucket. false = over the rate limit. */
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate.burst, this.tokens + ((now - this.last) / 1000) * this.rate.perSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface HostServices {
  config(cardId: string): Record<string, string | number | boolean>;
  sysinfo(field: SysinfoField, method: string): Promise<unknown>;
  ui: {
    setStatus(cardId: string, status: unknown): void;
    notify(cardId: string, message: string, level: string): void;
    setAccent(cardId: string, accent: string): void;
    openLink(cardId: string, url: URL): Promise<void>;
    confirm(cardId: string, message: string, opts: { danger?: boolean; confirmLabel?: string }): Promise<boolean>;
  };
  storage: {
    get(cardId: string, key: string): Promise<unknown>;
    set(cardId: string, key: string, value: unknown): Promise<void>;
    remove(cardId: string, key: string): Promise<void>;
  };
  /** The broker asks the host to stop a card (repeated denials, rate abuse, revoked approval). */
  stopCard(cardId: string, reason: string): void;
}

export interface BrokerOptions {
  instanceRoot: string;
  /** Resolves instance-relative "./" paths to absolute ones. */
  resolvePath: (p: string) => string;
  net?: Omit<NetDeps, "signal" | "onHop">;
  rate?: { perSecond: number; burst: number };
  /** Denials in one session before the card is flagged and stopped. */
  maxDenials?: number;
}

const SYSINFO_METHODS: Record<string, SysinfoField> = {
  "sysinfo.cpu": "cpu", "sysinfo.memory": "memory", "sysinfo.disks": "disk", "sysinfo.network": "network",
  "sysinfo.os": "os", "sysinfo.battery": "battery", "sysinfo.gpus": "gpu", "sysinfo.processes": "processes",
};
const FS_METHOD_TYPE: Record<string, "fs.read" | "fs.write" | "fs.delete"> = {
  "fs.readText": "fs.read", "fs.readBytes": "fs.read", "fs.list": "fs.read", "fs.stat": "fs.read", "fs.watch": "fs.read",
  "fs.writeText": "fs.write", "fs.writeBytes": "fs.write", "fs.appendText": "fs.write", "fs.mkdir": "fs.write",
  "fs.remove": "fs.delete",
};
const STATUS_STATES = new Set(["loading", "ok", "stale", "error"]);
const ACCENTS = new Set(["neutral", "none", "low", "medium", "high", "critical"]);

function str(v: unknown, what: string, max = 2000): string {
  if (typeof v !== "string" || v.length > max) throw new HostError("InvalidArgument", `${what} must be a string of at most ${max} characters`);
  return v;
}

export class Broker {
  private readonly sessions = new Map<string, CardSession>();
  private readonly rate: { perSecond: number; burst: number };
  private readonly maxDenials: number;

  constructor(
    private readonly approvals: ApprovalStore,
    private readonly audit: AuditLog,
    private readonly services: HostServices,
    private readonly opts: BrokerOptions,
  ) {
    this.rate = opts.rate ?? { perSecond: 50, burst: 200 };
    this.maxDenials = opts.maxDenials ?? 20;
  }

  /** Starts a session for a card the host has just loaded. The grant table starts empty. */
  openSession(cardId: string, versionHash: string, port: PortLike): CardSession {
    const s = new CardSession(cardId, versionHash, port, this.rate);
    this.sessions.set(s.id, s);
    this.audit.write(cardId, "session-start", `session ${s.id}`);
    return s;
  }

  liveSessions(cardId?: string): CardSession[] {
    return [...this.sessions.values()].filter((s) => !cardId || s.cardId === cardId);
  }

  /** Ends a session for any reason. Idempotent. */
  endSession(s: CardSession, reason: string): void {
    if (s.ended) return;
    s.ended = true;
    s.endReason = reason;
    for (const c of s.inflight) c.abort();
    s.inflight.clear();
    for (const r of s.resources) { try { r.close(); } catch { /* already closed */ } }
    s.resources.clear();
    const dropped = s.grants.size;
    s.grants.clear();
    try { s.port.close(); } catch { /* already closed */ }
    this.sessions.delete(s.id);
    this.audit.write(s.cardId, "grant-dropped", `${dropped} grant(s) dropped`);
    this.audit.write(s.cardId, "session-end", `session ${s.id}: ${reason}`);
  }

  /** Entry point for every message that arrives on a card's port. */
  async handle(s: CardSession, data: unknown): Promise<void> {
    if (s.ended) return;
    if (!s.take()) {
      this.audit.write(s.cardId, "card-flagged", "message rate limit exceeded");
      this.services.stopCard(s.cardId, "sent messages faster than the host allows");
      return;
    }
    const v = validateCall(data);
    if (!v.ok) {
      this.audit.write(s.cardId, "invalid-message", v.reason);
      this.countDenial(s);
      if (v.id !== undefined) this.reply(s, { t: "ret", id: v.id, ok: false, e: { code: "InvalidArgument", message: `invalid message: ${v.reason}` } });
      return;
    }
    const { id, m, a } = v.call;
    try {
      if (RESERVED_RE.test(m)) {
        this.audit.write(s.cardId, "reserved-call", m);
        this.countDenial(s);
        throw new HostError("Reserved", `${m.split(".")[0]} is reserved and disabled in apiVersion 0`);
      }
      if (!METHODS.has(m)) {
        this.audit.write(s.cardId, "invalid-message", `unknown method ${m}`);
        this.countDenial(s);
        throw new HostError("InvalidArgument", `unknown method ${m}`);
      }
      const value = await this.dispatch(s, m, a);
      this.reply(s, { t: "ret", id, ok: true, v: value });
    } catch (e) {
      const he = e instanceof HostError ? e : e instanceof NetError ? new HostError(e.code, e.message) : new HostError("IOError", (e as Error).message ?? String(e));
      this.reply(s, { t: "ret", id, ok: false, e: { code: he.code, message: he.message } });
    }
  }

  /** Sends an event to the card, if its session is still alive. */
  emit(s: CardSession, ch: string, v: unknown): void {
    if (!s.ended) this.reply(s, { t: "evt", ch, v });
  }

  private reply(s: CardSession, msg: RetMsg | EvtMsg): void {
    if (s.ended) return;
    try { s.port.postMessage(msg); } catch { /* port closed under us */ }
  }

  private countDenial(s: CardSession): void {
    s.denials++;
    if (s.denials === this.maxDenials) {
      this.audit.write(s.cardId, "card-flagged", `${s.denials} denied requests in one session`);
      this.services.stopCard(s.cardId, "made too many requests it is not allowed to make");
    }
  }

  /** The current approval, re-checked on every call. Revoked or mismatched = the card stops. */
  private approval(s: CardSession): ApprovalRecord {
    const rec = this.approvals.get(s.cardId);
    if (!rec || rec.revoked) {
      this.audit.write(s.cardId, "denied", "request after the approval was revoked");
      this.services.stopCard(s.cardId, "its approval was revoked");
      throw new HostError("PermissionDenied", "the card's approval was revoked");
    }
    if (rec.versionHash !== s.versionHash) {
      this.audit.write(s.cardId, "approval-mismatch", "running version is not the approved version");
      this.services.stopCard(s.cardId, "its files do not match the approved version");
      throw new HostError("PermissionDenied", "the running card is not the approved version");
    }
    return rec;
  }

  /** Lazy grant: finds the approved permission that covers the request and records the grant. */
  private grant(s: CardSession, req: CapabilityRequest, what: string): Permission {
    const rec = this.approval(s);
    const idx = findCovering(rec.permissions, req, this.opts.resolvePath);
    if (idx < 0) {
      this.audit.write(s.cardId, "denied", what);
      this.countDenial(s);
      throw new HostError("PermissionDenied", `not allowed: ${what}`);
    }
    if (!s.grants.has(idx)) {
      s.grants.set(idx, { permission: rec.permissions[idx], grantedAt: new Date().toISOString() });
      this.audit.write(s.cardId, "grant", `${rec.permissions[idx].type} #${idx} on first use: ${what}`);
    }
    return rec.permissions[idx];
  }

  private async dispatch(s: CardSession, m: string, a: unknown[]): Promise<unknown> {
    const ui = this.services.ui;
    switch (m) {
      case "card.config": return this.services.config(s.cardId);

      case "ui.setStatus": {
        const st = a[0] as Record<string, unknown> | undefined;
        if (!st || typeof st !== "object" || !STATUS_STATES.has(st.state as string)) throw new HostError("InvalidArgument", "status.state must be loading, ok, stale or error");
        ui.setStatus(s.cardId, {
          state: st.state,
          message: st.message === undefined ? undefined : str(st.message, "status.message", 300),
          updatedAt: st.updatedAt === undefined ? undefined : str(st.updatedAt, "status.updatedAt", 40),
        });
        return null;
      }
      case "ui.notify": {
        const level = a[1] === undefined ? "info" : str(a[1], "level", 10);
        if (!["info", "warning", "error"].includes(level)) throw new HostError("InvalidArgument", "level must be info, warning or error");
        ui.notify(s.cardId, str(a[0], "message", 300), level);
        return null;
      }
      case "ui.setAccent": {
        const acc = str(a[0], "accent", 10);
        if (!ACCENTS.has(acc)) throw new HostError("InvalidArgument", "unknown accent");
        ui.setAccent(s.cardId, acc === "none" ? "neutral" : acc);
        return null;
      }
      case "ui.openLink": {
        let url: URL;
        try { url = new URL(str(a[0], "url", 2000)); } catch { throw new HostError("InvalidArgument", "not a valid URL"); }
        if (url.protocol !== "https:" || url.username || url.password) throw new HostError("InvalidArgument", "only https links without credentials can be opened");
        await ui.openLink(s.cardId, url);
        return null;
      }
      case "ui.confirm": {
        const o = (a[1] ?? {}) as Record<string, unknown>;
        return ui.confirm(s.cardId, str(a[0], "message", 1000), {
          danger: o.danger === true,
          confirmLabel: o.confirmLabel === undefined ? undefined : str(o.confirmLabel, "confirmLabel", 40),
        });
      }

      case "storage.get": return this.services.storage.get(s.cardId, str(a[0], "key", 200));
      case "storage.set": await this.services.storage.set(s.cardId, str(a[0], "key", 200), a[1]); return null;
      case "storage.remove": await this.services.storage.remove(s.cardId, str(a[0], "key", 200)); return null;

      case "net.request": {
        const raw = a[0] as { url?: unknown; method?: unknown } | undefined;
        let url: URL;
        try { url = new URL(str(raw?.url, "url", 8192)); } catch (e) { if (e instanceof HostError) throw e; throw new HostError("InvalidArgument", "url is not a valid URL"); }
        const method = typeof raw?.method === "string" ? raw.method : "GET";
        // First hop: lazy grant. Redirect hops: brokerRequest checks each one against the same approval.
        this.grant(s, { type: "net.http", url, method: method as never }, `${method} ${url.origin}${url.pathname}`);
        const ctl = new AbortController();
        s.inflight.add(ctl);
        try {
          return await brokerRequest(raw, this.approval(s).permissions, {
            ...this.opts.net,
            signal: ctl.signal,
            onHop: (h) => this.audit.write(s.cardId, "net", `${h.method} ${h.url} -> ${h.address}`),
          });
        } catch (e) {
          if (e instanceof NetError && e.code === "PermissionDenied") { this.audit.write(s.cardId, "denied", e.message); this.countDenial(s); }
          throw e;
        } finally {
          s.inflight.delete(ctl);
        }
      }
    }

    const field = SYSINFO_METHODS[m];
    if (field) {
      this.grant(s, { type: "sysinfo", field }, `system info: ${field}`);
      return this.services.sysinfo(field, m);
    }

    const fsType = FS_METHOD_TYPE[m];
    if (fsType) {
      const path = this.opts.resolvePath(str(a[0], "path", 260));
      if (isInsideInstance(this.opts.instanceRoot, path)) {
        this.audit.write(s.cardId, "denied", `${m} inside the Dashboard's instance folder: ${path}`);
        this.countDenial(s);
        throw new HostError("PermissionDenied", "cards can never access the Dashboard's own folder");
      }
      this.grant(s, { type: fsType, path }, `${fsType} ${path}`);
      throw new HostError("IOError", "file access is not available in this build yet (the native file helper is not built)");
    }

    if (m.startsWith("reports.")) {
      const taskId = str(a[0], "taskId", 80);
      this.grant(s, { type: "reports.read", taskId }, `reports of ${taskId}`);
      throw new HostError("IOError", "reports are not available in this build yet");
    }

    if (m === "fs.unwatch") throw new HostError("NotFound", "no such watch");
    throw new HostError("InvalidArgument", `unknown method ${m}`);
  }
}
