/**
 * Approval records (ARCHITECTURE.md, "Approval is bound to a reviewed version").
 * data/approvals/<card-id>.json holds the SHA-256 of every card file, the permissions the user
 * approved, and a version hash over all of them. An approval is consent only; it grants nothing
 * by itself (RULES.md, host invariant 4).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join, posix } from "node:path";
import type { Permission } from "../broker/permissions.js";

export const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;

export interface ApprovalRecord {
  schema: 1;
  cardId: string;
  version: string;
  /** SHA-256 over the sorted (path, file hash) list; see versionHash(). */
  versionHash: string;
  /** Card-relative POSIX path -> SHA-256 (hex, lower case). */
  files: Record<string, string>;
  /** The permissions the user approved (possibly fewer than the manifest asked for). */
  permissions: Permission[];
  approvedAt: string;
  revoked: boolean;
  /**
   * Indices into `permissions` that the user has switched off. The approval still covers them, but
   * the broker refuses them until they are switched on again. Missing = all on. It can only narrow
   * what the approval allows, so it is not part of the version hash.
   */
  off?: number[];
}

/** The switched-off permission indices of a record, as a set. */
export function offSet(rec: ApprovalRecord): Set<number> {
  return new Set(rec.off ?? []);
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function versionHash(files: Record<string, string>): string {
  const lines = Object.keys(files).sort().map((p) => `${p}\0${files[p]}\n`);
  return sha256(lines.join(""));
}

const ALLOWED_TOP = new Set(["manifest.json", "ui.js", "worker.js", "DEVLOG.md"]);
const ASSET_RE = /^assets\/[A-Za-z0-9_.-]{1,64}\.(png|svg|webp|woff2)$/;

/** Whether a card-relative path may be a card file at all (VALIDATOR.md, V0). */
export function isCardFilePath(rel: string): boolean {
  return ALLOWED_TOP.has(rel) || ASSET_RE.test(rel);
}

/**
 * Hashes the files of a card folder. Refuses links (junctions and symlinks show up as symbolic
 * links in lstat on Windows), unknown files and nested folders other than assets/.
 */
export async function hashCardFolder(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    for (const ent of await fsp.readdir(absDir, { withFileTypes: true })) {
      const rel = relDir ? posix.join(relDir, ent.name) : ent.name;
      const abs = join(absDir, ent.name);
      const st = await fsp.lstat(abs);
      if (st.isSymbolicLink()) throw new Error(`card folder contains a link: ${rel}`);
      if (st.isDirectory()) {
        if (rel !== "assets") throw new Error(`card folder contains an unexpected folder: ${rel}`);
        await walk(abs, rel);
      } else if (st.isFile()) {
        if (!isCardFilePath(rel)) throw new Error(`card folder contains an unexpected file: ${rel}`);
        out[rel] = sha256(await fsp.readFile(abs));
      } else {
        throw new Error(`card folder contains a special file: ${rel}`);
      }
    }
  };
  await walk(dir, "");
  if (!out["manifest.json"] || !out["ui.js"]) throw new Error("card folder needs manifest.json and ui.js");
  return out;
}

export function parseApproval(text: string, expectedId: string): ApprovalRecord {
  const a = JSON.parse(text.replace(/^﻿/, "")) as Partial<ApprovalRecord>;
  if (!a || typeof a !== "object" || a.schema !== 1) throw new Error("approval record has an unknown schema");
  if (a.cardId !== expectedId) throw new Error("approval record belongs to another card");
  if (typeof a.versionHash !== "string" || !/^[0-9a-f]{64}$/.test(a.versionHash)) throw new Error("approval record has no valid version hash");
  if (!a.files || typeof a.files !== "object") throw new Error("approval record has no file list");
  for (const [p, h] of Object.entries(a.files)) {
    if (!isCardFilePath(p) || typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw new Error(`approval record has an invalid file entry: ${p}`);
  }
  if (versionHash(a.files) !== a.versionHash) throw new Error("approval record's version hash does not match its file list");
  if (!Array.isArray(a.permissions)) throw new Error("approval record has no permission list");
  if (typeof a.revoked !== "boolean") throw new Error("approval record has no revoked flag");
  if (a.off !== undefined) {
    const n = a.permissions.length;
    if (!Array.isArray(a.off) || a.off.some((i) => !Number.isInteger(i) || i < 0 || i >= n) || new Set(a.off).size !== a.off.length) {
      throw new Error("approval record has an invalid list of switched-off permissions");
    }
  }
  return a as ApprovalRecord;
}

/** In-memory view of the approval records. Revoke, grant and permission switches write through to disk. */
export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  constructor(private readonly dir: string) {}

  private file(cardId: string): string {
    if (!CARD_ID_RE.test(cardId)) throw new Error(`invalid card id: ${cardId}`);
    return join(this.dir, `${cardId}.json`);
  }

  async load(cardId: string): Promise<ApprovalRecord | null> {
    let text: string;
    try { text = await fsp.readFile(this.file(cardId), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") { this.records.delete(cardId); return null; } throw e; }
    const rec = parseApproval(text, cardId);
    this.records.set(cardId, rec);
    return rec;
  }

  get(cardId: string): ApprovalRecord | null {
    return this.records.get(cardId) ?? null;
  }

  async revoke(cardId: string): Promise<void> {
    const rec = this.records.get(cardId);
    if (!rec) return;
    rec.revoked = true;   // in memory first: the broker sees it on the very next call
    await this.save(rec);
  }

  /**
   * Undoes a revoke (the green Grant button). The record keeps its version hash and file hashes,
   * so the card still starts only if its files are exactly the ones the user approved.
   */
  async unrevoke(cardId: string): Promise<boolean> {
    const rec = this.records.get(cardId) ?? await this.load(cardId);
    if (!rec) return false;
    if (!rec.revoked) return true;
    rec.revoked = false;
    await this.save(rec);
    return true;
  }

  /**
   * Switches approved permissions off or on. In memory first, so the broker refuses a switched-off
   * permission on the very next call. Returns the indices whose state changed.
   */
  async setOff(cardId: string, indices: readonly number[], off: boolean): Promise<number[]> {
    const rec = this.records.get(cardId);
    if (!rec) return [];
    const set = offSet(rec);
    const changed: number[] = [];
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= rec.permissions.length || set.has(i) === off) continue;
      if (off) set.add(i); else set.delete(i);
      changed.push(i);
    }
    if (!changed.length) return [];
    const list = [...set].sort((a, b) => a - b);
    if (list.length) rec.off = list; else delete rec.off;
    await this.save(rec);
    return changed;
  }

  private async save(rec: ApprovalRecord): Promise<void> {
    const f = this.file(rec.cardId);
    await fsp.writeFile(f + ".tmp", JSON.stringify(rec, null, 2));
    await fsp.rename(f + ".tmp", f);
  }
}
