// Palette research (docs/THEMES.md): map candidate palettes onto the Dashboard's colour roles and measure them.
// Text pairs: WCAG 2.x contrast >= 4.5. Non-text (frame accents): >= 3. Distinctness: OKLab distance,
// also under simulated protanopia / deuteranopia / tritanopia (Machado et al. 2009, severity 1).

const hex2rgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const rgb2hex = (c) => "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const delin = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const lum = (h) => { const [r, g, b] = hex2rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function toOklab(h) {
  const [r, g, b] = hex2rgb(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return rgb2hex([4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(delin));
}
const dE = (a, b) => { const p = toOklab(a), q = toOklab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const mix = (a, b, t) => { const p = toOklab(a), q = toOklab(b); return fromOklab(p.map((v, i) => v * t + q[i] * (1 - t))); };

const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const sim = (h, m) => { const c = hex2rgb(h).map(lin); return rgb2hex(m.map((row) => delin(Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))))); };

/** Moves a foreground colour's lightness (keeping hue and chroma) until it reaches the ratio against bg. */
function fix(fg, bg, ratio, dark) {
  if (contrast(fg, bg) >= ratio) return { value: fg, dL: 0 };
  const [L, a, b] = toOklab(fg);
  for (let d = 0.005; d < 0.6; d += 0.005) {
    const v = fromOklab([L + (dark ? d : -d), a, b]);
    if (contrast(v, bg) >= ratio) return { value: v, dL: +d.toFixed(3) };
  }
  return { value: fg, dL: NaN };
}

