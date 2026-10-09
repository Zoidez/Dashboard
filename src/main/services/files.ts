/**
 * Main-process client of the native file helper (src/filehelper/main.ts). Starts the helper on
 * first use and again after a crash; a crash fails the calls in flight, never hangs them.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import type { CheckContext } from "../../filehelper/file-checks.js";

export class FileError extends Error {
  constructor(readonly code: string, readonly check: string, message: string) { super(message); }
}

type Reply = { id: number; ok: true; v: unknown } | { id: number; ok: false; code: string; check: string; message: string };
type WatchEv = { watch: number; ev: unknown };

export class FileHelper {
  private proc: UtilityProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly watchers = new Map<number, (ev: unknown) => void>();

  constructor(private readonly entry: string, private readonly timeoutMs = 30_000) {}

  private ensure(): UtilityProcess {
    if (this.proc) return this.proc;
    const p = utilityProcess.fork(this.entry, [], { serviceName: "Dashboard file helper", stdio: "ignore" });
    p.on("message", (m: Reply | WatchEv) => {
      if ("watch" in m) { this.watchers.get(m.watch)?.(m.ev); return; }
      const w = this.pending.get(m.id);
      if (!w) return;
      this.pending.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.resolve(m.v); else w.reject(new FileError(m.code, m.check, m.message));
    });
    p.on("exit", () => {
      if (this.proc === p) this.proc = null;
      for (const [id, w] of this.pending) { clearTimeout(w.timer); w.reject(new FileError("IOError", "helper", "the file helper stopped")); this.pending.delete(id); }
      for (const cb of this.watchers.values()) cb({ error: "watch ended: the file helper stopped" });
      this.watchers.clear();
    });
    this.proc = p;
    return p;
  }

  call(op: string, args: unknown[], ctx: CheckContext): Promise<unknown> {
    const p = this.ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new FileError("Timeout", "helper", `file operation took longer than ${this.timeoutMs / 1000} s`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      p.postMessage({ id, op, args, ctx });
    });
  }

  /** Starts a watch; returns a function that ends it. */
  async watch(path: string, ctx: CheckContext, onEvent: (ev: unknown) => void): Promise<() => void> {
    const id = (await this.call("watch", [path], ctx)) as number;
    this.watchers.set(id, onEvent);
    return () => {
      if (!this.watchers.delete(id)) return;
      if (this.proc) void this.call("unwatch", [id], ctx).catch(() => undefined);
    };
  }

  /** OS process id of the helper, or null if it is not running. */
  get pid(): number | null { return this.proc?.pid ?? null; }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
