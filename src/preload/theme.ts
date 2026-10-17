/**
 * Theme for the app's own pages (THEMES.md): the host sends CSS variables; they are set on the page's
 * root before the first paint and replaced when the theme changes. The values were validated by the
 * host (host invariant 14); names and values are checked again here before they touch the page.
 */
import { ipcRenderer } from "electron";

interface Payload { state: { mode: string; methods: string[] }; vars: Record<string, string> }
const NAME = /^--[a-z0-9-]{1,40}$/;
const VALUE = /^[#\w\s",.()-]{1,200}$/;

function apply(p: Payload | null): void {
  const root = document.documentElement;
  if (!p || !root) return;
  for (const [k, v] of Object.entries(p.vars)) if (NAME.test(k) && typeof v === "string" && VALUE.test(v)) root.style.setProperty(k, v);
  root.dataset.theme = p.state.mode === "dark" ? "dark" : "light";
  root.style.colorScheme = root.dataset.theme;
  // Severity display methods of the theme: the grid's CSS draws each one (dashboard.css, [data-sev~=...]).
  root.dataset.sev = p.state.methods.filter((m) => /^[a-zA-Z]{1,12}$/.test(m)).join(" ");
}

export function installTheme(): void {
  let first: Payload | null = null;
  try { first = ipcRenderer.sendSync("theme:get") as Payload | null; } catch { /* the page keeps the stylesheet defaults */ }
  if (document.documentElement) apply(first);
  else document.addEventListener("DOMContentLoaded", () => apply(first), { once: true });
  ipcRenderer.on("theme:changed", (_e, p: Payload) => apply(p));
}
