/** Options window preload: reads the host's state and asks for validated changes. Nothing else. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("optionsHost", {
  get: (): Promise<unknown> => ipcRenderer.invoke("options:get"),
  set: (patch: unknown): Promise<unknown> => ipcRenderer.invoke("options:set", patch),
  cardAction: (cardId: unknown, action: unknown): Promise<unknown> => ipcRenderer.invoke("options:card-action", cardId, action),
  audit: (cardId: unknown): Promise<unknown> => ipcRenderer.invoke("options:audit", cardId),
  onChanged(cb: () => void): void { ipcRenderer.on("options:changed", () => cb()); },
});
