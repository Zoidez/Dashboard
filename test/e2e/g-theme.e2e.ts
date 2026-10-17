/**
 * Themes (docs/THEMES.md): the grid and every card page take their colours from the one theme definition;
 * a theme change reaches running cards at once (api.ui.onThemeChange, CSS variables replaced in place);
 * the grid draws severity with the theme's methods; with the "background" method the card's own
 * background shows its level.
 */
import { test, expect } from "@playwright/test";
import { addCard, cardStorage, launch, makeInstance, ready, waitFor } from "./helpers";
import THEMES from "../../src/shared/themes.json";

const UI = `
export async function mount(el, api) {
  const results = {};
  const save = async (k, v) => { results[k] = v; await api.storage.set("results", results); };
  el.textContent = "theme probe";
  await save("initial", api.ui.theme());
  api.ui.onThemeChange(async (t) => {
    await save("changed", t);
    await save("bg", getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    // The theme's font ships with the app and is served to the card page (/__host/fonts/).
    await save("fontFaces", (await document.fonts.load('600 13px "' + t.font.family + '"')).length);
  });
  api.ui.setAccent("critical");
  api.ui.setStatus({ state: "ok" });
}
`;

test("G: a theme change reaches the grid and running cards live", async () => {
  const inst = makeInstance();
  addCard(inst, { id: "theme-probe", ui: UI });
  const app = await launch(inst);
  try {
    await ready(app);
    const page = await app.firstWindow();
    const dash = THEMES.find((t) => t.id === "dashboard")!;
    const cat = THEMES.find((t) => t.id === "catppuccin")!;
    const results = () => (cardStorage(inst, "theme-probe")?.results ?? null) as Record<string, any> | null;

    // Start: the default theme, from the same definition in the grid and in the card.
    const initial = (await waitFor(() => results()?.initial, "the card's first theme")) as Record<string, any>;
    expect(initial.id).toBe("dashboard");
    const mode = initial.mode as "light" | "dark";
    expect(initial.colors.background).toBe(dash[mode]!.surface);
    await waitFor(async () => (await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface"))) || null, "grid theme variables");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface"))).toBe(dash[mode]!.surface);
    expect(await page.evaluate(() => document.documentElement.dataset.sev)).toBe("border");

    // Switch to Catppuccin light (as Options does): grid and card change without a restart.
    await app.evaluate(() => { const d = (globalThis as any).__dashboard; d.options.setGeneral({ theme: "catppuccin", themeMode: "light" }); d.themes.changed(); });
    const changed = (await waitFor(() => results()?.changed, "the card's theme-change event")) as Record<string, any>;
    expect(changed.id).toBe("catppuccin");
    expect(changed.mode).toBe("light");
    expect(changed.colors.background).toBe(cat.light!.surface);
    expect(changed.font.family).toBe("Inter");
    await waitFor(() => (results()?.fontFaces > 0 ? true : null), "Inter loaded inside the card page");
    expect(await page.evaluate(async () => (await document.fonts.load('600 13px "Inter"')).length)).toBeGreaterThan(0);
    // Catppuccin shows severity as the card's background: the card set "critical", so its page is tinted.
    await waitFor(() => (results()?.bg === cat.light!.criticalTint ? true : null), "the critical tint as the card background");

    await waitFor(async () => ((await page.evaluate(() => document.documentElement.dataset.sev)) === "background" ? true : null), "grid severity method");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--surface"))).toBe(cat.light!.surface);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    const frameBg = await page.locator('section[data-card="theme-probe"]').evaluate((el) => getComputedStyle(el).backgroundColor);
    const hex = (rgb: string) => "#" + (rgb.match(/\d+/g) ?? []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
    expect(hex(frameBg)).toBe(cat.light!.criticalTint);

    // The saved setting survives: options.json holds the choice.
    const saved = await app.evaluate(() => (globalThis as any).__dashboard.options.general);
    expect(saved.theme).toBe("catppuccin");
    expect(saved.themeMode).toBe("light");
  } finally {
    await app.close();
  }
});
