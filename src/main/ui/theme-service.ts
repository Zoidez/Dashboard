/**
 * The current theme (THEMES.md): the user's choice in Options, light or dark from the choice or from
 * Windows. Sends the theme to the app's own windows (each preload applies it to its page) and tells
 * the card host, which pushes it to running cards. Data goes from the host to pages only.
 */
import { ipcMain, nativeTheme, webContents } from "electron";
import type { OptionsStore } from "../options.js";
import { appVars, resolveMode, themeById, themeState, type ThemeState } from "../../shared/theme.js";

export interface AppThemePayload { state: ThemeState; vars: Record<string, string> }

export class ThemeService {
  private listeners = new Set<(s: ThemeState) => void>();
  private last = "";

  constructor(private readonly options: OptionsStore, private readonly isAppPage: (wc: Electron.WebContents) => boolean) {
    // The app's pages ask once, synchronously, before their first paint.
    ipcMain.on("theme:get", (e) => { e.returnValue = this.isAppPage(e.sender) ? this.payload() : null; });
    nativeTheme.on("updated", () => this.changed());
  }

  current(): ThemeState {
    const g = this.options.general;
    const t = themeById(g.theme);
    return themeState(t, resolveMode(t, g.themeMode, nativeTheme.shouldUseDarkColors));
  }

  payload(): AppThemePayload {
    const state = this.current();
    return { state, vars: appVars(state) };
  }

  onChange(cb: (s: ThemeState) => void): void { this.listeners.add(cb); }

  /** Call after the theme setting changed; also runs when Windows switches light/dark. */
  changed(): void {
    const p = this.payload();
    const key = JSON.stringify(p.state);
    if (key === this.last) return;
    this.last = key;
    for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && this.isAppPage(wc)) wc.send("theme:changed", p);
    for (const cb of this.listeners) { try { cb(p.state); } catch { /* one listener never blocks the rest */ } }
  }
}
