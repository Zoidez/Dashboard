/**
 * The native file helper process (ARCHITECTURE.md, "Process model"): an Electron utility process
 * owned by the host. It performs card file operations with the file check protocol and nothing
 * else. Only the main process talks to it; cards never see it.
 *
 * main -> helper  { id, op, args, ctx }       ctx = { instanceRoot, scope: { path, recursive } }
 * helper -> main  { id, ok: true, v } | { id, ok: false, code, check, message }
 * helper -> main  { watch: id, ev }           watch events (names only)
 */
import * as ops from "./fs-ops.js";
import { FileCheckError, type CheckContext } from "./file-checks.js";

interface Req { id: number; op: string; args: unknown[]; ctx: CheckContext }

const port = (process as unknown as { parentPort: { on(ev: "message", cb: (e: { data: Req }) => void): void; postMessage(m: unknown): void } }).parentPort;
const watches = new Map<number, () => void>();

function run(r: Req): unknown {
  const [a0, a1] = r.args;
  switch (r.op) {
    case "readText": return ops.readText(a0, r.ctx);
    case "readBytes": return ops.readBytes(a0, r.ctx);
    case "stat": return ops.stat(a0, r.ctx);
    case "list": return ops.list(a0, r.ctx);
    case "writeText": ops.writeText(a0, a1, r.ctx); return null;
    case "writeBytes": ops.writeBytes(a0, a1, r.ctx); return null;
    case "appendText": ops.appendText(a0, a1, r.ctx); return null;
    case "mkdir": ops.mkdir(a0, r.ctx); return null;
    case "watch": {
      const stop = ops.watch(a0, r.ctx, (ev) => port.postMessage({ watch: r.id, ev }));
      watches.set(r.id, stop);
      return r.id;
    }
    case "unwatch": {
      const w = watches.get(Number(a0));
      if (w) { w(); watches.delete(Number(a0)); }
      return null;
    }
    default: throw new FileCheckError("InvalidArgument", "syntax", `unknown file operation ${r.op}`);
  }
}

port.on("message", (e) => {
  const r = e.data;
  try {
    port.postMessage({ id: r.id, ok: true, v: run(r) });
  } catch (err) {
    if (err instanceof FileCheckError) port.postMessage({ id: r.id, ok: false, code: err.code, check: err.check, message: err.message });
    else port.postMessage({ id: r.id, ok: false, code: "IOError", check: "helper", message: (err as Error).message ?? String(err) });
  }
});
