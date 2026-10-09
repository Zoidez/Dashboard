/**
 * Card preload. It exposes NO API (TESTPLAN A1). Its only job: receive the card's MessagePort from
 * the host and hand it, once, to the host runtime in the page's main world. Under contextIsolation
 * a port sent by the main process reaches only the preload, so this relay is required.
 */
import { ipcRenderer } from "electron";

let port: MessagePort | null = null;
let wanted = false;
let delivered = false;

function flush(): void {
  if (!wanted || !port || delivered) return;
  delivered = true;
  window.postMessage("dashboard:port", "*", [port]);
  port = null;
}

ipcRenderer.on("card:port", (e) => {
  if (port || delivered || !e.ports[0]) return;
  port = e.ports[0];
  flush();
});

window.addEventListener("message", (ev) => {
  if (ev.source === window && ev.data === "dashboard:want-port") { wanted = true; flush(); }
});

ipcRenderer.send("card:hello");
