/** Dashboard preload: one-way state updates from the host to the grid page. Nothing else. */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dashboardHost", {
  onState(cb: (state: unknown) => void): void {
    ipcRenderer.on("dashboard:state", (_e, state: unknown) => cb(state));
    ipcRenderer.send("dashboard:ready");
  },
});
