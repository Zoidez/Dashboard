/** Fine grid layout (user request 2026-10-09): unit conversion and migration of old layout.json files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LayoutStore, clampSize, coarseToFine } from "../../src/main/layout.js";

test("coarse to fine keeps visual size", () => {
  assert.deepEqual(coarseToFine({ w: 4, h: 5 }), { w: 32, h: 46 });
  assert.deepEqual(coarseToFine({ w: 12, h: 12 }), { w: 96, h: 110 });
  assert.deepEqual(coarseToFine({ w: 1, h: 1 }), { w: 8, h: 9 });
  assert.deepEqual(clampSize(undefined), { w: 32, h: 37 });
  assert.deepEqual(clampSize({ w: 2, h: 1 }), { w: 16, h: 9 });
});
test("old layout.json is converted, new one kept, save marks unit", () => {
  const d = mkdtempSync(join(tmpdir(), "lay-"));
  const f = join(d, "layout.json");
  writeFileSync(f, JSON.stringify({ order: ["a", "bb"], sizes: { aa: { w: 4, h: 3 }, bb: { w: 13, h: 2 } } }));
  const s = new LayoutStore(f);
  const r = s.arrange([{ cardId: "aa" }, { cardId: "bb" }], () => ({ w: 1, h: 1 }));
  assert.deepEqual(r.find((x) => x.cardId === "aa")!.size, { w: 32, h: 28 });   // converted
  assert.deepEqual(r.find((x) => x.cardId === "bb")!.size, { w: 1, h: 1 });     // invalid old size -> default
  s.save();
  const saved = JSON.parse(readFileSync(f, "utf8"));
  assert.equal(saved.unit, "fine-96x10");
  const s2 = new LayoutStore(f);                                                  // reload: no second conversion
  assert.deepEqual(s2.arrange([{ cardId: "aa" }], () => ({ w: 1, h: 1 }))[0].size, { w: 32, h: 28 });
});
test("grid page updates are validated in fine units", () => {
  const d = mkdtempSync(join(tmpdir(), "lay-"));
  const s = new LayoutStore(join(d, "layout.json"));
  s.apply({ order: ["aa"], sizes: { aa: { w: 41, h: 13 }, bb: { w: 97, h: 5 } } });
  const r = s.arrange([{ cardId: "aa" }, { cardId: "bb" }], () => ({ w: 9, h: 9 }));
  assert.deepEqual(r[0].size, { w: 41, h: 13 });
  assert.deepEqual(r[1].size, { w: 9, h: 9 });                                     // out of range -> default
});
