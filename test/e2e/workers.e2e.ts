/**
 * worker.js (ARCHITECTURE.md, "One isolated runtime per card"): runs as a Web Worker in the card's
 * own view. It gets the card's approved permissions and nothing else, no api.ui, no Node, no direct
 * network; it talks to ui.js through api.messaging; the host drives tick() and stops a card whose
 * tick runs too long.
 */
import { expect, test } from "@playwright/test";
import { createServer } from "node:net";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, ready, snapshot, waitFor } from "./helpers";

test("worker.js: same identity and sandbox, no ui, no network; messaging works; ticks are watched", async () => {
  let hits = 0;
  const server = createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const inst = makeInstance();
  addCard(inst, {
    id: "worker-card",
    permissions: [{ type: "sysinfo", fields: ["memory"], reason: "shows memory use in the background" }],
    manifest: { schedule: { intervalSeconds: 3600 } },
    ui: `${PRELUDE}
export async function mount(el, api) {
  api.messaging.onMessage((m) => report(api, "fromWorker", m));
  setTimeout(() => api.messaging.send("ping"), 500);
  api.ui.setStatus({ state: "ok" });
}`,
    worker: `${PRELUDE}
let ticks = 0;
function rawCall(m, a) {
  return new Promise((resolve) => {
    const id = 987654;
    const on = (ev) => { if (ev.data && ev.data.k === "ret" && ev.data.id === id) { self.removeEventListener("message", on); resolve(ev.data); } };
    self.addEventListener("message", on);
    self.postMessage({ k: "call", id, m, a });
  });
}
export async function start(api) {
  api.messaging.onMessage((m) => { if (m === "ping") api.messaging.send("pong from " + api.card.cardId); });
  const r = {};
  r.hasUi = "ui" in api;
  r.globals = { require: typeof require, process: typeof process, document: typeof document };
  r.memory = await attempt(() => api.sysinfo.memory().then((m) => m.totalBytes > 0));
  r.cpu = await attempt(() => api.sysinfo.cpu());
  r.reserved = await attempt(() => api.process.run("cmd.exe"));
  r.rawUi = await rawCall("ui.setStatus", [{ state: "ok", message: "from the worker" }]);
  r.fetch = await attempt(() => fetch(${JSON.stringify(BASE)} + "/w").then((x) => x.status));
  r.xhr = await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", ${JSON.stringify(BASE)} + "/x"); x.onload = () => res(x.status); x.onerror = () => rej(new Error("xhr error")); x.send(); }));
  r.ws = await attempt(() => new Promise((res, rej) => { const w = new WebSocket(${JSON.stringify(BASE.replace("http", "ws"))}); w.onopen = () => res("open"); w.onerror = () => rej(new Error("ws error")); }));
  r.remoteImport = await attempt(() => import(${JSON.stringify(BASE)} + "/m.js").then(() => "imported"));
  r.nestedBlob = await attempt(() => new Promise((res, rej) => { const w = new Worker(URL.createObjectURL(new Blob(["postMessage(1)"]))); w.onmessage = () => res("ran"); w.onerror = () => rej(new Error("blocked")); }));
  await api.storage.set("worker", r);
}
export async function tick(api) {
  ticks++;
  await api.storage.set("ticks", ticks);
  if (ticks === 3) await new Promise(() => {});        // the third tick never finishes
}`,
  });

  const app = await launch(inst);
  try {
    await ready(app);
    const w = await waitFor(() => cardStorage(inst, "worker-card")?.worker as any, "the worker's results", 30_000);
    console.log("worker:", JSON.stringify(w));
    expect(w.hasUi).toBe(false);
    expect(w.globals).toEqual({ require: "undefined", process: "undefined", document: "undefined" });
    expect(w.memory).toMatchObject({ ok: true, v: "true" });
    expect(w.cpu).toMatchObject({ ok: false, code: "PermissionDenied" });
    expect(w.reserved).toMatchObject({ ok: false, code: "Reserved" });
    expect(w.rawUi).toMatchObject({ ok: false, e: { code: "InvalidArgument" } });
    for (const k of ["fetch", "xhr", "ws", "remoteImport", "nestedBlob"]) expect(w[k].ok, k).toBe(false);
    await waitFor(() => (cardStorage(inst, "worker-card")?.results as any)?.fromWorker, "the worker's reply to ui.js");
    expect((cardStorage(inst, "worker-card")!.results as any).fromWorker).toBe("pong from worker-card");

    // Ticks: two finish; the third hangs and the watchdog stops the card.
    const tick = () => app.evaluate(() => (globalThis as any).__dashboard.host.tick("worker-card"));
    expect(await tick()).toBe(true);
    await waitFor(() => cardStorage(inst, "worker-card")?.ticks === 1, "tick 1");
    expect(await tick()).toBe(true);
    await waitFor(() => cardStorage(inst, "worker-card")?.ticks === 2, "tick 2");
    await app.evaluate(() => { (globalThis as any).__dashboard.host.opts.limits = { tickTimeoutMs: 2000 }; });
    expect(await tick()).toBe(true);
    await waitFor(() => cardStorage(inst, "worker-card")?.ticks === 3, "tick 3 to start");
    expect(await tick(), "a tick is skipped while the previous one runs").toBe(false);
    const snap = await waitFor(async () => { const s = await snapshot(app); return s.stopped.some((x) => x.cardId === "worker-card") ? s : null; }, "the watchdog to stop the card", 10_000);
    expect(snap.stopped.find((x) => x.cardId === "worker-card")!.status.message).toBe("its background tick ran longer than 2 seconds");
    expect(snap.audit.some((e) => e.cardId === "worker-card" && e.kind === "card-flagged")).toBe(true);
    expect(hits, "the worker reached the network").toBe(0);
  } finally {
    await app.close();
    server.close();
  }
});
