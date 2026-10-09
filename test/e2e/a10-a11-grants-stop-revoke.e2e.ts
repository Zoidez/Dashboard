/**
 * TESTPLAN A10 (audit, Stop, Revoke) and A11 (lazy grants, host invariant 4).
 * A fresh card holds no grants until it calls; ending the session in any way (Stop, Revoke,
 * crash, reload, quit) empties the grant table and closes what was opened under it, including
 * a network request in flight.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

const MEM = [{ type: "sysinfo", fields: ["memory"], reason: "shows memory use" }];

/** Waits 2.5 s, then calls sysinfo.memory every 300 ms, counting successes. */
const looper = `${PRELUDE}
export async function mount(el, api) {
  api.ui.setStatus({ state: "ok", message: "waiting" });
  await new Promise((r) => setTimeout(r, 2500));
  let n = 0;
  for (;;) {
    const r = await attempt(() => api.sysinfo.memory());
    if (r.ok) n++;
    await report(api, "calls", { n, last: r });
    if (!r.ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}`;

const host = (app: Parameters<typeof snapshot>[0], code: string, arg?: unknown) =>
  app.evaluate(new Function("electron", "arg", `const d = globalThis.__dashboard; ${code}`) as never, arg);

test("A11: grants are lazy and vanish with the session; A10: Stop, Revoke, crash, reload, quit", async () => {
  // A slow local server: the in-flight request must be closed when its card stops.
  const sockets: Socket[] = [];
  let closedSockets = 0;
  const server = createServer(() => { /* never answers */ });
  server.on("connection", (s) => { sockets.push(s); s.on("close", () => closedSockets++); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;

  const inst = makeInstance();
  for (const id of ["stop-me", "revoke-me", "crash-me", "reload-me", "quit-me"]) addCard(inst, { id, ui: looper, permissions: MEM });
  addCard(inst, {
    id: "inflight-card",
    permissions: [{ type: "net.http", origin: `http://127.0.0.1:${port}`, methods: ["GET"], reason: "talks to the local test server" }],
    ui: `${PRELUDE}
export async function mount(el, api) {
  api.ui.setStatus({ state: "ok" });
  await report(api, "started", true);
  await report(api, "result", await attempt(() => api.net.request({ url: "http://127.0.0.1:${port}/slow", timeoutMs: 60000 }).then((r) => r.status)));
}`,
  });

  const app = await launch(inst);
  try {
    // Lazy: running, session live, but no grants before the first call.
    const early = await waitFor(async () => {
      const s = await snapshot(app);
      return s.running.length === 6 && s.running.every((c) => c.sessionLive) ? s : null;
    }, "all cards to start");
    for (const c of early.running.filter((c) => c.cardId !== "inflight-card")) expect(c.grants, `${c.cardId} grants before first call`).toBe(0);

    for (const id of ["stop-me", "revoke-me", "crash-me", "reload-me", "quit-me"]) {
      await waitFor(() => ((cardStorage(inst, id)?.results as any)?.calls?.n ?? 0) >= 2, `${id} to call twice`);
    }
    await waitFor(() => sockets.length > 0, "the in-flight request to reach the server");
    const busy = await snapshot(app);
    for (const c of busy.running) expect(c.grants, `${c.cardId} grants after first call`).toBe(1);
    expect(busy.audit.filter((e) => e.kind === "grant").length).toBe(6);

    // Stop
    await host(app, "d.host.stop('stop-me', 'stopped by test')");
    await host(app, "d.host.stop('inflight-card', 'stopped by test')");
    // Revoke through the approval only: the broker must refuse the next call and stop the card.
    await host(app, "return d.approvals.revoke('revoke-me')");
    // Crash and reload
    await host(app, "d.host.cards.get('crash-me').view.webContents.forcefullyCrashRenderer()");
    await host(app, "d.host.cards.get('reload-me').view.webContents.reload()");

    const after = await waitFor(async () => {
      const s = await snapshot(app);
      return ["stop-me", "revoke-me", "crash-me", "reload-me", "inflight-card"].every((id) => s.stopped.some((x) => x.cardId === id)) ? s : null;
    }, "the five cards to stop");
    const why = Object.fromEntries(after.stopped.map((s) => [s.cardId, s.status.message]));
    console.log("stopped:", JSON.stringify(why));
    expect(why["stop-me"]).toBe("stopped by test");
    expect(why["revoke-me"]).toBe("its approval was revoked");
    expect(why["crash-me"]).toMatch(/process ended/);
    expect(why["reload-me"]).toBe("the card reloaded or navigated");
    expect(after.running.map((c) => c.cardId)).toEqual(["quit-me"]);

    const live = await host(app, "return d.broker.liveSessions().map((s) => s.cardId)");
    expect(live).toEqual(["quit-me"]);
    for (const id of ["stop-me", "revoke-me", "crash-me", "reload-me", "inflight-card"]) {
      const ends = after.audit.filter((e) => e.cardId === id && e.kind === "grant-dropped");
      expect(ends.length, `${id} session ended once`).toBe(1);
      expect(ends[0].detail).toBe("1 grant(s) dropped");
    }
    const revoked = JSON.parse(readFileSync(join(inst, "data/approvals/revoke-me.json"), "utf8"));
    expect(revoked.revoked).toBe(true);
    expect(after.audit.some((e) => e.cardId === "revoke-me" && e.kind === "denied" && e.detail === "request after the approval was revoked")).toBe(true);

    // Stopped cards make no more calls.
    const nStop = (cardStorage(inst, "stop-me")!.results as any).calls.n;
    await new Promise((r) => setTimeout(r, 1500));
    expect((cardStorage(inst, "stop-me")!.results as any).calls.n).toBe(nStop);

    // The in-flight request was closed when its card stopped.
    await waitFor(() => closedSockets >= 1, "the in-flight socket to close", 10_000);
  } finally {
    await app.close();
    server.close();
  }
  // Quit: the last card's session ended with the app.
  const log = readFileSync(join(inst, "data/audit/quit-me.jsonl"), "utf8");
  expect(log).toContain("the Dashboard quit");
  expect(log).toContain("1 grant(s) dropped");
});
