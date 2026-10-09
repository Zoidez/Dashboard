/**
 * TESTPLAN A3 (identity) and A6 (reserved and removed APIs).
 * The spy card grabs its own raw port (by patching MessagePort.prototype.postMessage, which card
 * code can always do) and sends forged messages: claiming another card's id, calling reserved and
 * non-existent namespaces. The victim card holds a permission the spy does not.
 */
import { expect, test } from "@playwright/test";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

const spy = `${PRELUDE}
function grabPort(api) {
  return new Promise((resolve) => {
    const orig = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) { MessagePort.prototype.postMessage = orig; resolve(this); return orig.apply(this, args); };
    api.ui.setStatus({ state: "loading", message: "grabbing port" });
  });
}
function raw(port, msg, id) {
  return new Promise((resolve) => {
    const onMsg = (ev) => { if (ev.data && ev.data.t === "ret" && ev.data.id === id) { port.removeEventListener("message", onMsg); resolve(ev.data); } };
    port.addEventListener("message", onMsg);
    port.postMessage(msg);
    setTimeout(() => resolve({ timeout: true }), 3000);
  });
}
export async function mount(el, api) {
  const r = {};
  r.ownMemory = await attempt(() => api.sysinfo.memory());
  r.processRun = await attempt(() => api.process.run("cmd.exe"));
  r.claudeAsk = await attempt(() => api.claude.ask("hi"));
  r.busEmit = await attempt(() => api.bus.emit("x"));
  r.ffiExists = "ffi" in api;
  const port = await grabPort(api);
  r.claimVictim = await raw(port, { t: "call", id: 900001, m: "sysinfo.memory", a: [], cardId: "victim-card" }, 900001);
  r.plainRaw = await raw(port, { t: "call", id: 900002, m: "sysinfo.memory", a: [] }, 900002);
  r.ffiRaw = await raw(port, { t: "call", id: 900003, m: "ffi.call", a: ["user32.dll"] }, 900003);
  r.processRaw = await raw(port, { t: "call", id: 900004, m: "process.launch", a: ["calc.exe"] }, 900004);
  r.protoPollution = await raw(port, JSON.parse('{"t":"call","id":900005,"m":"sysinfo.memory","a":[],"__proto__":{"cardId":"victim-card"}}'), 900005);
  await report(api, "spy", r);
}
`;

const victim = `${PRELUDE}
export async function mount(el, api) {
  await report(api, "memory", await attempt(() => api.sysinfo.memory()));
  api.ui.setStatus({ state: "ok" });
}
`;

test("identity comes from the port; reserved and removed APIs always fail", async () => {
  const inst = makeInstance();
  addCard(inst, { id: "spy-card", ui: spy });
  addCard(inst, { id: "victim-card", ui: victim, permissions: [{ type: "sysinfo", fields: ["memory"], reason: "shows memory use" }] });
  const app = await launch(inst);
  try {
    const res = await waitFor(() => (cardStorage(inst, "spy-card")?.results as any)?.spy, "the spy to report");
    await waitFor(() => (cardStorage(inst, "victim-card")?.results as any)?.memory, "the victim to report");
    console.log("spy:", JSON.stringify(res));
    const victimMem = (cardStorage(inst, "victim-card")!.results as any).memory;
    expect(victimMem.ok, "victim can read memory").toBe(true);

    expect(res.ownMemory).toMatchObject({ ok: false, code: "PermissionDenied" });
    expect(res.processRun).toMatchObject({ ok: false, code: "Reserved" });
    expect(res.claudeAsk).toMatchObject({ ok: false, code: "Reserved" });
    expect(res.busEmit).toMatchObject({ ok: false, code: "Reserved" });
    expect(res.ffiExists).toBe(false);
    expect(res.claimVictim).toMatchObject({ ok: false, e: { code: "InvalidArgument" } });
    expect(res.claimVictim.e.message).toContain("unknown field");
    expect(res.plainRaw).toMatchObject({ ok: false, e: { code: "PermissionDenied" } });
    expect(res.ffiRaw).toMatchObject({ ok: false, e: { code: "InvalidArgument" } });
    expect(res.processRaw).toMatchObject({ ok: false, e: { code: "Reserved" } });
    expect(res.protoPollution.ok).toBe(false);

    const snap = await snapshot(app);
    const spyAudit = snap.audit.filter((e) => e.cardId === "spy-card").map((e) => e.kind);
    expect(spyAudit).toContain("reserved-call");
    expect(spyAudit).toContain("invalid-message");
    expect(spyAudit).toContain("denied");
    expect(snap.audit.some((e) => e.cardId === "victim-card" && e.kind === "denied")).toBe(false);
  } finally {
    await app.close();
  }
});
