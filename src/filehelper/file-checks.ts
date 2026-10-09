/**
 * The file check protocol (ARCHITECTURE.md 4a). Every card file operation passes these checks, in
 * this order, before the card gets a single byte or writes one:
 *
 *   1. syntax      a plain drive path: no \\?\, \\.\ or UNC prefix, no "..", no ":" stream, no device
 *                  name (CON, NUL...), no trailing dot or space, no wildcard characters
 *   2. scope       an approved permission covers it, and it is not inside the Dashboard's instance
 *   3. verified    opened once without following links; Windows' real path of that handle must equal
 *                  the requested path exactly (rules out junctions, symlinks, 8.3 short names, drive
 *                  aliases); the operation then uses that same handle
 *   4. kind        it exists and is a file or a folder, as the operation expects
 *   5. type        its extension is a known type and its bytes really are that type
 *   6. write rules writable type only, never a program or script, never a file with several names
 *                  (hard links), and the new content must itself pass the type check
 *
 * Stricter controls go here, as further checks, so every operation gets them.
 */
import { resolve } from "node:path";
import { fsScopeCovers } from "../main/broker/permissions.js";
import { isInsideInstance } from "../main/instance.js";
import { extensionOf, FILE_TYPES, PROGRAM_EXTENSIONS, type FileType } from "./file-types.js";
import * as win from "./win32.js";

export type FileErrorCode = "PermissionDenied" | "NotFound" | "InvalidArgument" | "TooLarge" | "IOError";

export class FileCheckError extends Error {
  constructor(readonly code: FileErrorCode, readonly check: string, message: string) { super(message); }
}

export interface Scope { path: string; recursive: boolean }
export interface CheckContext { instanceRoot: string; scope: Scope }

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i;

// ---------- 1. syntax ----------

