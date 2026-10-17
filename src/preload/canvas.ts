/** Approval canvas preload: reads the review, toggles lines, decides. The host validates every call. */
import { contextBridge, ipcRenderer } from "electron";
import { installTheme } from "./theme.js";

installTheme();

contextBridge.exposeInMainWorld("canvasHost", {
  get: (): Promise<unknown> => ipcRenderer.invoke("canvas:get"),
  toggle: (index: unknown, on: unknown): Promise<unknown> => ipcRenderer.invoke("canvas:toggle", index, on),
  decide: (approve: unknown): Promise<unknown> => ipcRenderer.invoke("canvas:decide", approve),
  onChanged(cb: () => void): void { ipcRenderer.on("canvas:changed", () => cb()); },
});
