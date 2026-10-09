/**
 * Host runtime inside a card's Web Worker (served as card://<id>/__host/worker-runtime.js).
 * Loads the card's worker.js, gives it the api (without api.ui, which is ui.js only), runs start()
 * and, when the host sends a tick, tick(). Every call goes to the page runtime, which relays it over
 * the card's port; nothing here holds any privilege.
 */
import type { CardWorkerModule, ErrorCode } from "../../spec/host-api.js";
import { buildApi, hostError } from "./api.js";

declare const self: { postMessage(m: unknown): void; onmessage: ((ev: MessageEvent) => void) | null; location: { href: string } };

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const listeners = new Map<string, Set<(v: unknown) => void>>();
const fromUi = new Set<(m: unknown) => void>();

const call = (m: string, ...a: unknown[]): Promise<any> => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  self.postMessage({ k: "call", id, m, a });
});

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data as { k: string; id?: number; ok?: boolean; v?: unknown; e?: { code: ErrorCode; message: string }; ch?: string; cardId?: string; config?: Record<string, string | number | boolean> };
  switch (msg?.k) {
    case "ret": {
      const p = pending.get(msg.id!);
      if (!p) return;
      pending.delete(msg.id!);
      if (msg.ok) p.resolve(msg.v); else p.reject(hostError(msg.e!.code, msg.e!.message));
      return;
    }
    case "evt":
      for (const cb of listeners.get(msg.ch!) ?? []) { try { cb(msg.v); } catch (e) { console.error(e); } }
      return;
    case "msg":
      for (const cb of fromUi) { try { cb(msg.v); } catch (e) { console.error(e); } }
      return;
    case "init":
      await start(msg.cardId!, msg.config ?? {});
      return;
  }
};

async function start(cardId: string, config: Record<string, string | number | boolean>): Promise<void> {
  const api = buildApi({ call, listeners }, {
    cardId, config,
    messaging: {
      send: (m) => self.postMessage({ k: "msg", v: m }),
      onMessage: (cb) => { fromUi.add(cb); return () => fromUi.delete(cb); },
    },
  });
  const workerUrl = new URL("/worker.js", self.location.href).href;   // a variable, so the bundler leaves it alone
  const mod = (await import(workerUrl)) as CardWorkerModule;
  // Ticks come from the host (manifest.schedule.intervalSeconds); the host stops a card whose tick runs over 60 s.
  if (!listeners.has("card:tick")) listeners.set("card:tick", new Set());
  listeners.get("card:tick")!.add((seq) => {
    void (async () => {
      try { await mod.tick?.(api); } catch (e) { console.error(e); }
      call("card.tickDone", seq).catch(() => undefined);
    })();
  });
  await mod.start?.(api);
}