// Candidate palettes, mapped onto the Dashboard's roles. Sources and licences: docs/THEMES.md.
// Run: node scripts/palette-research.mjs
const C = {
  "Dashboard (current)": {
    light: { bg: "#eef0f4", surface: "#ffffff", fg: "#1d2330", muted: "#5b6475", border: "#d3d8e0", accent: "#0b57c2", ok: "#2e7d4f", warn: "#8a5300", err: "#b3261e", low: "#5f7387", medium: "#b07800", high: "#c4421a", critical: "#b3261e" },
    dark: { bg: "#12151b", surface: "#1b1f27", fg: "#e6e9ef", muted: "#a3abba", border: "#343a46", accent: "#8ab4ff", ok: "#6cc795", warn: "#e3a948", err: "#f08b84", low: "#8fa3b8", medium: "#e0ad3e", high: "#f07a52", critical: "#f0665c" },
  },
  "GitHub Primer": {
    light: { bg: "#f6f8fa", surface: "#ffffff", fg: "#1f2328", muted: "#59636e", border: "#d1d9e0", accent: "#0969da", ok: "#1a7f37", warn: "#9a6700", err: "#d1242f", low: "#59636e", medium: "#9a6700", high: "#bc4c00", critical: "#d1242f" },
    dark: { bg: "#0d1117", surface: "#151b23", fg: "#f0f6fc", muted: "#9198a1", border: "#3d444d", accent: "#4493f8", ok: "#3fb950", warn: "#d29922", err: "#f85149", low: "#9198a1", medium: "#d29922", high: "#db6d28", critical: "#f85149" },
  },
  "IBM Carbon (g10 / g100)": {
    light: { bg: "#f4f4f4", surface: "#ffffff", fg: "#161616", muted: "#525252", border: "#e0e0e0", accent: "#0f62fe", ok: "#24a148", warn: "#f1c21b", err: "#da1e28", low: "#0043ce", medium: "#f1c21b", high: "#ff832b", critical: "#da1e28" },
    dark: { bg: "#161616", surface: "#262626", fg: "#f4f4f4", muted: "#c6c6c6", border: "#525252", accent: "#78a9ff", ok: "#42be65", warn: "#f1c21b", err: "#ff8389", low: "#4589ff", medium: "#f1c21b", high: "#ff832b", critical: "#fa4d56" },
  },
  Nord: {
    light: { bg: "#e5e9f0", surface: "#eceff4", fg: "#2e3440", muted: "#4c566a", border: "#d8dee9", accent: "#5e81ac", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", low: "#81a1c1", medium: "#ebcb8b", high: "#d08770", critical: "#bf616a" },
    dark: { bg: "#2e3440", surface: "#3b4252", fg: "#eceff4", muted: "#d8dee9", border: "#434c5e", accent: "#88c0d0", ok: "#a3be8c", warn: "#ebcb8b", err: "#bf616a", low: "#81a1c1", medium: "#ebcb8b", high: "#d08770", critical: "#bf616a" },
  },
  Solarized: {
    light: { bg: "#eee8d5", surface: "#fdf6e3", fg: "#586e75", muted: "#657b83", border: "#93a1a1", accent: "#268bd2", ok: "#859900", warn: "#b58900", err: "#dc322f", low: "#2aa198", medium: "#b58900", high: "#cb4b16", critical: "#dc322f" },
    dark: { bg: "#002b36", surface: "#073642", fg: "#93a1a1", muted: "#839496", border: "#586e75", accent: "#268bd2", ok: "#859900", warn: "#b58900", err: "#dc322f", low: "#2aa198", medium: "#b58900", high: "#cb4b16", critical: "#dc322f" },
  },
  "Catppuccin (Latte / Mocha)": {
    light: { bg: "#e6e9ef", surface: "#eff1f5", fg: "#4c4f69", muted: "#6c6f85", border: "#ccd0da", accent: "#1e66f5", ok: "#40a02b", warn: "#df8e1d", err: "#d20f39", low: "#7287fd", medium: "#df8e1d", high: "#fe640b", critical: "#d20f39" },
    dark: { bg: "#181825", surface: "#1e1e2e", fg: "#cdd6f4", muted: "#a6adc8", border: "#313244", accent: "#89b4fa", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", low: "#b4befe", medium: "#f9e2af", high: "#fab387", critical: "#f38ba8" },
  },
  Gruvbox: {
    light: { bg: "#f2e5bc", surface: "#fbf1c7", fg: "#3c3836", muted: "#7c6f64", border: "#d5c4a1", accent: "#076678", ok: "#79740e", warn: "#b57614", err: "#9d0006", low: "#427b58", medium: "#b57614", high: "#af3a03", critical: "#9d0006" },
    dark: { bg: "#1d2021", surface: "#282828", fg: "#ebdbb2", muted: "#a89984", border: "#504945", accent: "#83a598", ok: "#b8bb26", warn: "#fabd2f", err: "#fb4934", low: "#8ec07c", medium: "#fabd2f", high: "#fe8019", critical: "#fb4934" },
  },
};

const SEV = ["low", "medium", "high", "critical"];
const out = [];
const summary = [];
for (const [name, modes] of Object.entries(C)) {
  out.push(`\n## ${name}`);
  const row = { name };
  for (const [mode, p] of Object.entries(modes)) {
    const dark = mode === "dark";
    // Card severity backgrounds: the level's hue mixed into the surface; text is the palette's text.
    const sevBg = Object.fromEntries(SEV.map((s) => [s, mix(p[s], p.surface, dark ? 0.24 : 0.16)]));
    const text = [
      ["fg on bg", "fg", p.bg], ["fg on surface", "fg", p.surface], ["muted on bg", "muted", p.bg], ["muted on surface", "muted", p.surface],
      ["accent (links) on surface", "accent", p.surface], ["ok text", "ok", p.surface], ["warn text", "warn", p.surface], ["err text", "err", p.surface],
      ...SEV.map((s) => [`text on ${s} card`, "fg", sevBg[s]]),
    ];
    const fails = [];
    const fixed = { ...p };
    for (const [label, role, bg] of text) {
      const r = contrast(p[role], bg);
      if (r < 4.5) {
        const f = fix(fixed[role], bg, 4.5, dark);
        fixed[role] = f.value;
        fails.push(`${label} ${r.toFixed(2)} -> ${role} ${p[role]}→${f.value} (ΔL ${f.dL})`);
      }
    }
    const buttons = [["text on primary button", fixed.surface, fixed.accent], ["text on grant button", fixed.surface, fixed.ok]]
      .map(([l, a, b]) => [l, contrast(a, b)]).filter(([, r]) => r < 4.5).map(([l, r]) => `${l} ${r.toFixed(2)} (needs a darker/lighter button or other text colour)`);
    const nontext = SEV.map((s) => [s, contrast(fixed[s], fixed.surface)]).filter(([, r]) => r < 3).map(([s, r]) => `${s} frame accent ${r.toFixed(2)} < 3`);
    // Distinctness, after fixes, normal vision and simulated colour blindness.
    const pairs = [["err", "warn"], ["err", "accent"], ["warn", "accent"]];
    const sevPairs = [["low", "medium"], ["medium", "high"], ["high", "critical"]];
    const minOver = (list, view) => Math.min(...list.map(([a, b]) => dE(view(fixed[a]), view(fixed[b]))));
    const views = { normal: (h) => h, ...Object.fromEntries(Object.entries(CVD).map(([k, m]) => [k, (h) => sim(h, m)])) };
    const dist = Object.entries(views).map(([k, v]) => `${k} ${minOver(pairs, v).toFixed(3)}/${minOver(sevPairs, v).toFixed(3)}`).join(", ");
    const worstSignal = Math.min(...Object.values(views).map((v) => minOver(pairs, v)));
    const worstSev = Math.min(...Object.values(views).map((v) => minOver(sevPairs, v)));
    out.push(`\n### ${mode}\n- text pairs failing AA as published: **${fails.length}** of ${text.length}`);
    for (const f of fails) out.push(`  - ${f}`);
    for (const b of buttons) out.push(`  - ${b}`);
    for (const n of nontext) out.push(`  - ${n}`);
    out.push(`- distinctness (OKLab ΔE, min over err/warn/accent pairs / adjacent severity levels): ${dist}`);
    out.push(`- adjusted roles: ${JSON.stringify(Object.fromEntries(Object.entries(fixed).filter(([k, v]) => v !== p[k])))}`);
    row[mode] = { fails: fails.length, buttons: buttons.length, nontext: nontext.length, worstSignal: +worstSignal.toFixed(3), worstSev: +worstSev.toFixed(3) };
  }
  summary.push(row);
}
console.log("| Palette | light: AA fails / buttons / frames | light: min ΔE signal / severity | dark: AA fails / buttons / frames | dark: min ΔE signal / severity |");
console.log("|---|---|---|---|---|");
for (const r of summary) console.log(`| ${r.name} | ${r.light.fails} / ${r.light.buttons} / ${r.light.nontext} | ${r.light.worstSignal} / ${r.light.worstSev} | ${r.dark.fails} / ${r.dark.buttons} / ${r.dark.nontext} | ${r.dark.worstSignal} / ${r.dark.worstSev} |`);
console.log(out.join("\n"));
