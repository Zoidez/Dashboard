/**
 * TESTPLAN A2: a hostile card tries every direct network path to a local listener.
 * Pass = the listener sees no TCP connection and no UDP packet, the card's attempts fail,
 * and the host logged blocked requests.
 */
import { expect, test } from "@playwright/test";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { addCard, cardStorage, launch, makeInstance, PRELUDE, snapshot, waitFor } from "./helpers";

function hostile(tcp: number, udp: number): string {
  const base = `http://127.0.0.1:${tcp}`;
  return `${PRELUDE}
const BASE = ${JSON.stringify(base)};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadEl(tag, attrs) {
  return new Promise((resolve) => {
    const e = document.createElement(tag);
    e.onload = () => resolve("loaded"); e.onerror = () => resolve("error");
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    document.body.appendChild(e);
    setTimeout(() => resolve("timeout"), 3000);
  });
}
export async function mount(el, api) {
  el.textContent = "hostile network card";
  const r = {};
  r.fetch = await attempt(() => fetch(BASE + "/fetch").then((x) => x.status));
  r.fetchNoCors = await attempt(() => fetch(BASE + "/nocors", { mode: "no-cors" }).then((x) => x.type));
  r.xhr = await attempt(() => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("GET", BASE + "/xhr"); x.onload = () => res(x.status); x.onerror = () => rej(new Error("xhr error")); x.send(); }));
  r.websocket = await attempt(() => new Promise((res, rej) => { const w = new WebSocket("ws://127.0.0.1:${tcp}/ws"); w.onopen = () => res("open"); w.onerror = () => rej(new Error("ws error")); setTimeout(() => rej(new Error("ws timeout")), 3000); }));
  r.beacon = await attempt(() => navigator.sendBeacon(BASE + "/beacon", "x"));
  r.eventSource = await attempt(() => new Promise((res, rej) => { const s = new EventSource(BASE + "/es"); s.onopen = () => res("open"); s.onerror = () => { s.close(); rej(new Error("es error")); }; }));
  r.img = await loadEl("img", { src: BASE + "/img.png" });
  r.css = await loadEl("link", { rel: "stylesheet", href: BASE + "/style.css" });
  r.script = await loadEl("script", { src: BASE + "/script.js" });
  r.preconnect = await loadEl("link", { rel: "preconnect", href: BASE });
  r.prefetch = await loadEl("link", { rel: "prefetch", href: BASE + "/prefetch" });
  r.dnsPrefetch = await loadEl("link", { rel: "dns-prefetch", href: "//dns-prefetch-probe.invalid" });
  const st = document.createElement("style");
  st.textContent = "@font-face { font-family: probe; src: url(" + BASE + "/font.woff2); } .f { font-family: probe; } .bg { background: url(" + BASE + "/bg.png); }";
  document.head.appendChild(st);
  const fe = document.createElement("div"); fe.className = "f bg"; fe.textContent = "font probe"; document.body.appendChild(fe);
  r.fileUrl = await attempt(() => fetch("file:///C:/Windows/win.ini").then((x) => x.status));
  r.blobWorker = await attempt(() => new Promise((res, rej) => {
    const src = "try { importScripts(" + JSON.stringify(BASE + "/worker-import.js") + "); postMessage('imported'); } catch (e) { postMessage('blocked'); }";
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e) => res(e.data); w.onerror = () => rej(new Error("worker error"));
  }));
  r.webrtc = await attempt(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udp}" }] });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
    await sleep(3000);
    const c = pc.localDescription ? pc.localDescription.sdp.split("\\n").filter((l) => l.startsWith("a=candidate")).length : 0;
    pc.close();
    return "candidates:" + c;
  });
  r.windowOpen = await attempt(() => String(window.open(BASE + "/popup")));
  await report(api, "network", r);
  // Navigation attempts last: a successful navigation would end the card.
  const f = document.createElement("form"); f.method = "POST"; f.action = BASE + "/form"; document.body.appendChild(f);
  try { f.submit(); } catch (e) {}
  await sleep(500);
  try { location.href = BASE + "/navigate"; } catch (e) {}
  await sleep(1500);
  await report(api, "done", true);
}
`;
}

