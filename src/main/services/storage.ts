/**
 * Per-card key-value store: data/config/<card-id>/storage.json, max 1 MB (spec/host-api.d.ts).
 * Writes for one card are serialized; the file is replaced atomically (write temp, rename).
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { HostError } from "../broker/broker.js";
import { CARD_ID_RE } from "../cards/approvals.js";

export const STORAGE_LIMIT = 1024 * 1024;

export class CardStorage {
  private readonly cache = new Map<string, Record<string, unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly configDir: string) {}

  private file(cardId: string): string {
    if (!CARD_ID_RE.test(cardId)) throw new HostError("InvalidArgument", "invalid card id");
    return join(this.configDir, cardId, "storage.json");
  }

  private async load(cardId: string): Promise<Record<string, unknown>> {
    const hit = this.cache.get(cardId);
    if (hit) return hit;
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(await fsp.readFile(this.file(cardId), "utf8")) as Record<string, unknown>; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new HostError("IOError", "the card's storage file is unreadable"); }
    if (typeof data !== "object" || data === null || Array.isArray(data)) data = {};
    this.cache.set(cardId, data);
    return data;
  }

  private serial<T>(cardId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(cardId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(cardId, next.catch(() => undefined));
    return next;
  }

  async get(cardId: string, key: string): Promise<unknown> {
    const d = await this.load(cardId);
    return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : undefined;
  }

  set(cardId: string, key: string, value: unknown): Promise<void> {
    return this.serial(cardId, async () => {
      if (value instanceof Uint8Array) throw new HostError("InvalidArgument", "storage holds JSON values only");
      const d = await this.load(cardId);
      const next = { ...d, [key]: value === undefined ? null : value };
      const text = JSON.stringify(next);
      if (Buffer.byteLength(text) > STORAGE_LIMIT) throw new HostError("TooLarge", "card storage is limited to 1 MB");
      await this.persist(cardId, text);
      this.cache.set(cardId, next);
    });
  }

  remove(cardId: string, key: string): Promise<void> {
    return this.serial(cardId, async () => {
      const d = { ...(await this.load(cardId)) };
      delete d[key];
      await this.persist(cardId, JSON.stringify(d));
      this.cache.set(cardId, d);
    });
  }

  private async persist(cardId: string, text: string): Promise<void> {
    const f = this.file(cardId);
    await fsp.mkdir(join(this.configDir, cardId), { recursive: true });
    await fsp.writeFile(f + ".tmp", text);
    await fsp.rename(f + ".tmp", f);
  }
}
