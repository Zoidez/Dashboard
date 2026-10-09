/**
 * The broker's HTTP client (ARCHITECTURE.md, "No network except through the broker").
 * - The broker resolves the hostname itself and connects to the exact address it checked.
 * - Loopback, private, link-local, multicast, reserved and unspecified addresses (IPv4 and IPv6,
 *   including IPv4-mapped, NAT64, 6to4 and Teredo forms) are refused unless the permission's origin
 *   names that address itself (http://localhost, http://127.0.0.1, or an IP literal).
 * - Redirects are followed here, one hop at a time; every hop is checked against the approved
 *   permissions again. No cookies, no connection reuse between requests.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { findCovering, type HttpMethod, type Permission } from "./permissions.js";

export const MAX_BODY = 10 * 1024 * 1024;
export const MAX_HOPS = 5;
const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const DROP_HEADERS = new Set(["host", "cookie", "cookie2", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

export class NetError extends Error {
  constructor(readonly code: "PermissionDenied" | "InvalidArgument" | "NetworkError" | "TooLarge" | "Timeout", message: string) { super(message); }
}

// ---------- address classification ----------

function v4Bytes(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

/** IPv6 text -> 16 bytes (handles "::" and a dotted IPv4 tail). Zone ids are rejected. */
export function v6Bytes(s: string): number[] | null {
  if (s.includes("%")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = v4Bytes(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (x: string) => (x === "" ? [] : x.split(":"));
  const head = parse(halves[0]), rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - rest.length).fill("0"), ...rest] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const out: number[] = [];
  for (const g of groups) { const n = parseInt(g, 16); out.push(n >> 8, n & 255); }
  if (tail.length) out.splice(12, 4, ...tail);
  return out;
}

function v4Reason(b: number[]): string | null {
  const [a, c] = b;
  if (a === 0) return "unspecified/this-network";
  if (a === 10) return "private";
  if (a === 100 && c >= 64 && c <= 127) return "carrier-grade NAT";
  if (a === 127) return "loopback";
  if (a === 169 && c === 254) return "link-local";
  if (a === 172 && c >= 16 && c <= 31) return "private";
  if (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) return "reserved";
  if (a === 192 && c === 88 && b[2] === 99) return "reserved (6to4 relay)";
  if (a === 192 && c === 168) return "private";
  if (a === 198 && (c === 18 || c === 19)) return "benchmarking";
  if (a === 198 && c === 51 && b[2] === 100) return "documentation";
  if (a === 203 && c === 0 && b[2] === 113) return "documentation";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved/broadcast";
  return null;
}

/** null if the address is public; otherwise a plain-words reason. */
export function nonPublicReason(ip: string): string | null {
  const fam = isIP(ip);
  if (fam === 4) { const b = v4Bytes(ip); return b ? v4Reason(b) : "unparsable address"; }
  if (fam !== 6) return "not an IP address";
  const b = v6Bytes(ip);
  if (!b) return "unparsable address";
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified";
  if (zero(0, 15) && b[15] === 1) return "loopback";
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Reason(b.slice(12)) ?? null;   // IPv4-mapped: judge the IPv4 address
  if (zero(0, 12)) return "IPv4-compatible (deprecated)";
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4Reason(b.slice(12)) ?? null;  // NAT64
  if (b[0] === 0x01 && zero(1, 8)) return "discard-only";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "Teredo tunnel";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  if (b[0] === 0x20 && b[1] === 0x02) return "6to4 tunnel";
  if ((b[0] & 0xfe) === 0xfc) return "unique local (private)";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "site-local (deprecated)";
  if (b[0] === 0xff) return "multicast";
  return null;
}

/** Addresses a permission names explicitly; those are allowed even if not public. */
function explicitAddresses(origin: string): string[] {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") return ["127.0.0.1", "::1"];
  return isIP(host) ? [host] : [];
}

function sameAddress(a: string, b: string): boolean {
  if (isIP(a) === 6 && isIP(b) === 6) return v6Bytes(a)?.join() === v6Bytes(b)?.join();
  return a === b;
}

// ---------- the request ----------

export interface BrokerHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface BrokerHttpResponse {
  status: number;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface NetDeps {
  /** Resolves a hostname to all of its addresses. Replaced in tests. */
  resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Called for every hop actually sent (audit: every network destination). */
  onHop?: (info: { url: string; method: string; address: string }) => void;
  signal?: AbortSignal;
}

export function parseRequest(raw: unknown): BrokerHttpRequest {
  if (typeof raw !== "object" || raw === null) throw new NetError("InvalidArgument", "request must be an object");
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!["url", "method", "headers", "body", "timeoutMs"].includes(k)) throw new NetError("InvalidArgument", `unknown request field: ${k}`);
  if (typeof r.url !== "string" || r.url.length > 8192) throw new NetError("InvalidArgument", "url must be a string");
  if (r.method !== undefined && (typeof r.method !== "string" || !METHODS.has(r.method))) throw new NetError("InvalidArgument", "unsupported method");
  if (r.headers !== undefined) {
    if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) throw new NetError("InvalidArgument", "headers must be an object");
    const hs = Object.entries(r.headers as Record<string, unknown>);
    if (hs.length > 64) throw new NetError("InvalidArgument", "too many headers");
    for (const [k, v] of hs) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(k) || typeof v !== "string" || v.length > 8192 || /[\r\n\0]/.test(v)) throw new NetError("InvalidArgument", `invalid header: ${k}`);
    }
  }
  if (r.body !== undefined && typeof r.body !== "string" && !(r.body instanceof Uint8Array)) throw new NetError("InvalidArgument", "body must be a string or bytes");
  if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || !(r.timeoutMs > 0))) throw new NetError("InvalidArgument", "timeoutMs must be a positive number");
  return r as unknown as BrokerHttpRequest;
}