test("the card session blocks the network even without CSP (second line)", async () => {
  const tcpHits: string[] = [];
  const server = createServer((s) => { tcpHits.push(String(s.remotePort)); s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const inst = makeInstance();
  addCard(inst, { id: "plain-card", ui: "export function mount(el, api) { api.ui.setStatus({ state: 'ok' }); }" });
  const app = await launch(inst);
  try {
    await waitFor(async () => (await snapshot(app)).running[0]?.status.state === "ok", "the card to start");
    // A page with no CSP at all, loaded straight into the card's own session.
    const res = await app.evaluate(async ({ BrowserWindow }, p) => {
      const card = [...(globalThis as any).__dashboard.host.cards.values()][0];
      const w = new BrowserWindow({ show: false, webPreferences: { session: card.session, sandbox: true } });
      let loaded = "loaded";
      try { await w.loadURL(`http://127.0.0.1:${p}/direct`); } catch (e) { loaded = String((e as Error).message).slice(0, 120); }
      w.destroy();
      return { loaded, proxy: await card.session.resolveProxy(`http://127.0.0.1:${p}/`) };
    }, port);
    await new Promise((r) => setTimeout(r, 500));
    const snap = await snapshot(app);
    console.log("direct load:", JSON.stringify(res));
    expect(res.loaded).not.toBe("loaded");
    expect(res.proxy).toMatch(/^PROXY /);
    expect(tcpHits).toEqual([]);
    expect(snap.audit.some((e) => e.cardId === "plain-card" && e.kind === "blocked-request" && e.detail.includes(`127.0.0.1:${port}/direct`))).toBe(true);
  } finally {
    await app.close();
    server.close();
  }
});

test("a card cannot reach the network directly by any path", async () => {
  const tcpHits: string[] = [];
  const server = createServer((s) => { tcpHits.push(`${s.remoteAddress}:${s.remotePort}`); s.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const tcp = (server.address() as { port: number }).port;
  const udpHits: number[] = [];
  const udpSock = createSocket("udp4");
  udpSock.on("message", (m) => udpHits.push(m.length));
  await new Promise<void>((r) => udpSock.bind(0, "127.0.0.1", () => r()));
  const udp = udpSock.address().port;

  const inst = makeInstance();
  addCard(inst, { id: "hostile-net", ui: hostile(tcp, udp) });
  const app = await launch(inst);
  try {
    await waitFor(() => (cardStorage(inst, "hostile-net")?.results as Record<string, unknown> | undefined)?.network, "the hostile card to report", 45_000);
    await new Promise((r) => setTimeout(r, 4000));   // let the navigation attempts happen
    const r = (cardStorage(inst, "hostile-net")!.results as Record<string, any>).network;
    console.log("card view of its attempts:", JSON.stringify(r));
    const snap = await snapshot(app);
    const blocked = snap.audit.filter((e) => e.cardId === "hostile-net" && e.kind === "blocked-request");
    console.log("host blocked:", blocked.map((e) => e.detail).join(" | "));

    expect(tcpHits, "TCP connections reached the listener").toEqual([]);
    expect(udpHits, "UDP packets reached the listener").toEqual([]);
    for (const k of ["fetch", "fetchNoCors", "xhr", "websocket", "eventSource", "fileUrl"]) expect(r[k].ok, k).toBe(false);
    for (const k of ["img", "css", "script", "preconnect", "prefetch"]) expect(r[k], k).not.toBe("loaded");
    expect(r.blobWorker.ok && r.blobWorker.v === "imported", "worker importScripts").toBe(false);
    expect(r.windowOpen.v ?? "null", "window.open").toBe("null");
    expect(blocked.length, "host logged blocked requests").toBeGreaterThan(0);
    // A navigation attempt ends the card (fail closed); it must never load the other page.
    const stopped = snap.stopped.find((s) => s.cardId === "hostile-net");
    if (stopped) expect(stopped.status.message).toBe("the card reloaded or navigated");
    else expect(snap.running.map((c) => c.cardId)).toContain("hostile-net");
    console.log("card after navigation attempts:", stopped ? `stopped (${stopped.status.message})` : "still running");
  } catch (e) {
    const snap = await snapshot(app).catch(() => null);
    console.log("DIAG storage:", JSON.stringify(cardStorage(inst, "hostile-net")));
    console.log("DIAG host:", JSON.stringify({ running: snap?.running, stopped: snap?.stopped, audit: snap?.audit.slice(-30) }));
    throw e;
  } finally {
    await app.close();
    server.close();
    udpSock.close();
  }
});
