/**
 * Minimal tar (ustar) for copying files in and out of jobs (`podman cp` speaks tar). Writing: regular
 * files and their parent folders. Reading: regular files only; links, devices and anything else are
 * refused, names are checked, sizes are limited. pax and GNU long-name headers are understood.
 */
import type { FileSet } from "./backend.js";

const BLOCK = 512;

/** A safe relative path: forward slashes, no empty, "." or ".." segments, no control characters. */
export function safeRelPath(p: string): boolean {
  if (typeof p !== "string" || p.length === 0 || p.length > 255 || p.startsWith("/") || p.includes("\\") || /[\0-\x1f]/.test(p)) return false;
  return p.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, type: "0" | "5", uid: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`tar: name too long: ${name.slice(0, 80)}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, "utf8");
  h.write(type === "5" ? "0000755\0" : "0000644\0", 100, 8, "ascii");
  h.write(octal(uid, 8), 108, 8, "ascii");
  h.write(octal(uid, 8), 116, 8, "ascii");
  h.write(octal(size, 12), 124, 12, "ascii");
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  h.write("        ", 148, 8, "ascii");
  h.write(type, 156, 1, "ascii");
  h.write("ustar\0", 257, 6, "ascii");
  h.write("00", 263, 2, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + " ", 148, 8, "ascii");
  return h;
}

/** Builds a tar archive of the files (owned by uid), with entries for their parent folders. */
export function writeTar(files: FileSet, uid: number): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const [name, data] of Object.entries(files)) {
    if (!safeRelPath(name)) throw new Error(`tar: unsafe path ${JSON.stringify(name).slice(0, 80)}`);
    const segs = name.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/") + "/";
      if (!dirs.has(d)) { dirs.add(d); parts.push(header(d, 0, "5", uid)); }
    }
    parts.push(header(name, data.length, "0", uid), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Reads the regular files of a tar archive. Throws on links, devices, unsafe names or too much data. */
export function readTar(tar: Buffer, limits = { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 }): FileSet {
  const out: FileSet = {};
  let off = 0, total = 0, count = 0;
  let nextName: string | null = null;
  const str = (b: Buffer) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString("utf8"); };
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    if (!Number.isFinite(size) || size < 0 || off + BLOCK + size > tar.length) throw new Error("tar: truncated or bad size");
    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {                                        // pax header for the next entry
      for (const rec of body.toString("utf8").split("\n")) { const m = /^\d+ path=(.*)$/.exec(rec); if (m) nextName = m[1]; }
      continue;
    }
    if (type === "g") continue;                                // pax global header: nothing we use
    if (type === "L") { nextName = str(body); continue; }      // GNU long name
    const prefix = str(h.subarray(345, 500));
    let name = nextName ?? (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
    nextName = null;
    name = name.replace(/^\.\//, "").replace(/\/+$/, "");
    if (type === "5") { if (name && !safeRelPath(name)) throw new Error(`tar: unsafe folder ${name.slice(0, 80)}`); continue; }
    if (type !== "0" && type !== "\0" && type !== "7") throw new Error(`tar: ${name.slice(0, 80)} is not a regular file (type ${type}); refused`);
    if (!safeRelPath(name)) throw new Error(`tar: unsafe path ${JSON.stringify(name).slice(0, 80)}`);
    total += size; count++;
    if (total > limits.maxBytes || count > limits.maxFiles) throw new Error("tar: more data than allowed");
    out[name] = Buffer.from(body);
  }
  return out;
}
