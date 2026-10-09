/**
 * Audit and security logs (ARCHITECTURE.md, "Audit, revoke, stop").
 *   data/audit/<card-id>.jsonl   successful sensitive operations, grants, denials of that card
 *   data/audit/_security.jsonl   denials, blocked requests, refused cards, approval mismatches
 * Append-only JSON lines. A bounded copy stays in memory for the UI and the tests.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type AuditKind =
  | "grant" | "grant-dropped" | "denied" | "blocked-request" | "net" | "fs" | "session-start" | "session-end"
  | "card-refused" | "card-flagged" | "approval-mismatch" | "invalid-message" | "reserved-call" | "browser-permission";

export interface AuditEntry {
  at: string;
  cardId: string;
  kind: AuditKind;
  detail: string;
}

const SECURITY_KINDS: ReadonlySet<AuditKind> = new Set(["denied", "blocked-request", "card-refused", "card-flagged", "approval-mismatch", "invalid-message", "reserved-call", "browser-permission"]);
const MEMORY_LIMIT = 5000;

export class AuditLog {
  private readonly recent: AuditEntry[] = [];
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true }); }

  write(cardId: string, kind: AuditKind, detail: string): void {
    const e: AuditEntry = { at: new Date().toISOString(), cardId, kind, detail: detail.slice(0, 2000) };
    this.recent.push(e);
    if (this.recent.length > MEMORY_LIMIT) this.recent.splice(0, this.recent.length - MEMORY_LIMIT);
    const line = JSON.stringify(e) + "\n";
    try {
      if (/^[a-z0-9][a-z0-9-]{1,47}$/.test(cardId)) appendFileSync(join(this.dir, `${cardId}.jsonl`), line);
      if (SECURITY_KINDS.has(kind)) appendFileSync(join(this.dir, "_security.jsonl"), line);
    } catch { /* the in-memory copy still has it; disk errors must not crash the broker */ }
  }

  entries(filter?: { cardId?: string; kind?: AuditKind }): AuditEntry[] {
    return this.recent.filter((e) => (!filter?.cardId || e.cardId === filter.cardId) && (!filter?.kind || e.kind === filter.kind));
  }
}
