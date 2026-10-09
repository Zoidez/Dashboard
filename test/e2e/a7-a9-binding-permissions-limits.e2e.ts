/**
 * TESTPLAN A7 (version binding), A8 (browser permissions), A9 (resource limits).
 */
import { expect, test } from "@playwright/test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const ok = "export function mount(el, api) { el.textContent = 'ok'; api.ui.setStatus({ state: 'ok' }); }";

test("A7: cards whose files differ from the approval are not served", async () => {
  const inst = makeInstance();
  addCard(inst, { id: "changed-before", ui: ok });
  appendFileSync(join(inst, "data/cards/changed-before/ui.js"), "\n// edited after approval\n");
  addCard(inst, { id: "extra-file", ui: ok });
  writeFileSync(join(inst, "data/cards/extra-file/CLAUDE.md"), "planted");
  addCard(inst, { id: "never-approved", ui: ok, approve: false });
  addCard(inst, {
    id: "changed-during", ui: `${PRELUDE}
export async function mount(el, api) {
  api.ui.setStatus({ state: "ok" });
  await new Promise((r) => setTimeout(r, 3000));
  const img = document.createElement("img"); img.src = "/assets/pic.png"; document.body.appendChild(img);
}`, assets: { "pic.png": PNG },
  });
  addCard(inst, { id: "good-card", ui: ok });

  const app = await launch(inst);
  try {
    await waitFor(async () => (await snapshot(app)).running.some((c) => c.cardId === "changed-during" && c.status.state === "ok"), "changed-during to start");
    writeFileSync(join(inst, "data/cards/changed-during/assets/pic.png"), Buffer.concat([PNG, Buffer.from("x")]));
    const snap = await waitFor(async () => {
      const s = await snapshot(app);
      return s.stopped.some((x) => x.cardId === "changed-during") ? s : null;
    }, "changed-during to be stopped");
    const why = Object.fromEntries(snap.stopped.map((s) => [s.cardId, s.status]));
    console.log("refused:", JSON.stringify(why));
    expect(why["changed-before"]).toMatchObject({ state: "refused", message: "its files changed after approval" });
    expect(why["extra-file"].state).toBe("refused");
    expect(why["extra-file"].message).toContain("unexpected file: CLAUDE.md");
    expect(why["never-approved"]).toMatchObject({ state: "refused", message: "not approved" });
    expect(why["changed-during"]).toMatchObject({ state: "refused", message: "its files changed after approval" });
    expect(snap.running.map((c) => c.cardId)).toEqual(["good-card"]);
    expect(snap.audit.some((e) => e.cardId === "changed-during" && e.kind === "approval-mismatch")).toBe(true);
  } finally {
    await app.close();
  }
});

