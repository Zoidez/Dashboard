/**
 * Card file operations (api.fs), each one composed from the file check protocol (file-checks.ts).
 * Delete is not here yet: it is built last, and only if it can be made race-resistant
 * (ARCHITECTURE.md 4).
 */
import { watch as fsWatch } from "node:fs";
import { dirname, basename } from "node:path";
import { checkContent, checkScope, checkSyntax, fileTypeFor, FileCheckError, MAX_FILE_BYTES, openVerified, type CheckContext } from "./file-checks.js";
import { decodeText } from "./file-types.js";
import * as win from "./win32.js";

export interface FileStat { path: string; isDirectory: boolean; size: number; modifiedAt: string }

const READ_SHARE = win.FILE_SHARE_READ | win.FILE_SHARE_WRITE;   // never FILE_SHARE_DELETE: the file cannot be renamed or swapped while open
const ANY_SHARE = win.FILE_SHARE_READ | win.FILE_SHARE_WRITE | win.FILE_SHARE_DELETE;
const DIR_ACCESS = win.FILE_LIST_DIRECTORY | win.FILE_TRAVERSE | win.FILE_READ_ATTRIBUTES | win.SYNCHRONIZE;

function withHandle<T>(v: { h: win.Handle }, fn: () => T): T {
  try { return fn(); } finally { win.close(v.h); }
}

function readVerified(raw: unknown, ctx: CheckContext, use: "read" | "readText"): { path: string; bytes: Buffer } {
  const path = checkSyntax(raw);
  checkScope(path, ctx);
  const t = fileTypeFor(path, use);
  const v = openVerified(path, win.GENERIC_READ | win.FILE_READ_ATTRIBUTES, READ_SHARE, ctx, "file");
  return withHandle(v, () => {
    if (v.info.size > MAX_FILE_BYTES) throw new FileCheckError("TooLarge", "size", `${path} is larger than 10 MB`);
    let bytes: Buffer;
    try { bytes = win.readAll(v.h, v.info.size, MAX_FILE_BYTES); }
    catch (e) { if ((e as Error).message === "TooLarge") throw new FileCheckError("TooLarge", "size", `${path} is larger than 10 MB`); throw e; }
    checkContent(path, t, bytes, "file");     // the check runs on exactly the bytes the card receives
    return { path, bytes };
  });
}

export function readText(raw: unknown, ctx: CheckContext): string {
  const { bytes } = readVerified(raw, ctx, "readText");
  const d = decodeText(bytes);
  if ("error" in d) throw new FileCheckError("InvalidArgument", "type", `the file ${d.error}`);
  return d.text.replace(/^﻿/, "");
}

export function readBytes(raw: unknown, ctx: CheckContext): Uint8Array {
  return new Uint8Array(readVerified(raw, ctx, "read").bytes);
}

export function stat(raw: unknown, ctx: CheckContext): FileStat {
  const path = checkSyntax(raw);
  checkScope(path, ctx);
  const v = openVerified(path, win.FILE_READ_ATTRIBUTES, ANY_SHARE, ctx, "any");
  return withHandle(v, () => ({ path: v.path, isDirectory: v.info.isDirectory, size: v.info.isDirectory ? 0 : v.info.size, modifiedAt: v.info.modifiedAt }));
}

export function list(raw: unknown, ctx: CheckContext): FileStat[] {
  const path = checkSyntax(raw);
  checkScope(path, ctx, "listing");
  const v = openVerified(path, DIR_ACCESS, ANY_SHARE, ctx, "dir", "listing");
  return withHandle(v, () => win.listDir(v.h)
    .filter((e) => !e.isReparse)                         // links are never shown, so never offered
    .map((e) => ({ path: `${v.path}\\${e.name}`, isDirectory: e.isDirectory, size: e.isDirectory ? 0 : e.size, modifiedAt: e.modifiedAt })));
}

/** Opens the parent folder verified and pinned (no FILE_SHARE_DELETE: it cannot be renamed or replaced meanwhile). */
function openParent(path: string, ctx: CheckContext) {
  const parent = dirname(path);
  if (parent === path) throw new FileCheckError("InvalidArgument", "syntax", "a drive root cannot be created");
  const v = openVerified(parent, DIR_ACCESS, win.FILE_SHARE_READ | win.FILE_SHARE_WRITE, { ...ctx, scope: { ...ctx.scope, recursive: true } }, "dir");
  try { checkScope(parent, { ...ctx, scope: { path: ctx.scope.path, recursive: true } }); } catch (e) { win.close(v.h); throw e; }
  return v;
}

