/**
 * Themes (docs/THEMES.md): the one definition of colours and fonts for the app's screens and the
 * card pages. The built-in themes are src/shared/themes.json, generated and checked by
 * scripts/theme-check.mjs (contrast, brightness and colour-blindness rules).
 *
 * Host invariant 14 (RULES.md): theme values are written into every card's page, so every theme is
 * validated here before use: colours only as #rrggbb, fonts only from the list, numbers in range,
 * severity methods only from the five names. Anything else is rejected.
 */
import BUILT_IN from "./themes.json";

export const THEME_FONTS = ["Segoe UI", "Segoe UI Variable", "Calibri", "Bahnschrift", "Verdana", "Inter", "IBM Plex Sans", "Source Sans 3", "Atkinson Hyperlegible", "Noto Sans"] as const;
export const SEVERITY_METHODS = ["border", "header", "background", "headerText", "bookmark"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type SeverityMethod = (typeof SEVERITY_METHODS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Mode = "light" | "dark";
export type ModePref = "system" | Mode;

/** Every colour a theme version must define (the roles of scripts/theme-check.mjs plus its derived colours). */
export const COLOR_KEYS = [
  "bg", "surface", "fg", "muted", "border", "accent", "ok", "warn", "err",
  "low", "medium", "high", "critical", "onAccent", "onOk",
  "lowTint", "onLow", "mediumTint", "onMedium", "highTint", "onHigh", "criticalTint", "onCritical",
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];
export type ThemeColors = Record<ColorKey, string>;

export interface Theme {
  id: string;
  name: string;
  source: string;
  font: (typeof THEME_FONTS)[number];
  size: number;
  lineHeight: number;
  severity: Partial<Record<Mode, SeverityMethod[]>>;
  light?: ThemeColors;
  dark?: ThemeColors;
}

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9-]{1,32}$/;
const TEXT = /^[\p{L}\p{N} .,;:()/'&+@-]{1,200}$/u;

/** Validates one theme strictly (host invariant 14). Throws with the reason; returns a clean copy. */
export function validateTheme(raw: unknown): Theme {
  const t = raw as Record<string, unknown>;
  const fail = (why: string): never => { throw new Error(`invalid theme${typeof t?.id === "string" && ID.test(t.id) ? ` ${t.id}` : ""}: ${why}`); };
  if (!t || typeof t !== "object" || Array.isArray(t)) fail("not an object");
  const allowed = new Set(["id", "name", "source", "font", "size", "lineHeight", "severity", "light", "dark"]);
  for (const k of Object.keys(t)) if (!allowed.has(k)) fail(`unknown field ${k.slice(0, 40)}`);
  if (typeof t.id !== "string" || !ID.test(t.id)) fail("id");
  if (typeof t.name !== "string" || !TEXT.test(t.name) || t.name.length > 40) fail("name");
  if (typeof t.source !== "string" || !TEXT.test(t.source)) fail("source");
  if (typeof t.font !== "string" || !(THEME_FONTS as readonly string[]).includes(t.font)) fail("font not on the list");
  if (typeof t.size !== "number" || !(t.size >= 12 && t.size <= 15)) fail("base size (12-15)");
  if (typeof t.lineHeight !== "number" || !(t.lineHeight >= 1.3 && t.lineHeight <= 1.6)) fail("line spacing (1.3-1.6)");
  const sev = t.severity as Record<string, unknown>;
  if (!sev || typeof sev !== "object" || Array.isArray(sev)) fail("severity");
  const out: Theme = { id: t.id as string, name: t.name as string, source: t.source as string, font: t.font as Theme["font"], size: t.size as number, lineHeight: t.lineHeight as number, severity: {} };
  for (const k of Object.keys(sev)) if (k !== "light" && k !== "dark") fail(`severity: unknown version ${k.slice(0, 20)}`);
  for (const mode of ["light", "dark"] as const) {
    const colors = t[mode] as Record<string, unknown> | undefined;
    const methods = sev[mode];
    if (colors === undefined && methods === undefined) continue;
    if (!colors || typeof colors !== "object" || Array.isArray(colors)) fail(`${mode} colours`);
    if (!Array.isArray(methods) || methods.length < 1 || methods.length > 2) fail(`${mode} severity methods (one or two)`);
    const m = methods as unknown[];
    if (m.some((x) => !(SEVERITY_METHODS as readonly unknown[]).includes(x)) || new Set(m).size !== m.length) fail(`${mode} severity methods: unknown or repeated`);
    for (const k of Object.keys(colors!)) if (!(COLOR_KEYS as readonly string[]).includes(k)) fail(`${mode}: unknown colour ${k.slice(0, 40)}`);
    const c = {} as ThemeColors;
    for (const k of COLOR_KEYS) {
      const v = colors![k];
      if (typeof v !== "string" || !HEX.test(v)) fail(`${mode}.${k} must be #rrggbb`);
      c[k] = (v as string).toLowerCase();
    }
    out[mode] = c;
    out.severity[mode] = [...m] as SeverityMethod[];
  }
  if (!out.light && !out.dark) fail("no light or dark version");
  return out;
}

/** The built-in themes, validated (a broken file fails loudly at start, never reaches a card). */
export const THEMES: readonly Theme[] = Object.freeze((BUILT_IN as unknown[]).map(validateTheme));
export const DEFAULT_THEME_ID = "dashboard";

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME_ID)!;
}