test("A8: every browser permission request is denied", async () => {
  const inst = makeInstance();
  addCard(inst, {
    id: "perm-card", ui: `${PRELUDE}
export async function mount(el, api) {
  const r = {};
  r.camera = await attempt(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted"));
  r.mic = await attempt(() => navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted"));
  r.screen = await attempt(() => navigator.mediaDevices.getDisplayMedia({ video: true }).then(() => "granted"));
  r.notification = await attempt(() => Notification.requestPermission());
  r.clipboardRead = await attempt(() => navigator.clipboard.readText());
  r.clipboardWrite = await attempt(() => navigator.clipboard.writeText("x").then(() => "written"));
  r.geolocation = await attempt(() => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(() => res("granted"), (e) => rej(new Error(e.message)), { timeout: 3000 })));
  r.midi = await attempt(() => navigator.requestMIDIAccess().then(() => "granted"));
  await report(api, "perms", r);
  // Device pickers need a user gesture: a full-card button the test clicks.
  const b = document.createElement("button");
  b.textContent = "devices"; b.style.cssText = "position:fixed;inset:0;width:100%;height:100%";
  b.onclick = async () => {
    const d = {};
    d.activation = navigator.userActivation.isActive;
    const usb = navigator.usb ? navigator.usb.requestDevice({ filters: [] }) : Promise.reject(new Error("no usb api"));
    const hid = navigator.hid ? navigator.hid.requestDevice({ filters: [] }) : Promise.reject(new Error("no hid api"));
    const serial = navigator.serial ? navigator.serial.requestPort() : Promise.reject(new Error("no serial api"));
    d.usb = await attempt(() => usb.then(() => "granted"));
    d.hid = await attempt(() => hid.then((x) => (x.length ? "granted" : "none")));
    d.serial = await attempt(() => serial.then(() => "granted"));
    await report(api, "devices", d);
  };
  document.body.appendChild(b);
}`,
  });
  const app = await launch(inst);
  try {
    const r = await waitFor(() => (cardStorage(inst, "perm-card")?.results as any)?.perms, "the card to report", 30_000);
    console.log("permission attempts:", JSON.stringify(r));
    for (const [k, v] of Object.entries(r as Record<string, { ok: boolean; v?: string }>)) {
      const granted = v.ok && (v.v === "granted" || v.v === "written" || (k === "notification" && v.v === "granted") || (k === "clipboardRead"));
      expect(granted, `${k}: ${JSON.stringify(v)}`).toBe(false);
    }
    expect(r.notification.v === "granted").toBe(false);

    // A real (synthetic) click inside the card's view, so the pickers are actually requested.
    await app.evaluate(async () => {
      const card = (globalThis as any).__dashboard.host.cards.get("perm-card");
      const wc = card.view.webContents;
      wc.focus();
      for (const type of ["mouseDown", "mouseUp"]) wc.sendInputEvent({ type, x: 40, y: 40, button: "left", clickCount: 1 });
    });
    const d = await waitFor(() => (cardStorage(inst, "perm-card")?.results as any)?.devices, "the device attempts", 20_000);
    console.log("device attempts:", JSON.stringify(d));
    expect(d.activation, "the click counted as a user gesture").toBe(true);
    for (const k of ["usb", "hid", "serial"]) {
      expect(d[k].ok && d[k].v === "granted", k).toBe(false);
      expect(String(d[k].msg ?? d[k].v), `${k} refused for a reason other than a missing gesture`).not.toContain("user gesture");
    }
    const snap = await snapshot(app);
    const perms = snap.audit.filter((e) => e.cardId === "perm-card" && e.kind === "browser-permission").map((e) => e.detail);
    console.log("host saw:", perms.join(" | "));
    expect(perms.length).toBeGreaterThan(0);
  } finally {
    await app.close();
  }
});

test("A9: message size, rate and memory limits stop and flag the card", async () => {
  const inst = makeInstance();
  addCard(inst, {
    id: "big-message", ui: `${PRELUDE}
export async function mount(el, api) {
  const r = {};
  r.huge = await attempt(() => api.storage.set("x", "a".repeat(12 * 1024 * 1024)));
  r.overStorage = await attempt(() => api.storage.set("x", "a".repeat(1100 * 1024)));
  await report(api, "size", r);
}`,
  });
  addCard(inst, {
    id: "flood-card", ui: `
export function mount(el, api) {
  api.ui.setStatus({ state: "ok" });
  setTimeout(() => { for (let i = 0; i < 5000; i++) api.ui.notify("flood " + i); }, 500);
}`,
  });
  addCard(inst, {
    id: "memory-hog", ui: `
export async function mount(el, api) {
  api.ui.setStatus({ state: "ok" });
  const keep = [];
  for (let i = 0; i < 12; i++) { const b = new Uint8Array(64 * 1024 * 1024); b.fill(i + 1); keep.push(b); await new Promise((r) => setTimeout(r, 200)); }
  globalThis.keep = keep;
}`,
  });
  const app = await launch(inst);
  try {
    const size = await waitFor(() => (cardStorage(inst, "big-message")?.results as any)?.size, "big-message to report");
    console.log("size:", JSON.stringify(size));
    expect(size.huge).toMatchObject({ ok: false, code: "InvalidArgument" });
    expect(size.huge.msg).toContain("too large");
    expect(size.overStorage).toMatchObject({ ok: false, code: "TooLarge" });

    const snap = await waitFor(async () => {
      const s = await snapshot(app);
      return s.stopped.some((x) => x.cardId === "flood-card") && s.stopped.some((x) => x.cardId === "memory-hog") ? s : null;
    }, "flood-card and memory-hog to be stopped", 45_000);
    const why = Object.fromEntries(snap.stopped.map((s) => [s.cardId, s.status.message]));
    console.log("stopped:", JSON.stringify(why));
    expect(why["flood-card"]).toBe("sent messages faster than the host allows");
    expect(why["memory-hog"]).toBe("used more memory than the host allows");
    for (const id of ["flood-card", "memory-hog"]) expect(snap.audit.some((e) => e.cardId === id && e.kind === "card-flagged")).toBe(true);
    const sec = readFileSync(join(inst, "data/audit/_security.jsonl"), "utf8");
    expect(sec).toContain("card-flagged");
  } finally {
    await app.close();
  }
});
