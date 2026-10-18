/** Dashboard preload: state from the host, and the few things the grid page may ask for. The host validates every message. */
import { contextBridge, ipcRenderer } from "electron";
import { installTheme } from "./theme.js";

installTheme();

contextBridge.exposeInMainWorld("dashboardHost", {
  onState(cb: (state: unknown) => void): void {
    ipcRenderer.on("dashboard:state", (_e, state: unknown) => cb(state));
    ipcRenderer.send("dashboard:ready");
  },
  sendRects(rects: unknown): void { ipcRenderer.send("dashboard:rects", rects); },
  saveLayout(update: unknown): void { ipcRenderer.send("dashboard:layout", update); },
  cardAction(cardId: unknown, action: unknown): void { ipcRenderer.send("dashboard:card-action", cardId, action); },
  cardPermission(cardId: unknown, category: unknown, on: unknown): void { ipcRenderer.send("dashboard:card-permission", cardId, category, on); },
  openOptions(): void { ipcRenderer.send("dashboard:open-options"); },
  // The New card: the only place a generation can start (host invariant 1).
  newCardStart(req: unknown): void { ipcRenderer.send("new:start", req); },
  newCardStop(): void { ipcRenderer.send("new:stop"); },
  newCardTestCli(): void { ipcRenderer.send("new:test-cli"); },
  newCardLassCancel(id: unknown): void { ipcRenderer.send("new:lass-cancel", id); },
  // The LASS bar (LASS.md 7).
  lassAnswer(id: unknown, text: unknown): void { ipcRenderer.send("lass:answer", id, text); },
  lassDismiss(id: unknown): void { ipcRenderer.send("lass:dismiss", id); },
  // LASS fixes (LASS.md 8): each step is the user's click; the answer is a reason when it cannot run.
  lassFix(id: unknown, action: unknown, confirmedRed: unknown): Promise<string | null> { return ipcRenderer.invoke("lass:fix", id, action, confirmedRed); },
  lassPatch(id: unknown): Promise<string> { return ipcRenderer.invoke("lass:patch", id); },
});
