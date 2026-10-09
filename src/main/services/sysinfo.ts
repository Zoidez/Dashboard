/**
 * System information for api.sysinfo. The broker has already checked the permission.
 * This build covers cpu, memory and os from Node's os module; the other fields come with
 * `systeminformation` (ARCHITECTURE.md, Stack) and report "not available" until then.
 */
import os from "node:os";
import { HostError } from "../broker/broker.js";
import type { SysinfoField } from "../broker/permissions.js";

type Times = { idle: number; total: number };
let lastSample: { at: number; t: Times } | null = null;

function cpuTimes(): Times {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle;
  }
  return { idle, total };
}

async function loadPercent(): Promise<number> {
  let prev = lastSample;
  if (!prev || Date.now() - prev.at > 60_000) {
    prev = { at: Date.now(), t: cpuTimes() };
    await new Promise((r) => setTimeout(r, 250));
  }
  const now = cpuTimes();
  lastSample = { at: Date.now(), t: now };
  const dt = now.total - prev.t.total, di = now.idle - prev.t.idle;
  return dt > 0 ? Math.round(1000 * (1 - di / dt)) / 10 : 0;
}

export async function sysinfo(field: SysinfoField): Promise<unknown> {
  switch (field) {
    case "cpu": {
      const cpus = os.cpus();
      return { model: cpus[0]?.model?.trim() ?? "unknown", cores: cpus.length, loadPercent: await loadPercent() };
    }
    case "memory": {
      const total = os.totalmem(), free = os.freemem();
      return { totalBytes: total, usedBytes: total - free, freeBytes: free };
    }
    case "os":
      return { platform: os.platform(), release: os.release(), hostname: os.hostname(), uptimeSeconds: Math.round(os.uptime()) };
    default:
      throw new HostError("IOError", `system info "${field}" is not available in this build yet`);
  }
}
