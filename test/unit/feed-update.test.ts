/**
 * Updating an installed watch-feed card to a newer reference version (THEMES.md rule 6: the reference
 * card changed, installed copies need the user's approval again). Nothing changes on "No".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedCardOutdated, installCard, type CardFiles } from "../../src/main/cards/install.js";
import type { ApprovalRecord } from "../../src/main/cards/approvals.js";

const card = (ui: string): CardFiles => ({
  cardId: "feed-test", name: "Test feed",
  permissions: [{ type: "reports.read", taskId: "trig_01ABCDEFGHIJKLMNOPQRSTUV", reason: "Shows the reports." }] as never,
  files: { "manifest.json": '{"id":"feed-test"}\n', "ui.js": ui, "DEVLOG.md": "# Test\n" },
});

test("an outdated feed card is replaced only after a new approval", async () => {
  const base = mkdtempSync(join(tmpdir(), "feed-update-"));
  const dirs = { cards: join(base, "cards"), approvals: join(base, "approvals"), config: join(base, "config") };
  mkdirSync(dirs.cards, { recursive: true });               // the app creates it at start
  const approval = () => JSON.parse(readFileSync(join(dirs.approvals, "feed-test.json"), "utf8")) as ApprovalRecord;
  const yes = async () => true, no = async () => false;

  assert.equal(await installCard(card("// v1\n"), dirs, (t) => t, yes), "installed");
  assert.equal(await feedCardOutdated(card("// v1\n"), approval()), false, "same version is not outdated");
  await assert.rejects(installCard(card("// v1\n"), dirs, (t) => t, yes), /already installed/, "no silent overwrite without replace");

  const v2 = card("// v2: theme colours\n");
  assert.equal(await feedCardOutdated(v2, approval()), true);
  const before = approval().versionHash;
  let stopped = "";
  assert.equal(await installCard(v2, dirs, (t) => t, no, { stop: (id) => { stopped = id; } }), "declined");
  assert.equal(approval().versionHash, before, "declined: approval unchanged");
  assert.equal(readFileSync(join(dirs.cards, "feed-test", "ui.js"), "utf8"), "// v1\n", "declined: files unchanged");
  assert.equal(stopped, "", "declined: card not stopped");

  assert.equal(await installCard(v2, dirs, (t) => t, yes, { stop: (id) => { stopped = id; } }), "installed");
  assert.equal(stopped, "feed-test");
  assert.equal(readFileSync(join(dirs.cards, "feed-test", "ui.js"), "utf8"), "// v2: theme colours\n");
  assert.notEqual(approval().versionHash, before);
  assert.equal(await feedCardOutdated(v2, approval()), false);
});
