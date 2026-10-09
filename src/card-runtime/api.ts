/**
 * Builds the card `api` object (spec/host-api.d.ts) on top of a call channel. Shared by the page
 * runtime (ui.js) and the worker runtime (worker.js); neither holds any privilege.
 */
import type { HostApi, HostError as HostErrorT, ErrorCode } from "../../spec/host-api.js";

export interface Channel {
  call(m: string, ...a: unknown[]): Promise<any>;
  /** Event listeners by channel name ("reports:<task>", "fs.watch:<id>", "card:tick"). */
  listeners: Map<string, Set<(v: unknown) => void>>;
}

export function hostError(code: ErrorCode, message: string): HostErrorT {
  const e = new Error(message) as HostErrorT;
  e.name = "HostError";
  (e as { code: ErrorCode }).code = code;
  return e;
}

export function buildApi(ch: Channel, o: { cardId: string; config: Record<string, string | number | boolean>; ui?: HostApi["ui"]; messaging: HostApi["messaging"] }): HostApi {
  const { call, listeners } = ch;
  const fire = (m: string, ...a: unknown[]): void => { call(m, ...a).catch(() => undefined); };
  const reserved = (ns: string) => new Proxy(Object.freeze({}), {
    get: (_t, k) => (typeof k === "string" ? (..._args: unknown[]) => call(`${ns}.${k}`) : undefined),
  });
  const listen = (name: string, fn: (v: unknown) => void) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
  };

  const api: HostApi = {
    card: {
      cardId: o.cardId,
      apiVersion: 0,
      config: Object.freeze({ ...o.config }),
      onConfigChange: () => () => undefined,   // the settings panel comes with the grid UI
    },
    fs: {
      readText: (p) => call("fs.readText", p),
      readBytes: (p) => call("fs.readBytes", p),
      list: (d) => call("fs.list", d),
      stat: (p) => call("fs.stat", p),
      writeText: (p, t) => call("fs.writeText", p, t),
      writeBytes: (p, d) => call("fs.writeBytes", p, d),
      appendText: (p, t) => call("fs.appendText", p, t),
      mkdir: (d) => call("fs.mkdir", d),
      remove: (p) => call("fs.remove", p),
      watch: async (d, onChange) => {
        const id = (await call("fs.watch", d)) as number;
        const name = `fs.watch:${id}`;
        listen(name, (v) => { const e = v as { event?: "add" | "change" | "unlink"; path?: string }; if (e?.event && e.path) onChange(e.event, e.path); });
        return () => { listeners.delete(name); fire("fs.unwatch", id); };
      },
    },
    net: {
      request: async (req) => {
        const r = (await call("net.request", { ...req })) as { status: number; headers: Record<string, string>; body: Uint8Array };
        const bytes = r.body;
        return Object.freeze({
          status: r.status,
          headers: Object.freeze({ ...r.headers }),
          text: async () => new TextDecoder().decode(bytes),
          json: async <T>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
          bytes: async () => bytes.slice(),
        });
      },
    },
    process: reserved("process") as HostApi["process"],
    sysinfo: {
      cpu: () => call("sysinfo.cpu"),
      memory: () => call("sysinfo.memory"),
      disks: () => call("sysinfo.disks"),
      network: () => call("sysinfo.network"),
      os: () => call("sysinfo.os"),
      battery: () => call("sysinfo.battery"),
      gpus: () => call("sysinfo.gpus"),
      processes: () => call("sysinfo.processes"),
    },
    reports: {
      state: (t) => call("reports.state", t),
      history: (t, n) => call("reports.history", t, n),
      onChange: (t, cb) => {
        const name = `reports:${t}`;
        const first = !listeners.has(name);
        const fn = (v: unknown) => cb(v as never);
        listen(name, fn);
        if (first) fire("reports.watch", t);
        return () => { const set = listeners.get(name); set?.delete(fn); if (set && set.size === 0) { listeners.delete(name); fire("reports.unwatch", t); } };
      },
    },
    storage: {
      get: (k) => call("storage.get", k),
      set: (k, v) => call("storage.set", k, v),
      remove: (k) => call("storage.remove", k),
    },
    ui: o.ui as HostApi["ui"],                     // absent in worker.js (ui.js only)
    messaging: o.messaging,
    bus: reserved("bus") as HostApi["bus"],
    claude: reserved("claude") as HostApi["claude"],
  };
  if (!o.ui) delete (api as Partial<HostApi>).ui;
  for (const v of Object.values(api)) if (v && typeof v === "object") Object.freeze(v);
  return Object.freeze(api);
}