function createVerified(path: string, ctx: CheckContext, directory: boolean): win.Handle {
  const parent = openParent(path, ctx);
  return withHandle(parent, () => {
    let h: win.Handle;
    try { h = win.createChild(parent.h, basename(path), directory); }
    catch (e) {
      if (e instanceof win.Win32Error && (e.code === win.ERROR_FILE_EXISTS || e.code === win.ERROR_ALREADY_EXISTS)) throw new FileCheckError("IOError", "write rules", `${path} appeared while it was being created; try again`);
      throw new FileCheckError("IOError", "write rules", `${path} could not be created: ${(e as Error).message}`);
    }
    const real = win.finalPath(h).slice(4);
    if (real.toLowerCase() !== path.toLowerCase()) { win.close(h); throw new FileCheckError("PermissionDenied", "verified", `${path} was created at ${real}; refused`); }
    return h;
  });
}

function writeVerified(raw: unknown, data: Uint8Array, ctx: CheckContext, append: boolean): void {
  const path = checkSyntax(raw);
  checkScope(path, ctx);
  const t = fileTypeFor(path, append ? "append" : "write");
  if (data.byteLength > MAX_FILE_BYTES) throw new FileCheckError("TooLarge", "size", "more than 10 MB to write");
  if (!append) checkContent(path, t, data, "new content");
  else { const d = decodeText(data); if ("error" in d) throw new FileCheckError("InvalidArgument", "type", `the text to append ${d.error}`); }

  let v;
  try { v = openVerified(path, win.GENERIC_READ | win.GENERIC_WRITE | win.FILE_READ_ATTRIBUTES, win.FILE_SHARE_READ, ctx, "file"); }
  catch (e) {
    if (!(e instanceof FileCheckError) || e.code !== "NotFound") throw e;
    const h = createVerified(path, ctx, false);
    try { win.writeAll(h, data, false, false); } finally { win.close(h); }
    return;
  }
  withHandle(v, () => {
    if (v.info.links > 1) throw new FileCheckError("PermissionDenied", "write rules", `${path} has more than one name (hard link); writing it would change another file`);
    if (append) {
      // The existing file must itself be valid text of its type before anything is added.
      if (v.info.size + data.byteLength > MAX_FILE_BYTES) throw new FileCheckError("TooLarge", "size", `${path} would grow beyond 10 MB`);
      checkContent(path, t, win.readAll(v.h, v.info.size, MAX_FILE_BYTES), "file");
    }
    win.writeAll(v.h, data, !append, append);
  });
}

export function writeText(raw: unknown, text: unknown, ctx: CheckContext): void {
  if (typeof text !== "string") throw new FileCheckError("InvalidArgument", "syntax", "text must be a string");
  writeVerified(raw, new TextEncoder().encode(text), ctx, false);
}

export function writeBytes(raw: unknown, data: unknown, ctx: CheckContext): void {
  if (!(data instanceof Uint8Array)) throw new FileCheckError("InvalidArgument", "syntax", "data must be bytes (Uint8Array)");
  writeVerified(raw, data, ctx, false);
}

export function appendText(raw: unknown, text: unknown, ctx: CheckContext): void {
  if (typeof text !== "string") throw new FileCheckError("InvalidArgument", "syntax", "text must be a string");
  writeVerified(raw, new TextEncoder().encode(text), ctx, true);
}

export function mkdir(raw: unknown, ctx: CheckContext): void {
  const path = checkSyntax(raw);
  checkScope(path, ctx);
  try {
    const v = openVerified(path, win.FILE_READ_ATTRIBUTES, ANY_SHARE, ctx, "dir");
    win.close(v.h);
    return;                                              // already there, and verified
  } catch (e) {
    if (!(e instanceof FileCheckError) || e.code !== "NotFound") throw e;
  }
  win.close(createVerified(path, ctx, true));
}

/**
 * Watches a folder. Events carry names only; the card reads through the checked operations.
 * The folder is re-verified on every event; if it no longer is what was approved, the watch ends.
 */
export function watch(raw: unknown, ctx: CheckContext, onEvent: (e: { event: "add" | "change" | "unlink"; path: string } | { error: string }) => void): () => void {
  const path = checkSyntax(raw);
  checkScope(path, ctx, "listing");
  win.close(openVerified(path, DIR_ACCESS, ANY_SHARE, ctx, "dir", "listing").h);
  const known = new Set(list(path, ctx).map((e) => e.path.toLowerCase()));
  const w = fsWatch(path, { persistent: false, recursive: false }, (_type, name) => {
    try { win.close(openVerified(path, DIR_ACCESS, ANY_SHARE, ctx, "dir", "listing").h); }
    catch (e) { w.close(); onEvent({ error: `watch ended: ${(e as Error).message}` }); return; }
    if (!name) return;
    const child = `${path}\\${name}`;
    let exists = true;
    try { checkSyntax(child); win.close(win.openNoFollow(child, win.FILE_READ_ATTRIBUTES, ANY_SHARE)); } catch { exists = false; }
    const key = child.toLowerCase();
    const event = !exists ? "unlink" : known.has(key) ? "change" : "add";
    if (exists) known.add(key); else known.delete(key);
    onEvent({ event, path: child });
  });
  w.on("error", (e) => onEvent({ error: `watch ended: ${e.message}` }));
  return () => w.close();
}
