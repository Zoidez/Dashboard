/** Validator theme warnings (THEMES.md rule 6, generator rule 10): warned, never failed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { themeWarnings } from "../../src/main/validator/static-checks.js";
import { report, warnings, type StageResult } from "../../src/main/validator/validate.js";

test("fixed colours and pixel font sizes are warned about", () => {
  const src = [
    'const CSS = `.a { color: #ff0000; background: rgba(0, 0, 0, .2); font-size: 12px; }`;',
    'el.style.fontSize = "14px";',
    'const b = "font: 600 13px/1.4 Segoe UI";',
  ].join("\n");
  const w = themeWarnings("ui.js", src);
  assert.ok(w.some((x) => x.startsWith("ui.js:1:") && x.includes('"#ff0000')));
  assert.ok(w.some((x) => x.startsWith("ui.js:1:") && x.includes("rgba(")));
  assert.ok(w.some((x) => x.startsWith("ui.js:1:") && x.includes("font-size: 12px")));
  assert.ok(w.some((x) => x.startsWith("ui.js:2:") && x.includes("fixed font size")));
  assert.ok(w.some((x) => x.startsWith("ui.js:3:") && x.includes("fixed font size")));
});

test("theme variables, relative sizes, ids and comments are not warned about", () => {
  const src = [
    "// colours like #ff0000 in a comment are fine",
    'const CSS = `#card .x { color: var(--fg); border-color: var(--sev-high); font-size: .9em; padding: 4px; }`;',
    'document.querySelector("#add");',
  ].join("\n");
  assert.deepEqual(themeWarnings("ui.js", src), []);
});

test("warnings do not fail a stage but reach the retry message", () => {
  const stages: StageResult[] = [{ stage: "V4", title: "Static security checks", errors: [], warnings: ["ui.js:1: fixed colour"] }];
  assert.equal(warnings(stages), "- ui.js:1: fixed colour");
  assert.match(report(stages), /Warnings \(the card works, but fix these if you can\):\n- ui\.js:1: fixed colour/);
});
