# Dashboard — Themes (colours and fonts)

**Status: research done 2026-10-16; themes not chosen, nothing built.** The Podman migration waits until this is finished (user decision 2026-10-16).

## Scope (user decisions 2026-10-16)
- **In:** colour themes and font settings for the app's screens and for cards.
- **Out:** layout density (borders, title bars, spacing). Clutter is acceptable as it is; the rework must not add to it.
- A theme sets **colours, typeface, base size and line spacing**. Nothing per element.

## What the code has today
- **App screens** take their colours from 17 named colours in `src/renderer/dashboard.css`, with one light and one dark set chosen by Windows (`prefers-color-scheme`). Hard-coded: the white toggle knob and a black menu shadow.
- **Card pages** get a second, separate palette written by `card-host.ts` (`indexHtml`) when the card loads. It has drifted from the first (border colours differ). A card picks light or dark once and never updates.
- **Card API:** `api.ui.theme()` returns only `{ mode }`. There is no theme-change event.
- **Font sizes** are fixed pixel values in `dashboard.css`, `options.css` and `canvas.css` (16, 14, 12, 11 px …). Cards get `font: 13px/1.4 "Segoe UI"` from `card-host.ts`.
- **Installed cards (2026-10-16):**

  | Card | Hard-coded colours | Theme colours | Fixed px font sizes |
  |---|---|---|---|
  | the three feed cards | 0 | 15 each | 3 each |
  | Ulam spiral | 3 (see-through fills) | 3 | 5 |
  | small-displaying-number | 0 | 0 | 5 |
  | take-following-source | 4 | 4 | 4 |
  | first-title-google | 2 | 0 | 0 |

  Most hard-coded colours are see-through fills or `currentColor`, which follow the theme. Fixed font sizes will not follow a size change.

## How candidates were measured
`node scripts/palette-research.mjs` maps each palette onto the Dashboard's roles and measures:
- **Text** (WCAG 2.x AA, ≥ 4.5:1): text and muted text on page and card backgrounds, links, ok/warn/error text, text on the four severity card backgrounds, text on the primary and grant buttons.
- **Non-text** (≥ 3:1): the severity accent on a card's frame.
- **Distinctness** (OKLab distance): error vs warning vs accent, and adjacent severity levels, with normal vision and simulated protanopia, deuteranopia and tritanopia (Machado et al. 2009, full severity).
- A failing text colour is corrected by changing only its lightness (hue and chroma kept) until it passes; the script prints the corrected value and how far it moved.

Severity card backgrounds are derived the same way for every palette: the level's colour mixed into the card surface (16 % light, 24 % dark).

## Results

| Palette | Licence | Light: AA fails | Dark: AA fails | Red vs yellow, deuteranopia (light / dark) | Verdict |
|---|---|---|---|---|---|
| Dashboard (current) | ours | 0 | 0 | **0.014** / 0.075 | keep, but fix red/yellow lightness |
| GitHub Primer | MIT | 0 | 0 | **0.018** / 0.058 | good; same red/yellow fix needed |
| IBM Carbon g10 / g100 | Apache 2.0 | 2 (warn yellow 1.68:1, ok green) | 0 | 0.263 / 0.134 | light needs a darker yellow; dark is excellent |
| Catppuccin Latte / Mocha | MIT | 5 (small; warn and ok larger) | 0 | 0.169 / 0.172 | Mocha excellent; Latte usable after fixes |
| Gruvbox light / dark | MIT | 4 (small) | 1 (tiny) | 0.176 / 0.169 | best colour-blind separation overall |
| Nord (dark; light is not official) | MIT | 4 (pastels fail badly) | 1 | 0.251 / 0.251 | dark usable after one fix; light rejected |
| Solarized | MIT | **11 of 12** | **9 of 12** | 0.065 / 0.065 | rejected: its low contrast is by design |

(Distance below about 0.05 means the two colours look nearly the same.)

