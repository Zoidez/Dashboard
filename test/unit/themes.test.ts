/**
 * Themes (docs/THEMES.md; RULES.md host invariant 14).
 * - scripts/theme-check.mjs passes every contrast, brightness and colour-blindness rule (approval-screen
 *   red and yellow included), and src/shared/themes.json is exactly what it derives.
 * - Theme values are checked strictly: anything but #rrggbb, a listed font, numbers in range and known
 *   severity methods is rejected, so a theme cannot inject CSS into card pages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appVars, cardVars, resolveMode, themeById, themeState, THEMES, validateTheme } from "../../src/shared/theme.js";

const REPO = resolve(__dirname, "..", "..");

test("theme-check passes every rule and themes.json is what it derives", () => {
  const out = join(mkdtempSync(join(tmpdir(), "themes-")), "themes.json");
  const r = spawnSync(process.execPath, [join(REPO, "scripts", "theme-check.mjs"), "--json", out], { encoding: "utf8" });
  assert.equal(r.status, 0, `theme-check failed:\n${r.stdout.split("\n").filter((l) => l.includes("FAIL")).join("\n")}`);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), JSON.parse(readFileSync(join(REPO, "src", "shared", "themes.json"), "utf8")),
    "src/shared/themes.json is stale: run node scripts/theme-check.mjs --json src/shared/themes.json");
});

test("the six approved themes load and pass the strict value check", () => {
  assert.deepEqual(THEMES.map((t) => t.id), ["dashboard", "primer", "carbon", "catppuccin", "gruvbox", "nord"]);
  for (const t of THEMES) assert.deepEqual(validateTheme(JSON.parse(JSON.stringify(t))), t);
  assert.equal(themeById("nord").light, undefined, "Nord is dark only");
});

test("loose theme values are rejected (no CSS injection into card pages)", () => {
  const good = () => JSON.parse(JSON.stringify(themeById("dashboard"))) as Record<string, any>;
  const bad: Array<[string, (t: Record<string, any>) => void]> = [
    ["colour name", (t) => { t.light.fg = "red"; }],
    ["short hex", (t) => { t.light.fg = "#fff"; }],
    ["CSS injection in a colour", (t) => { t.light.fg = "#123456;}body{background:url(https://x)"; }],
    ["url() as a colour", (t) => { t.dark.bg = "url(https://example.com/x.png)"; }],
    ["unknown colour key", (t) => { t.light.extra = "#000000"; }],
    ["missing colour", (t) => { delete t.light.err; }],
    ["unknown field", (t) => { t.css = "body{}"; }],
    ["font not on the list", (t) => { t.font = "Comic Sans MS"; }],
    ["font with CSS", (t) => { t.font = 'Inter"; } body { x: "'; }],
    ["size too large", (t) => { t.size = 16; }],
    ["size as text", (t) => { t.size = "13px"; }],
    ["line spacing out of range", (t) => { t.lineHeight = 2; }],
    ["three severity methods", (t) => { t.severity.light = ["border", "bookmark", "header"]; }],
    ["unknown severity method", (t) => { t.severity.dark = ["glow"]; }],
    ["repeated severity method", (t) => { t.severity.dark = ["border", "border"]; }],
    ["no methods for a version", (t) => { delete t.severity.dark; }],
    ["bad id", (t) => { t.id = "../x"; }],
    ["markup in the name", (t) => { t.name = "<b>x</b>"; }],
  ];
  for (const [why, mutate] of bad) {
    const t = good();
    mutate(t);
    assert.throws(() => validateTheme(t), /invalid theme/, why);
  }
});

test("every CSS variable sent to pages passes the pages' own value filter", () => {
  const NAME = /^--[a-z0-9-]{1,40}$/, VALUE = /^[#\w\s",.()-]{1,200}$/;   // src/preload/theme.ts, src/card-runtime/runtime.ts
  for (const t of THEMES) for (const mode of ["light", "dark"] as const) {
    if (!t[mode]) continue;
    const s = themeState(t, mode);
    for (const vars of [appVars(s), ...["neutral", "low", "medium", "high", "critical"].map((a) => cardVars(s, a))])
      for (const [k, v] of Object.entries(vars)) { assert.match(k, NAME, `${t.id} ${mode} ${k}`); assert.match(v, VALUE, `${t.id} ${mode} ${k}=${v}`); }
  }
});

test("the card background shows severity only where the theme uses the background method", () => {
  const cat = themeState(themeById("catppuccin"), "light");
  assert.equal(cardVars(cat, "critical")["--bg"], cat.colors.criticalTint);
  assert.equal(cardVars(cat, "neutral")["--bg"], cat.colors.surface);
  const dash = themeState(themeById("dashboard"), "light");
  assert.equal(cardVars(dash, "critical")["--bg"], dash.colors.surface);
  assert.equal(cardVars(dash, "critical")["--sev-critical-bg"], dash.colors.surface, "old cards' own severity fills stay neutral");
});

test("light or dark: the user's choice, else Windows, else the version the theme has", () => {
  assert.equal(resolveMode(themeById("dashboard"), "system", true), "dark");
  assert.equal(resolveMode(themeById("dashboard"), "system", false), "light");
  assert.equal(resolveMode(themeById("dashboard"), "light", true), "light");
  assert.equal(resolveMode(themeById("nord"), "light", false), "dark");
  assert.equal(themeById("no-such-theme").id, "dashboard");
});
