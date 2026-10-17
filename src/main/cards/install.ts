/**
 * Installing a card (ARCHITECTURE.md 6, "Approval is bound to a reviewed version"):
 *   1. the files are written into a host-only folder (data/config/_install/<random>) and hashed THERE;
 *   2. the user sees those exact permissions (PERMISSIONS.md lines and markings) and file hashes;
 *   3. on approval the approval record is written and that same folder is renamed into data/cards/<id>.
 * Files are never re-read from anywhere else after hashing. The card loader re-checks the hashes
 * whenever it serves a file.
 *
 * For now this installs the reference cards that ship with the Dashboard (the watch feeds). The
 * generator pipeline will install generated cards through the same function.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { Permission } from "../broker/permissions.js";
import type { FeedConfig } from "../options.js";
import { CARD_ID_RE, hashCardFolder, versionHash, type ApprovalRecord } from "./approvals.js";
import { display, type Display } from "./permission-lines.js";

export interface CardFiles { cardId: string; name: string; permissions: Permission[]; files: Record<string, string | Buffer> }
export interface Review { cardId: string; name: string; display: Display; hashes: Record<string, string> }
export type Decide = (review: Review) => Promise<boolean>;

export function feedCardId(feed: FeedConfig): string {
  const slug = feed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const id = `feed-${slug || feed.taskId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`;
  if (!CARD_ID_RE.test(id)) throw new Error(`cannot make a card id for ${feed.name}`);
  return id;
}

/** The watch-feed reference card (CARDS.md 2) for one feed. */
export async function feedCard(feed: FeedConfig, sourceDir: string): Promise<CardFiles> {
  const cardId = feedCardId(feed);
  const name = feed.name.slice(0, 60);
  const permissions: Permission[] = [
    { type: "reports.read", taskId: feed.taskId, reason: "Shows the reports of this scheduled task." },
    { type: "links.open", any: true, reason: "Opens a report's source links, which can point to any site." },
  ];
  const manifest = {
    id: cardId, name, version: "1.0.0", apiVersion: 0, preset: "watch-feed",
    description: `Shows the latest report of "${name}".`,
    defaultSize: { w: 4, h: 4 }, permissions,
    configSchema: { type: "object", properties: { taskId: { type: "string", title: "Scheduled task ID", default: feed.taskId } } },
  };
  return {
    cardId, name, permissions,
    files: {
      "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
      "ui.js": await fsp.readFile(join(sourceDir, "watch-feed", "ui.js")),
      "DEVLOG.md": `# ${name}\n\n- ${new Date().toISOString().slice(0, 10)}: installed from the Dashboard's watch-feed reference card (CARDS.md 2) for task ${feed.taskId}.\n`,
    },
  };
}

/** Whether an installed feed card runs an older reference version (its ui.js or manifest differ from the shipped one). */
export async function feedCardOutdated(card: CardFiles, installed: ApprovalRecord | null): Promise<boolean> {
  if (!installed) return false;
  return ["ui.js", "manifest.json"].some((rel) => installed.files[rel] !== createHash("sha256").update(card.files[rel]).digest("hex"));
}

/**
 * Installs a reference card. With `replace`, an installed card of the same id is replaced by the new
 * version after the user approves it again (the old folder is moved aside, the new one renamed in).
 */