/** Light or dark for this theme: the user's choice or Windows', falling back to the version the theme has. */
export function resolveMode(t: Theme, pref: ModePref, systemDark: boolean): Mode {
  const want: Mode = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  return t[want] ? want : want === "dark" ? "light" : "dark";
}

export function fontStack(font: string): string {
  return `"${font}", "Segoe UI", system-ui, sans-serif`;
}

/** What the app's screens and the card pages need to draw a theme; sent to every window and card. */
export interface ThemeState {
  id: string;
  name: string;
  mode: Mode;
  methods: SeverityMethod[];
  colors: ThemeColors;
  font: { family: string; size: number; lineHeight: number };
}

export function themeState(t: Theme, mode: Mode): ThemeState {
  return { id: t.id, name: t.name, mode, methods: [...(t.severity[mode] ?? ["border"])], colors: { ...t[mode]! }, font: { family: t.font, size: t.size, lineHeight: t.lineHeight } };
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** CSS variables for the app's own screens (dashboard.css, options.css, canvas.css). */
export function appVars(s: ThemeState): Record<string, string> {
  const v: Record<string, string> = {};
  for (const k of COLOR_KEYS) v[`--${kebab(k)}`] = s.colors[k];
  for (const sev of SEVERITIES) v[`--acc-${sev}`] = s.colors[sev];
  v["--font-family"] = fontStack(s.font.family);
  v["--font-size"] = `${s.font.size}px`;
  v["--line-height"] = String(s.font.lineHeight);
  return v;
}

/**
 * CSS variables for a card's page. Keeps the names cards already use (--bg, --link, --sev-*-bg/fg)
 * and adds the theme roles. --bg is the card's background: with the "background" severity method it
 * is the tint of the card's current level. Cards no longer draw severity (THEMES.md); the old
 * --sev-*-bg names stay neutral unless the theme itself tints by severity, where they pass contrast.
 */
export function cardVars(s: ThemeState, accent: string): Record<string, string> {
  const c = s.colors;
  const tinting = s.methods.includes("background");
  const level = (SEVERITIES as readonly string[]).includes(accent) ? (accent as Severity) : null;
  const v: Record<string, string> = {
    "--bg": tinting && level ? c[`${level}Tint`] : c.surface,
    "--surface": c.surface, "--page": c.bg, "--fg": c.fg, "--muted": c.muted, "--border": c.border,
    "--link": c.accent, "--accent": c.accent, "--on-accent": c.onAccent, "--ok": c.ok, "--warn": c.warn, "--err": c.err,
    "--sev-none-bg": c.surface, "--sev-none-fg": c.fg, "--sev-neutral-bg": c.surface, "--sev-neutral-fg": c.fg,
    "--font-family": fontStack(s.font.family), "--font-size": `${s.font.size}px`, "--line-height": String(s.font.lineHeight),
  };
  for (const sev of SEVERITIES) {
    v[`--sev-${sev}`] = c[sev];
    v[`--sev-${sev}-bg`] = tinting ? c[`${sev}Tint`] : c.surface;
    v[`--sev-${sev}-fg`] = c.fg;
  }
  return v;
}

/** What api.ui.theme() returns to a card (spec/host-api.d.ts, ThemeInfo). */
export function themeInfo(s: ThemeState): { id: string; mode: Mode; colors: Record<string, string>; font: ThemeState["font"] } {
  const c = s.colors;
  return {
    id: s.id, mode: s.mode,
    colors: { background: c.surface, page: c.bg, text: c.fg, muted: c.muted, border: c.border, accent: c.accent, ok: c.ok, warning: c.warn, error: c.err, low: c.low, medium: c.medium, high: c.high, critical: c.critical },
    font: { ...s.font },
  };
}