### Finding: red and yellow collapse for deuteranopia in the current light theme
The current light theme's error red (`#b3261e`) and warning yellow-brown (`#8a5300`) have the same lightness (OKLab L 0.50 vs 0.49). With deuteranopia (about 1 man in 12 has some red-green colour blindness, most of them of this type) both look olive (`#756916` vs `#726502`). The approval screen does not rely on colour alone (every marked line carries its tag and a sentence, and the banners say "Red markings" / "Worth a look"), so this is not a hole, but the colour signal itself is lost. GitHub Primer has the same flaw. **Fix:** red and warning must differ in lightness, not only in hue. Proposed rule for every theme: OKLab lightness of warning and error differ by at least 0.10, and their distance under each simulated colour blindness is at least 0.10.

### Severity levels
Adjacent severity levels are close under deuteranopia in most palettes (0.01–0.09). The feed card shows the level as a word, so this stays acceptable; the frame accent on the grid has no word. Proposed rule: severity colours get lighter or darker step by step (monotonic lightness), so they stay in order without colour vision.

## Proposed theme set
Each theme has a light and a dark version; "Follow Windows" stays the default.
1. **Dashboard** (current), with the red/yellow lightness fix.
2. **GitHub Primer**, with the same fix.
3. **Catppuccin** (Latte, corrected / Mocha as published).
4. **Gruvbox** (light, corrected / dark, one tiny correction).
5. **Carbon** (g10 with a darker yellow and green / g100 as published).
6. **Nord** dark only (error red corrected), if a dark-only theme is acceptable.

Values for Primer and Carbon were checked against their published packages (2026-10-16). Values for Nord, Solarized, Catppuccin and Gruvbox are from their published palettes as remembered: **verify against the upstream files before shipping.**

## Fonts

**Installed with Windows 11 (nothing to ship, no licence question):**

| Font | Character |
|---|---|
| Segoe UI (current) | neutral Windows UI font |
| Segoe UI Variable | Windows 11's UI font; adjusts its shapes to the size, good at small sizes |
| Calibri | rounder, a little smaller at the same size |
| Bahnschrift | narrow, technical (DIN style); fits more numbers per line |
| Verdana | wide and very legible at small sizes; takes more room |
| Cascadia Mono, Consolas | monospaced, for numbers and code |

**Shipped with the app (SIL Open Font License 1.1: free to bundle, a few hundred KB each):**

| Font | Character |
|---|---|
| Inter | designed for screens; very legible small text |
| IBM Plex Sans | pairs with the Carbon theme |
| Source Sans 3 | calm, compact |
| Atkinson Hyperlegible | designed for low vision; letters that are easy to confuse are made distinct |
| Noto Sans | widest language coverage |

**Font rules:**
- Cards are offline: no web fonts. A shipped font is served to cards by the host from inside the app (`card://` origin, CSP `font-src 'self'`).
- Base size 12–15 px, line spacing 1.3–1.6. A larger size makes text overflow cards that do not grow with it; the narrow range keeps that in check.
- The approval screen's text never goes below a minimum size in any theme.

## Rules for the build (proposed; become RULES.md and tests when approved)
1. **One theme definition** for the app screens and the card pages (ends the second palette in `card-host.ts`).
2. **Theme values are data, checked strictly:** colours only as `#rrggbb`; the font only from the list above; size and line spacing only as numbers in range. Anything else is rejected, so a theme file cannot inject CSS into cards.
3. **Automated contrast test** (unit test, every theme, light and dark): all text pairs ≥ 4.5:1, frame accents ≥ 3:1, the red/yellow lightness rule, the distinctness checks above, monotonic severity lightness.
4. **The approval screen's red and yellow** must pass rule 3 in every theme (security UI).
5. **Cards follow the theme live:** the host sends theme changes to running cards; `api.ui.theme()` returns the full theme; a theme-change event is added. Host to card only, so no new card capability; card approvals are unaffected.
6. **Generated cards use the theme:** the generator prompt tells Claude to use only theme variables and relative font sizes (`em`/`rem`); the validator warns about hard-coded colours and fixed pixel font sizes. The reference feed card is updated; installed feed cards then need reinstalling (approval is bound to files).