export async function installCard(card: CardFiles, dirs: { cards: string; approvals: string; config: string }, taskName: (id: string) => string, decide: Decide, replace?: { stop: (cardId: string) => void }): Promise<"installed" | "declined"> {
  const target = join(dirs.cards, card.cardId);
  let exists = false;
  try { await fsp.access(target); exists = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (exists && !replace) throw new Error(`${card.name} is already installed`);
  const temp = join(dirs.config, "_install", randomUUID());
  await fsp.mkdir(temp, { recursive: true });
  try {
    for (const [rel, data] of Object.entries(card.files)) {
      const p = join(temp, ...rel.split("/"));
      await fsp.mkdir(join(p, ".."), { recursive: true });
      await fsp.writeFile(p, data);
    }
    const hashes = await hashCardFolder(temp);                     // hashed here, never re-read elsewhere
    const ok = await decide({ cardId: card.cardId, name: card.name, display: display(card.permissions, taskName), hashes });
    if (!ok) return "declined";
    const rec: ApprovalRecord = {
      schema: 1, cardId: card.cardId, version: "1.0.0", versionHash: versionHash(hashes), files: hashes,
      permissions: card.permissions, approvedAt: new Date().toISOString(), revoked: false,
    };
    let old: string | null = null;
    if (exists) {
      replace!.stop(card.cardId);
      old = join(dirs.config, "_install", `old-${card.cardId}-${randomUUID()}`);
      await fsp.rename(target, old);
    }
    await fsp.mkdir(dirs.approvals, { recursive: true });
    await fsp.writeFile(join(dirs.approvals, `${card.cardId}.json`), JSON.stringify(rec, null, 2));
    await fsp.rename(temp, target);                                // the same folder that was hashed
    if (old) await fsp.rm(old, { recursive: true, force: true });  // host-only copy of the replaced version
    return "installed";
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);   // host-only temp folder; gone after rename
  }
}

/**
 * Installs a generated card the user approved on the canvas. The validated bytes are written into a
 * host-only folder and hashed again there; they must equal what the validator read and the user saw.
 * An update swaps folders: the old version is moved aside, the new one renamed in, then the old one removed.
 */
export async function installGenerated(
  card: { cardId: string; manifest: { version: string }; files: Record<string, Buffer>; hashes: Record<string, string> },
  permissions: Permission[],
  kind: "new" | "update",
  dirs: { cards: string; approvals: string; config: string },
  stopRunning: (cardId: string) => void,
): Promise<void> {
  const target = join(dirs.cards, card.cardId);
  const temp = join(dirs.config, "_install", randomUUID());
  await fsp.mkdir(temp, { recursive: true });
  try {
    for (const [rel, data] of Object.entries(card.files)) {
      const p = join(temp, ...rel.split("/"));
      await fsp.mkdir(join(p, ".."), { recursive: true });
      await fsp.writeFile(p, data);
    }
    const hashes = await hashCardFolder(temp);
    const same = Object.keys(hashes).length === Object.keys(card.hashes).length && Object.entries(hashes).every(([p, h]) => card.hashes[p] === h);
    if (!same) throw new Error("the files changed between validation and install; nothing was installed");
    const rec: ApprovalRecord = {
      schema: 1, cardId: card.cardId, version: card.manifest.version, versionHash: versionHash(hashes), files: hashes,
      permissions, approvedAt: new Date().toISOString(), revoked: false,
    };
    let old: string | null = null;
    if (kind === "update") {
      stopRunning(card.cardId);
      old = join(dirs.config, "_install", `old-${card.cardId}-${randomUUID()}`);
      await fsp.rename(target, old);
    } else {
      try { await fsp.access(target); throw new Error(`${card.cardId} already exists`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    await fsp.mkdir(dirs.approvals, { recursive: true });
    await fsp.rename(temp, target);
    await fsp.writeFile(join(dirs.approvals, `${card.cardId}.json`), JSON.stringify(rec, null, 2));
    if (old) await fsp.rm(old, { recursive: true, force: true });    // host-only copy of the replaced version
  } finally {
    await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Plain-words text for the interim approval dialog (the approval canvas replaces it). */
export function reviewText(r: Review): string {
  const out: string[] = [];
  r.display.lines.forEach((l, i) => {
    const tags = l.marks.map((m) => `[${m.level === "red" ? "RED" : "YELLOW"} ${m.tag}] ${m.why}`);
    out.push(`${i + 1}. ${l.text}`, `   Card says: ${l.reason}`, ...tags.map((t) => `   ${t}`));
  });
  out.push("", "Files (SHA-256):", ...Object.entries(r.hashes).map(([p, h]) => `   ${p}  ${h.slice(0, 16)}…`));
  return out.join("\n");
}
