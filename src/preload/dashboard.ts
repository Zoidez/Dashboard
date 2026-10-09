/** Dashboard preload: state from the host, and the few things the grid page may ask for. The host validates every message. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dashboardHost", {
  onState(cb: (state: unknown) => void): void {
    ipcRenderer.on("dashboard:state", (_e, state: unknown) => cb(state));
    ipcRenderer.send("dashboard:ready");
  },
  sendRects(rects: unknown): void { ipcRenderer.send("dashboard:rects", rects); },
  saveLayout(update: unknown): void { ipcRenderer.send("dashboard:layout", update); },
  cardAction(cardId: unknown, action: unknown): void { ipcRenderer.send("dashboard:card-action", cardId, action); },
  openOptions(): void { ipcRenderer.send("dashboard:open-options"); },
});
