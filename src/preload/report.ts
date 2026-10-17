/** "Something's wrong" window preload: sends the user's description, or closes. The host validates both. */
import { contextBridge, ipcRenderer } from "electron";
import { installTheme } from "./theme.js";

installTheme();

contextBridge.exposeInMainWorld("reportHost", {
  send: (text: unknown): Promise<unknown> => ipcRenderer.invoke("report:send", text),
  close: (): void => ipcRenderer.send("report:close"),
});
