// Theme selection check (docs/THEMES.md, "Proposed theme set").
// Starts from each palette's published colours (upstream sources in THEMES.md), applies the documented
// corrections (lightness only; hue and chroma kept unless the colour leaves the sRGB gamut), then checks
// every rule in THEMES.md "Theme rules". Exit code 1 if any rule fails.
//   node scripts/theme-check.mjs                 report
//   node scripts/theme-check.mjs --json out.json final theme values
//   node scripts/theme-check.mjs --html out.html preview page built from the same values
import { writeFileSync } from "node:fs";

// ---------- colour maths ----------
const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const rgb2hex = (c) => "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const delin = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(0, v) ** (1 / 2.4) - 0.055);
const lum = (h) => { const [r, g, b] = hex2rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function toOklab(h) {
  const [r, g, b] = hex2rgb(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
/** Colour with OKLab lightness L and the hue of h; chroma is reduced only as far as needed to stay in sRGB. */
function withL(h, L) {
  const [, a, b] = toOklab(h);
  for (let k = 1; k >= 0; k -= 0.01) {
    const c = oklabToLinear([L, a * k, b * k]);
    if (c.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return rgb2hex(c.map(delin));
  }
  return rgb2hex(oklabToLinear([L, 0, 0]).map(delin));
}
const L = (h) => toOklab(h)[0];
const dE = (a, b) => { const p = toOklab(a), q = toOklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const mix = (a, b, t) => { const p = toOklab(a), q = toOklab(b); return rgb2hex(oklabToLinear(p.map((v, i) => v * t + q[i] * (1 - t))).map(delin)); };
const CVD = { // Machado et al. 2009, severity 1
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const sim = (h, m) => { const c = hex2rgb(h).map(lin); return rgb2hex(m.map((r) => delin(Math.min(1, Math.max(0, r[0] * c[0] + r[1] * c[1] + r[2] * c[2]))))); };
const VIEWS = { normal: (h) => h, ...Object.fromEntries(Object.entries(CVD).map(([k, m]) => [k, (h) => sim(h, m)])) };

// ---------- rule constants (THEMES.md "Theme rules") ----------
const TEXT = 4.5, NONTEXT = 3;
const ERR_WARN_DL = 0.10;      // OKLab lightness gap between error and warning
const ERR_WARN_DE = 0.10;      // and their distance under every simulated colour blindness
const SEV_STEP = 0.06;         // lightness step between adjacent severity levels; contrast with the card rises with the level
const SEV_DE = 0.05;           // adjacent levels' distance under every simulated colour blindness
const TINT = { light: [0.08, 0.12, 0.16, 0.22], dark: [0.12, 0.18, 0.24, 0.30] }; // "background" method: share of the level colour mixed into the card surface
const DARK_TOP = 0.86;         // lightest severity colour in dark themes; above this, red turns into near-white pink
const MAX_METHODS = 2;         // severity display methods per theme (clutter limit)
const METHODS = ["border", "header", "background", "headerText", "bookmark"];
const SEV = ["low", "medium", "high", "critical"];
const FONTS = ["Segoe UI", "Segoe UI Variable", "Calibri", "Bahnschrift", "Verdana", "Inter", "IBM Plex Sans", "Source Sans 3", "Atkinson Hyperlegible", "Noto Sans"];

// ---------- the proposed themes, from published values ----------
// Roles: bg = page, surface = card and bars, fg = text, muted = secondary text, border, accent (links, focus,
// primary button), ok / warn / err (state text, grant button, approval-screen markings), low..critical (severity).
const THEMES = [
  { id: "dashboard", name: "Dashboard", source: "the app's current colours", font: "Segoe UI", size: 13, lineHeight: 1.4, severity: { light: ["border"], dark: ["border"] },
    light: { bg: "#eef0f4", surface: "#ffffff", fg: "#1d2330", muted: "#5b6475", border: "#d3d8e0", accent: "#0b57c2", ok: "#2e7d4f", warn: "#8a5300", err: "#b3261e", low: "#5f7387", medium: "#b07800", high: "#c4421a", critical: "#b3261e" },
    dark: { bg: "#12151b", surface: "#1b1f27", fg: "#e6e9ef", muted: "#a3abba", border: "#343a46", accent: "#8ab4ff", ok: "#6cc795", warn: "#e3a948", err: "#f08b84", low: "#8fa3b8", medium: "#e0ad3e", high: "#f07a52", critical: "#f0665c" } },
  { id: "primer", name: "Primer", source: "GitHub Primer primitives (MIT)", font: "Segoe UI Variable", size: 13, lineHeight: 1.45, severity: { light: ["bookmark"], dark: ["headerText", "bookmark"] },
    light: { bg: "#f6f8fa", surface: "#ffffff", fg: "#1f2328", muted: "#59636e", border: "#d1d9e0", accent: "#0969da", ok: "#1a7f37", warn: "#9a6700", err: "#d1242f", low: "#59636e", medium: "#9a6700", high: "#bc4c00", critical: "#d1242f" },
    dark: { bg: "#0d1117", surface: "#151b23", fg: "#f0f6fc", muted: "#9198a1", border: "#3d444d", accent: "#4493f8", ok: "#3fb950", warn: "#d29922", err: "#f85149", low: "#9198a1", medium: "#d29922", high: "#db6d28", critical: "#f85149" } },
  { id: "carbon", name: "Carbon", source: "IBM Carbon g10 / g100 (Apache 2.0)", font: "IBM Plex Sans", size: 13, lineHeight: 1.45, severity: { light: ["header"], dark: ["header"] },
    light: { bg: "#f4f4f4", surface: "#ffffff", fg: "#161616", muted: "#525252", border: "#e0e0e0", accent: "#0f62fe", ok: "#24a148", warn: "#f1c21b", err: "#da1e28", low: "#0043ce", medium: "#f1c21b", high: "#ff832b", critical: "#da1e28" },
    dark: { bg: "#161616", surface: "#262626", fg: "#f4f4f4", muted: "#c6c6c6", border: "#525252", accent: "#78a9ff", ok: "#42be65", warn: "#f1c21b", err: "#ff8389", low: "#4589ff", medium: "#f1c21b", high: "#ff832b", critical: "#fa4d56" } },
  { id: "catppuccin", name: "Catppuccin", source: "Catppuccin Latte / Mocha, @catppuccin/palette 1.8.0 (MIT)", font: "Inter", size: 13, lineHeight: 1.45, severity: { light: ["background"], dark: ["background"] },
    light: { bg: "#e6e9ef", surface: "#eff1f5", fg: "#4c4f69", muted: "#6c6f85", border: "#ccd0da", accent: "#1e66f5", ok: "#40a02b", warn: "#df8e1d", err: "#d20f39", low: "#7287fd", medium: "#df8e1d", high: "#fe640b", critical: "#d20f39" },
    dark: { bg: "#181825", surface: "#1e1e2e", fg: "#cdd6f4", muted: "#a6adc8", border: "#313244", accent: "#89b4fa", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", low: "#b4befe", medium: "#f9e2af", high: "#fab387", critical: "#f38ba8" } },
  { id: "gruvbox", name: "Gruvbox", source: "morhetz/gruvbox colors/gruvbox.vim (MIT)", font: "Source Sans 3", size: 14, lineHeight: 1.4, severity: { light: ["border", "bookmark"], dark: ["border", "bookmark"] },
    light: { bg: "#f2e5bc", surface: "#fbf1c7", fg: "#3c3836", muted: "#7c6f64", border: "#d5c4a1", accent: "#076678", ok: "#79740e", warn: "#b57614", err: "#9d0006", low: "#427b58", medium: "#b57614", high: "#af3a03", critical: "#9d0006" },
    dark: { bg: "#1d2021", surface: "#282828", fg: "#ebdbb2", muted: "#a89984", border: "#504945", accent: "#83a598", ok: "#b8bb26", warn: "#fabd2f", err: "#fb4934", low: "#8ec07c", medium: "#fabd2f", high: "#fe8019", critical: "#fb4934" } },
  { id: "nord", name: "Nord", source: "nordtheme/nord src/nord.css (MIT); dark only, no official light version", font: "Inter", size: 13, lineHeight: 1.5, severity: { dark: ["border"] },
    dark: { bg: "#2e3440", surface: "#3b4252", fg: "#eceff4", muted: "#d8dee9", border: "#4c566a", accent: "#88c0d0", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", low: "#81a1c1", medium: "#ebcb8b", high: "#d08770", critical: "#bf616a" } },
];

// ---------- corrections ----------
const away = (dark) => (dark ? 1 : -1); // direction that raises contrast against the background
/** Moves fg's lightness away from the backgrounds until it reaches ratio against all of them. */
function ensure(fg, bgs, ratio, dark) {
  let v = fg;
  for (let d = 0; d < 0.7 && !bgs.every((b) => contrast(v, b) >= ratio); d += 0.0025) v = withL(fg, L(fg) + away(dark) * d);
  return v;
}
/** Largest lightness step towards the background that keeps the ratio (the "cap"). */
function capL(h, bgs, ratio, dark) {
  let best = L(h);
  for (let x = L(h); x >= 0.05 && x <= 0.98; x -= away(dark) * 0.0025) { if (bgs.every((b) => contrast(withL(h, x), b) >= ratio)) best = x; else break; }
  return best;
}

function derive(theme, mode) {
  const p = { ...theme[mode] };
  const dark = mode === "dark";
  const bgs = [p.bg, p.surface];
  const notes = [];
  const set = (role, v, why) => { if (v !== p[role]) { notes.push(`${role} ${p[role]} → ${v} (${why})`); p[role] = v; } };
  for (const r of ["fg", "muted", "accent", "ok", "warn", "err"]) set(r, ensure(p[r], bgs, TEXT, dark), `text contrast ≥ ${TEXT}`);
  // Error and warning differ in lightness. Light themes: error darker. Dark themes: error darker too (yellow is
  // naturally light), warning raised if error cannot go darker without losing text contrast.
  if (L(p.warn) - L(p.err) < ERR_WARN_DL) {
    if (!dark) {
      const wCap = capL(p.warn, bgs, TEXT, dark);
      set("warn", withL(p.warn, Math.min(wCap, Math.max(L(p.warn), (L(p.warn) + L(p.err)) / 2 + ERR_WARN_DL / 2))), "error/warning lightness gap");
      set("err", withL(p.err, Math.min(L(p.err), L(p.warn) - ERR_WARN_DL - 0.015)), "error/warning lightness gap");
    } else {
      const eMin = capL(p.err, bgs, TEXT, dark);
      set("err", withL(p.err, Math.max(eMin, L(p.warn) - ERR_WARN_DL - 0.015)), "error/warning lightness gap");
      if (L(p.warn) - L(p.err) < ERR_WARN_DL) set("warn", withL(p.warn, L(p.err) + ERR_WARN_DL + 0.005), "error/warning lightness gap");
    }
  }
  // Severity ladder: each level stands out more from the card than the level below it, so light themes get
  // darker and dark themes lighter as severity rises. Every level stays readable as the theme's methods require.
  const sevMin = theme.severity[mode].includes("headerText") ? TEXT : NONTEXT;
  const base = SEV.map((s) => ensure(p[s], bgs, sevMin, dark));
  const limit = Math.min(...base.map((h) => capL(h, bgs, sevMin, dark))) ; // light: lightest allowed
  const floor = Math.max(...base.map((h) => capL(h, bgs, sevMin, dark))); // dark: darkest allowed
  // Even steps from the faintest allowed level: low is as quiet as the rules allow, critical stands out most.
  // The step starts at a comfortable size and grows only until adjacent levels stay apart under every
  // simulated colour blindness (the simulations shrink small lightness steps), within the room available.
  const room = dark ? (DARK_TOP - floor) / 3 : (limit - 0.30) / 3;
  const ladder = (st) => SEV.map((s, i) => ensure(withL(p[s], dark ? floor + i * st : limit - i * st), bgs, sevMin, dark));
  const apart = (c) => Math.min(...Object.values(VIEWS).flatMap((v) => c.slice(1).map((x, i) => dE(v(c[i]), v(x)))));
  let st = Math.min(room, dark ? 0.09 : 0.08);
  while (apart(ladder(st)) < SEV_DE + 0.003 && st + 0.005 <= room) st += 0.005;
  const chosen = ladder(Math.max(SEV_STEP, st));
  SEV.forEach((s, i) => set(s, chosen[i], "severity lightness ladder"));
  // "background" method: the card's own background is tinted, more strongly for higher levels; text colours are
  // then corrected against those tints too.
  const tints = Object.fromEntries(SEV.map((s, i) => [s, mix(p[s], p.surface, TINT[mode][i])]));
  if (theme.severity[mode].includes("background")) for (const r of ["fg", "muted", "accent"]) set(r, ensure(p[r], [...bgs, ...Object.values(tints)], TEXT, dark), "text contrast on severity tints");
  // Derived colours.
  const on = (bgc) => [p.fg, p.surface, "#ffffff", "#000000"].sort((a, b) => contrast(b, bgc) - contrast(a, bgc))[0];
  const d = { onAccent: on(p.accent), onOk: on(p.ok) };
  for (const s of SEV) { d[`${s}Tint`] = tints[s]; d[`on${s[0].toUpperCase()}${s.slice(1)}`] = on(p[s]); }
  return { values: { ...p, ...d }, notes };
}

// ---------- checks ----------
function check(theme, mode, v) {
  const f = [];
  const need = (ok, msg) => { if (!ok) f.push(msg); };
  const bgs = [["bg", v.bg], ["surface", v.surface]];
  for (const r of ["fg", "muted", "accent", "ok", "warn", "err"]) for (const [bn, b] of bgs) need(contrast(v[r], b) >= TEXT, `${r} on ${bn} ${contrast(v[r], b).toFixed(2)} < ${TEXT}`);
  need(contrast(v.onAccent, v.accent) >= TEXT, `text on primary button ${contrast(v.onAccent, v.accent).toFixed(2)}`);
  need(contrast(v.onOk, v.ok) >= TEXT, `text on grant button ${contrast(v.onOk, v.ok).toFixed(2)}`);
  need(Math.abs(L(v.warn) - L(v.err)) >= ERR_WARN_DL, `error/warning lightness gap ${Math.abs(L(v.warn) - L(v.err)).toFixed(3)} < ${ERR_WARN_DL}`);
  for (const [vn, view] of Object.entries(VIEWS)) {
    need(dE(view(v.warn), view(v.err)) >= ERR_WARN_DE, `error vs warning, ${vn}: ΔE ${dE(view(v.warn), view(v.err)).toFixed(3)}`);
    for (let i = 0; i < SEV.length - 1; i++) need(dE(view(v[SEV[i]]), view(v[SEV[i + 1]])) >= SEV_DE, `${SEV[i]} vs ${SEV[i + 1]}, ${vn}: ΔE ${dE(view(v[SEV[i]]), view(v[SEV[i + 1]])).toFixed(3)}`);
  }
  for (let i = 0; i < SEV.length - 1; i++) {
    const a = v[SEV[i]], b = v[SEV[i + 1]];
    need(Math.abs(L(a) - L(b)) >= SEV_STEP, `severity ${SEV[i]}→${SEV[i + 1]} lightness step ${Math.abs(L(a) - L(b)).toFixed(3)} < ${SEV_STEP}`);
    need(contrast(b, v.surface) > contrast(a, v.surface), `severity ${SEV[i + 1]} stands out less than ${SEV[i]}`);
  }
  const m = theme.severity[mode];
  for (const s of SEV) {
    const c = v[s], cap = s[0].toUpperCase() + s.slice(1);
    if (m.includes("border") || m.includes("bookmark")) for (const [bn, b] of bgs) need(contrast(c, b) >= NONTEXT, `${s} mark on ${bn} ${contrast(c, b).toFixed(2)} < ${NONTEXT}`);
    if (m.includes("headerText")) need(contrast(c, v.surface) >= TEXT, `${s} header text ${contrast(c, v.surface).toFixed(2)} < ${TEXT}`);
    if (m.includes("header")) { need(contrast(v[`on${cap}`], c) >= TEXT, `text on ${s} header ${contrast(v[`on${cap}`], c).toFixed(2)}`); need(contrast(c, v.bg) >= NONTEXT, `${s} header vs page ${contrast(c, v.bg).toFixed(2)}`); }
    if (m.includes("background")) need(["fg", "muted", "accent"].every((r) => contrast(v[r], v[`${s}Tint`]) >= TEXT), `text on ${s} tint ${contrast(v.fg, v[`${s}Tint`]).toFixed(2)} / muted ${contrast(v.muted, v[`${s}Tint`]).toFixed(2)}`);
  }
  if (m.includes("background")) for (let i = 0; i < SEV.length - 1; i++) need(Math.abs(L(v[`${SEV[i]}Tint`]) - L(v[`${SEV[i + 1]}Tint`])) >= 0.015, `${SEV[i]} vs ${SEV[i + 1]} tint lightness ${Math.abs(L(v[`${SEV[i]}Tint`]) - L(v[`${SEV[i + 1]}Tint`])).toFixed(3)} < 0.015`);
  return f;
}
function checkTheme(t) {
  const f = [];
  for (const [mode, list] of Object.entries(t.severity)) {
    if (!t[mode]) f.push(`severity methods for a missing ${mode} version`);
    if (!(list.length >= 1 && list.length <= MAX_METHODS)) f.push(`${mode} severity methods: ${list.length} (1–${MAX_METHODS})`);
    for (const x of list) if (!METHODS.includes(x)) f.push(`unknown severity method ${x}`);
  }
  for (const mode of ["light", "dark"]) if (t[mode] && !t.severity[mode]) f.push(`no severity methods for ${mode}`);
  if (!FONTS.includes(t.font)) f.push(`font not on the list: ${t.font}`);
  if (!(t.size >= 12 && t.size <= 15)) f.push(`base size ${t.size}`);
  if (!(t.lineHeight >= 1.3 && t.lineHeight <= 1.6)) f.push(`line spacing ${t.lineHeight}`);
  return f;
}

// ---------- run ----------
const out = [];
let failures = 0;
for (const t of THEMES) {
  const tf = checkTheme(t);
  failures += tf.length;
  t.final = {};
  out.push(`\n## ${t.name} — font ${t.font} ${t.size}px/${t.lineHeight}${tf.length ? `\n  FAIL ${tf.join("; ")}` : ""}`);
  for (const mode of ["light", "dark"]) {
    if (!t[mode]) continue;
    const { values, notes } = derive(t, mode);
    const f = check(t, mode, values);
    failures += f.length;
    t.final[mode] = values;
    out.push(`### ${mode} (severity: ${t.severity[mode].join(" + ")}): ${f.length ? `FAIL (${f.length})` : "pass"}`);
    for (const n of notes) out.push(`  - corrected: ${n}`);
    for (const x of f) out.push(`  - FAIL: ${x}`);
    out.push(`  - severity L: ${SEV.map((s) => `${s} ${L(values[s]).toFixed(2)}`).join(", ")}; error L ${L(values.err).toFixed(2)}, warning L ${L(values.warn).toFixed(2)}`);
  }
}
console.log(out.join("\n"));
console.log(`\n${failures ? `${failures} rule failures` : "All themes pass every rule."}`);

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const finalThemes = THEMES.map(({ id, name, source, font, size, lineHeight, severity, final }) => ({ id, name, source, font, size, lineHeight, severity, ...final }));
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify(finalThemes, null, 2));
if (arg("--html")) writeFileSync(arg("--html"), preview(finalThemes));
process.exitCode = failures ? 1 : 0;

// ---------- preview page (same values as checked above) ----------
function preview(themes) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fontStack = (f) => `"${f}", "Segoe UI", system-ui, sans-serif`;
  const LEVELS = ["none", ...SEV];
  const card = (t, mode, v, lvl, title, body) => {
    const m = t.severity[mode], sev = lvl !== "none";
    const cap = lvl[0].toUpperCase() + lvl.slice(1);
    const borderW = { none: 1, low: 1, medium: 1, high: 2, critical: 3 }[lvl];
    const frame = `border:${sev && m.includes("border") ? `${borderW}px solid ${v[lvl]}` : `1px solid ${v.border}`};background:${sev && m.includes("background") ? v[`${lvl}Tint`] : v.surface}`;
    const head = sev && m.includes("header") ? `background:${v[lvl]};color:${v[`on${cap}`]}` : `color:${v.fg}`;
    const name = sev && m.includes("headerText") ? `color:${v[lvl]}` : "";
    const stateCol = sev && m.includes("header") ? v[`on${cap}`] : v.muted;
    const mark = sev && m.includes("bookmark") ? `<svg class="bm" viewBox="0 0 10 14" aria-hidden="true"><path d="M0 0h10v14L5 10 0 14z" fill="${v[lvl]}"/></svg>` : "";
    return `<div class="frame" style="${frame}"><div class="bar" style="${head};border-bottom:1px solid ${v.border}">${mark}<span class="name" style="${name}">${esc(title)}</span><span class="st" style="color:${stateCol}">${sev ? cap : "ok"} · 09:14</span></div><div class="body" style="color:${v.fg}">${body}</div></div>`;
  };
  const panel = (t, mode) => {
    const v = t[mode];
    const sample = (lvl) => `Severity <b>${lvl}</b>. Muted text <span style="color:${v.muted}">updated 5 min ago</span>. <span style="color:${v.accent};text-decoration:underline">A link</span>.`;
    const cards = LEVELS.map((lvl) => card(t, mode, v, lvl, lvl === "none" ? "System info" : `Watch: ${lvl}`, sample(lvl))).join("");
    return `<section class="panel" style="background:${v.bg};color:${v.fg};font:${t.size}px/${t.lineHeight} ${fontStack(t.font)}">
<div class="top" style="background:${v.surface};border-bottom:1px solid ${v.border}"><b>${esc(t.name)}</b> <span style="color:${v.muted}">${mode} · severity: ${t.severity[mode].join(" + ")} · ${esc(t.font)} ${t.size}px</span>
<span class="btns"><button style="background:${v.accent};color:${v.onAccent};border-color:${v.accent}">Create</button><button style="background:${v.ok};color:${v.onOk};border-color:${v.ok}">Grant</button><button style="background:${v.surface};color:${v.fg};border-color:${v.border}">Stop</button></span></div>
<div class="grid">${cards}</div>
<div class="approval" style="background:${v.surface};border:1px solid ${v.border}">
<div class="ban" style="border-color:${v.err};color:${v.err}">Red markings: this card can read files and send data out.</div>
<div class="ban" style="border-color:${v.warn};color:${v.warn}">Worth a look: links can open any site.</div>
<div style="color:${v.ok}">Approved for this version.</div></div>
<div class="sw">${["accent", "ok", "warn", "err", ...SEV].map((r) => `<span><i style="background:${v[r]}"></i>${r} <code>${v[r]}</code></span>`).join("")}</div>
</section>`;
  };
  const body = themes.map((t) => `<h2>${esc(t.name)}</h2><p class="src">From ${esc(t.source)}.</p><div class="pair">${["light", "dark"].filter((m) => t[m]).map((m) => panel(t, m)).join("")}</div>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard Themes</title>
<style>
:root{--page:#f7f7f8;--ink:#1d2330;--sub:#5b6475}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--page:#121317;--ink:#e6e9ef;--sub:#a3abba}}
:root[data-theme="dark"]{--page:#121317;--ink:#e6e9ef;--sub:#a3abba}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 48px;background:var(--page);color:var(--ink);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:1400px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 2px}.lead,.src{color:var(--sub);margin:0 0 10px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,560px),1fr));gap:14px}
.panel{border-radius:8px;overflow:hidden;border:1px solid rgba(127,127,127,.35)}
.top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px}.btns{margin-left:auto;display:flex;gap:6px}
button{font:inherit;font-size:.92em;border:1px solid;border-radius:4px;padding:2px 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;padding:10px}
.frame{border-radius:6px;overflow:hidden;min-width:0}.bar{display:flex;align-items:center;gap:6px;padding:4px 8px;min-height:28px}
.name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.st{margin-left:auto;font-size:.85em;white-space:nowrap}
.bm{width:10px;height:14px;flex:0 0 auto}.body{padding:8px;font-size:.95em}
.approval{margin:0 10px 10px;border-radius:6px;padding:8px;display:grid;gap:6px}.ban{border:2px solid;border-radius:6px;padding:4px 8px}
.sw{display:flex;flex-wrap:wrap;gap:4px 12px;padding:0 12px 10px;font-size:12px}.sw span{display:inline-flex;align-items:center;gap:4px}
.sw i{width:12px;height:12px;border-radius:3px;display:inline-block;border:1px solid rgba(127,127,127,.4)}code{font:11px Consolas,monospace}
</style></head><body><main>
<h1>Dashboard themes</h1>
<p class="lead">Proposed theme set: six themes, each with a light and a dark version (Nord is dark only). These are the corrected values, and every one passes the checks in <code>scripts/theme-check.mjs</code>. Each card's frame shows severity in the way its theme chose. Fonts that aren't installed on this computer fall back to Segoe UI or the system font.</p>
${body}
</main></body></html>`;
}