/** Returns the normalized path ("C:\a\b") or throws. */
export function checkSyntax(raw: unknown): string {
  const fail = (why: string): never => { throw new FileCheckError("InvalidArgument", "syntax", `invalid path: ${why}`); };
  if (typeof raw !== "string" || raw.length === 0) fail("not a string");
  const s = raw as string;
  if (s.length > 260) fail("longer than 260 characters");
  if (/^[\\/]{2}/.test(s)) fail("network, device and \\\\?\\ paths are not allowed");
  const p = s.replace(/\//g, "\\");
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (!m) fail("must be a full path starting with a drive letter, such as C:\\");
  const parts = m![2].split("\\");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();   // one trailing backslash is fine
  for (const c of parts) {
    if (c === "") fail("empty folder name (double backslash)");
    if (c === "." || c === "..") fail("\".\" and \"..\" are not allowed");
    // eslint-disable-next-line no-control-regex
    if (/[<>:"|?*\x00-\x1f]/.test(c)) fail(`"${c}" contains a character Windows reserves (: < > " | ? * or a control character); ":" would name an alternate data stream`);
    if (/[. ]$/.test(c)) fail(`"${c}" ends with a dot or a space`);
    if (RESERVED.test(c.split(".")[0].trim())) fail(`"${c}" is a reserved device name`);
    if (c.length > 255) fail("a name is longer than 255 characters");
  }
  return `${m![1].toUpperCase()}:\\${parts.join("\\")}`;
}

// ---------- 2. scope ----------

export function checkScope(path: string, ctx: CheckContext, mode: "item" | "listing" = "item"): void {
  if (isInsideInstance(ctx.instanceRoot, path)) throw new FileCheckError("PermissionDenied", "scope", "cards can never access the Dashboard's own folder");
  const scope = resolve(ctx.scope.path);
  const covered = mode === "listing"
    // Listing shows a folder's contents: only the scope folder itself, or any folder inside a recursive scope.
    ? path.toLowerCase() === scope.replace(/[\\/]+$/, "").toLowerCase() || (ctx.scope.recursive && fsScopeCovers(scope, true, path))
    : fsScopeCovers(scope, ctx.scope.recursive, path);
  if (!covered) throw new FileCheckError("PermissionDenied", "scope", `${path} is outside the approved folder ${scope}`);
}

// ---------- 3 + 4. open, verify, kind ----------

export interface Verified { h: win.Handle; path: string; info: win.HandleInfo }

export function openVerified(path: string, access: number, share: number, ctx: CheckContext, kind: "file" | "dir" | "any", mode: "item" | "listing" = "item"): Verified {
  let h: win.Handle;
  try { h = win.openNoFollow(path, access, share); }
  catch (e) {
    const code = e instanceof win.Win32Error ? e.code : -1;
    if (code === win.ERROR_FILE_NOT_FOUND || code === win.ERROR_PATH_NOT_FOUND) throw new FileCheckError("NotFound", "verified", `${path} does not exist`);
    if (code === win.ERROR_ACCESS_DENIED) throw new FileCheckError("PermissionDenied", "verified", `Windows denied access to ${path}`);
    if (code === win.ERROR_SHARING_VIOLATION) throw new FileCheckError("IOError", "verified", `${path} is in use by another program`);
    throw new FileCheckError("IOError", "verified", `${path} could not be opened: ${(e as Error).message}`);
  }
  try {
    const info = win.info(h);
    if (info.isReparse) throw new FileCheckError("PermissionDenied", "verified", `${path} is a link (junction or symbolic link); links are not followed`);
    const real = win.finalPath(h);
    if (!real.startsWith("\\\\?\\") || real.toUpperCase().startsWith("\\\\?\\UNC\\")) throw new FileCheckError("PermissionDenied", "verified", `${path} is on a network location`);
    const realPath = real.slice(4);
    if (realPath.toLowerCase() !== path.toLowerCase()) {
      throw new FileCheckError("PermissionDenied", "verified", `${path} leads to ${realPath} (a link, short name or drive alias on the way); refused`);
    }
    checkScope(realPath, ctx, mode);
    if (kind === "file" && info.isDirectory) throw new FileCheckError("InvalidArgument", "kind", `${path} is a folder, not a file`);
    if (kind === "dir" && !info.isDirectory) throw new FileCheckError("InvalidArgument", "kind", `${path} is a file, not a folder`);
    return { h, path: realPath, info };
  } catch (e) {
    win.close(h);
    throw e;
  }
}

// ---------- 5 + 6. type and write rules ----------

export type TypeUse = "read" | "readText" | "write" | "append";

export function fileTypeFor(path: string, use: TypeUse): FileType {
  const name = path.slice(path.lastIndexOf("\\") + 1);
  const ext = extensionOf(name);
  if (PROGRAM_EXTENSIONS.has(ext)) throw new FileCheckError("PermissionDenied", "type", `${name}: programs and scripts (${ext}) can never be read or written by cards`);
  const t = FILE_TYPES[ext];
  if (!t) throw new FileCheckError("PermissionDenied", "type", `${name}: files of type "${ext || "(no extension)"}" are not supported`);
  if (use === "readText" && !t.text) throw new FileCheckError("InvalidArgument", "type", `${name} is a ${t.label} file, not text; use readBytes`);
  if (use === "write" && !t.writable) throw new FileCheckError("PermissionDenied", "type", `${name}: cards cannot create or change ${t.label} files`);
  if (use === "append" && !t.appendable) throw new FileCheckError("PermissionDenied", "type", `${name}: cards can append only to line-based text files`);
  return t;
}

export function checkContent(path: string, t: FileType, bytes: Uint8Array, what: "file" | "new content"): void {
  const reason = t.check(bytes);
  if (reason) {
    const name = path.slice(path.lastIndexOf("\\") + 1);
    throw new FileCheckError("InvalidArgument", "type", `${what === "file" ? name : `the new content for ${name}`} ${reason}`);
  }
}