async function defaultResolve(host: string) {
  return dnsLookup(host, { all: true, verbatim: true });
}

/** Picks the address to connect to. Refuses if ANY answer is non-public (and not named by the permission). */
export async function pickAddress(url: URL, perm: Extract<Permission, { type: "net.http" }>, resolve: NonNullable<NetDeps["resolve"]>): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (!answers.length) throw new NetError("NetworkError", `${host} did not resolve`);
  const allowed = explicitAddresses(perm.origin);
  for (const a of answers) {
    const reason = nonPublicReason(a.address);
    if (reason && !allowed.some((x) => sameAddress(x, a.address))) {
      throw new NetError("PermissionDenied", `${host} resolves to ${a.address} (${reason}); only public addresses are allowed for this permission`);
    }
  }
  const first = answers[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function sendOnce(url: URL, method: string, headers: Record<string, string>, body: Uint8Array | undefined, pinned: { address: string; family: 4 | 6 }, signal: AbortSignal): Promise<{ status: number; headers: Record<string, string>; location?: string; body: Uint8Array }> {
  return new Promise((resolve, reject) => {
    // The connection goes to the pinned address; TLS still verifies the certificate against the hostname.
    const lookup: LookupFunction = (_h, opts, cb) => {
      if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: pinned.address, family: pinned.family }]);
      else cb(null, pinned.address, pinned.family);
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, { method, headers: { ...headers, host: url.host }, lookup, agent: false, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) { req.destroy(new NetError("TooLarge", "response body over 10 MB")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const hs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === "set-cookie" || v === undefined) continue;   // no cookie jar, and cards never see cookies
          hs[k] = Array.isArray(v) ? v.join(", ") : v;
        }
        resolve({ status: res.statusCode ?? 0, headers: hs, location: typeof res.headers.location === "string" ? res.headers.location : undefined, body: new Uint8Array(Buffer.concat(chunks)) });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.end(Buffer.from(body)); else req.end();
  });
}

/** Performs a card's request. Every hop must be covered by `perms`. */
export async function brokerRequest(raw: unknown, perms: readonly Permission[], deps: NetDeps = {}): Promise<BrokerHttpResponse> {
  const req = parseRequest(raw);
  const timeoutMs = Math.min(req.timeoutMs ?? 15000, 60000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new NetError("Timeout", `no response within ${timeoutMs} ms`)), timeoutMs);
  const onOuterAbort = () => ctl.abort(new NetError("NetworkError", "request cancelled: the card stopped"));
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const resolve = deps.resolve ?? defaultResolve;
  try {
    let url: URL;
    try { url = new URL(req.url); } catch { throw new NetError("InvalidArgument", "url is not a valid URL"); }
    let method = (req.method ?? "GET") as HttpMethod;
    let body: Uint8Array | undefined = req.body === undefined ? undefined : typeof req.body === "string" ? new TextEncoder().encode(req.body) : req.body;
    if (body && body.byteLength > MAX_BODY) throw new NetError("TooLarge", "request body over 10 MB");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;

    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new NetError("PermissionDenied", `scheme ${url.protocol} is not allowed`);
      if (url.username || url.password) throw new NetError("InvalidArgument", "credentials in the URL are not allowed");
      const idx = findCovering(perms, { type: "net.http", url, method }, (p) => p);
      if (idx < 0) throw new NetError("PermissionDenied", `${method} ${url.origin}${url.pathname} is not covered by an approved permission${hop ? " (redirect)" : ""}`);
      const perm = perms[idx] as Extract<Permission, { type: "net.http" }>;
      const pinned = await pickAddress(url, perm, resolve);
      deps.onHop?.({ url: url.href, method, address: pinned.address });
      let res;
      try { res = await sendOnce(url, method, headers, body, pinned, ctl.signal); }
      catch (e) {
        if (e instanceof NetError) throw e;
        const reason = ctl.signal.reason;
        if (reason instanceof NetError) throw reason;
        throw new NetError("NetworkError", (e as Error).message);
      }
      if (res.status >= 300 && res.status < 400 && res.location && [301, 302, 303, 307, 308].includes(res.status)) {
        if (hop + 1 >= MAX_HOPS) throw new NetError("NetworkError", `more than ${MAX_HOPS - 1} redirects`);
        url = new URL(res.location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        continue;
      }
      return { status: res.status, url: url.href, headers: res.headers, body: res.body };
    }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOuterAbort);
  }
}
