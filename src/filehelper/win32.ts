/**
 * Win32/NT calls for the native file helper (ARCHITECTURE.md, "File operations are race-resistant").
 * Every operation works on a handle the helper opened itself, without following reparse points,
 * after asking Windows for that handle's real path. Nothing here decides policy; file-checks.ts does.
 */
import koffi from "koffi";

export type Handle = number | bigint;

export class Win32Error extends Error {
  constructor(readonly fn: string, readonly code: number) { super(`${fn} failed (Windows error ${code})`); }
}

// Access rights, sharing, flags
export const GENERIC_READ = 0x80000000;
export const GENERIC_WRITE = 0x40000000;
export const FILE_READ_ATTRIBUTES = 0x80;
export const FILE_LIST_DIRECTORY = 0x1;
export const FILE_TRAVERSE = 0x20;
export const FILE_APPEND_DATA = 0x4;
export const SYNCHRONIZE = 0x100000;
export const DELETE = 0x10000;
export const FILE_SHARE_READ = 0x1;
export const FILE_SHARE_WRITE = 0x2;
export const FILE_SHARE_DELETE = 0x4;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
export const FILE_ATTRIBUTE_DIRECTORY = 0x10;
export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_PATH_NOT_FOUND = 3;
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_SHARING_VIOLATION = 32;
export const ERROR_FILE_EXISTS = 80;
export const ERROR_ALREADY_EXISTS = 183;

// NtCreateFile
const OBJ_CASE_INSENSITIVE = 0x40;
const FILE_CREATE = 2;
const FILE_DIRECTORY_FILE = 0x1;
const FILE_NON_DIRECTORY_FILE = 0x40;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
const FILE_OPEN_REPARSE_POINT = 0x200000;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;

const FileIdBothDirectoryInfo = 10;
const FileIdBothDirectoryRestartInfo = 11;

interface Api {
  CreateFileW: (name: string, access: number, share: number, sa: null, disp: number, flags: number, tmpl: null) => Handle;
  CloseHandle: (h: Handle) => number;
  GetLastError: () => number;
  GetFinalPathNameByHandleW: (h: Handle, buf: Buffer, len: number, flags: number) => number;
  GetFileInformationByHandle: (h: Handle, buf: Buffer) => number;
  GetFileInformationByHandleEx: (h: Handle, cls: number, buf: Buffer, size: number) => number;
  ReadFile: (h: Handle, buf: Buffer, n: number, read: number[], ov: null) => number;
  WriteFile: (h: Handle, buf: Buffer, n: number, written: number[], ov: null) => number;
  SetEndOfFile: (h: Handle) => number;
  SetFilePointerEx: (h: Handle, dist: bigint, out: null, method: number) => number;
  NtCreateFile: (out: Handle[], access: number, oa: unknown, iosb: unknown, alloc: null, attrs: number, share: number, disp: number, opts: number, ea: null, eaLen: number) => number;
  RtlNtStatusToDosError: (status: number) => number;
}

let api: Api | null = null;
function w(): Api {
  if (api) return api;
  if (process.platform !== "win32") throw new Error("the native file helper runs only on Windows");
  const k32 = koffi.load("kernel32.dll");
  const nt = koffi.load("ntdll.dll");
  const UNICODE_STRING = koffi.struct("DASH_UNICODE_STRING", { Length: "uint16_t", MaximumLength: "uint16_t", Buffer: "void *" });
  koffi.struct("DASH_OBJECT_ATTRIBUTES", {
    Length: "uint32_t", RootDirectory: "intptr_t", ObjectName: koffi.pointer(UNICODE_STRING), Attributes: "uint32_t",
    SecurityDescriptor: "void *", SecurityQualityOfService: "void *",
  });
  koffi.struct("DASH_IO_STATUS_BLOCK", { Status: "intptr_t", Information: "uintptr_t" });
  api = {
    CreateFileW: k32.func("intptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, void *sa, uint32_t disp, uint32_t flags, void *tmpl)"),
    CloseHandle: k32.func("int __stdcall CloseHandle(intptr_t h)"),
    GetLastError: k32.func("uint32_t __stdcall GetLastError()"),
    GetFinalPathNameByHandleW: k32.func("uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t h, _Out_ uint8_t *buf, uint32_t len, uint32_t flags)"),
    GetFileInformationByHandle: k32.func("int __stdcall GetFileInformationByHandle(intptr_t h, _Out_ uint8_t *buf)"),
    GetFileInformationByHandleEx: k32.func("int __stdcall GetFileInformationByHandleEx(intptr_t h, int cls, _Out_ uint8_t *buf, uint32_t size)"),
    ReadFile: k32.func("int __stdcall ReadFile(intptr_t h, _Out_ uint8_t *buf, uint32_t n, _Out_ uint32_t *read, void *ov)"),
    WriteFile: k32.func("int __stdcall WriteFile(intptr_t h, const uint8_t *buf, uint32_t n, _Out_ uint32_t *written, void *ov)"),
    SetEndOfFile: k32.func("int __stdcall SetEndOfFile(intptr_t h)"),
    SetFilePointerEx: k32.func("int __stdcall SetFilePointerEx(intptr_t h, int64_t dist, void *out, uint32_t method)"),
    NtCreateFile: nt.func("uint32_t __stdcall NtCreateFile(_Out_ intptr_t *h, uint32_t access, DASH_OBJECT_ATTRIBUTES *oa, _Out_ DASH_IO_STATUS_BLOCK *iosb, void *alloc, uint32_t attrs, uint32_t share, uint32_t disp, uint32_t opts, void *ea, uint32_t eaLen)"),
    RtlNtStatusToDosError: nt.func("uint32_t __stdcall RtlNtStatusToDosError(uint32_t status)"),
  } as unknown as Api;
  return api;
}

const invalid = (h: Handle) => h === -1 || h === -1n || h === 0 || h === 0n;

/**
 * Opens an existing file or directory without following a reparse point at its last component.
 * (Backup semantics are needed to open directories; for files they change nothing for a normal user.)
 */
export function openNoFollow(path: string, access: number, share: number): Handle {
  const a = w();
  const h = a.CreateFileW(path, access, share, null, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, null);
  if (invalid(h)) throw new Win32Error("CreateFileW", a.GetLastError());
  return h;
}

export function close(h: Handle): void {
  w().CloseHandle(h);
}

/** The real path of an open handle, e.g. "\\?\C:\Data\a.txt" (VOLUME_NAME_DOS). */
export function finalPath(h: Handle): string {
  const a = w();
  let size = 1024;
  for (;;) {
    const buf = Buffer.alloc(size * 2);
    const n = a.GetFinalPathNameByHandleW(h, buf, size, 0);
    if (n === 0) throw new Win32Error("GetFinalPathNameByHandleW", a.GetLastError());
    if (n < size) return buf.toString("utf16le", 0, n * 2);
    size = n + 1;
  }
}

export interface HandleInfo { attributes: number; size: number; modifiedAt: string; links: number; isDirectory: boolean; isReparse: boolean }

function filetimeToIso(lo: number, hi: number): string {
  const t = (BigInt(hi) << 32n) | BigInt(lo);
  return new Date(Number(t / 10000n - 11644473600000n)).toISOString();
}

export function info(h: Handle): HandleInfo {
  const a = w();
  const b = Buffer.alloc(52);
  if (!a.GetFileInformationByHandle(h, b)) throw new Win32Error("GetFileInformationByHandle", a.GetLastError());
  const attributes = b.readUInt32LE(0);
  const size = b.readUInt32LE(32) * 2 ** 32 + b.readUInt32LE(36);
  return {
    attributes,
    size,
    modifiedAt: filetimeToIso(b.readUInt32LE(20), b.readUInt32LE(24)),
    links: b.readUInt32LE(40),
    isDirectory: (attributes & FILE_ATTRIBUTE_DIRECTORY) !== 0,
    isReparse: (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
  };
}

/** Reads the whole file from the start, up to `max` bytes (throws if larger). */
export function readAll(h: Handle, size: number, max: number): Buffer {
  const a = w();
  if (size > max) throw new Error("TooLarge");
  if (!a.SetFilePointerEx(h, 0n, null, 0)) throw new Win32Error("SetFilePointerEx", a.GetLastError());
  const buf = Buffer.alloc(size + 1);
  let off = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(1 << 20, buf.length - off));
    if (chunk.length === 0) break;
    const got = [0];
    if (!a.ReadFile(h, chunk, chunk.length, got, null)) throw new Win32Error("ReadFile", a.GetLastError());
    if (got[0] === 0) break;
    chunk.copy(buf, off, 0, got[0]);
    off += got[0];
  }
  if (off > size) throw new Error("TooLarge");   // grew while reading
  return buf.subarray(0, off);
}

export function writeAll(h: Handle, data: Uint8Array, truncate: boolean, append: boolean): void {
  const a = w();
  if (!a.SetFilePointerEx(h, 0n, null, append ? 2 : 0)) throw new Win32Error("SetFilePointerEx", a.GetLastError());
  if (truncate && !a.SetEndOfFile(h)) throw new Win32Error("SetEndOfFile", a.GetLastError());
  let off = 0;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  while (off < buf.length) {
    const part = buf.subarray(off, Math.min(buf.length, off + (1 << 20)));
    const n = [0];
    if (!a.WriteFile(h, part, part.length, n, null)) throw new Win32Error("WriteFile", a.GetLastError());
    off += n[0];
  }
}

/** Creates a new file or directory named `name` inside the directory `dir` (a verified handle). Fails if it exists. */
export function createChild(dir: Handle, name: string, directory: boolean): Handle {
  const a = w();
  const nameBuf = Buffer.from(name + "\0", "utf16le");
  const us = { Length: name.length * 2, MaximumLength: name.length * 2 + 2, Buffer: nameBuf };
  const oa = { Length: 48, RootDirectory: dir, ObjectName: us, Attributes: OBJ_CASE_INSENSITIVE, SecurityDescriptor: null, SecurityQualityOfService: null };
  const out: Handle[] = [0];
  const iosb = {};
  const access = directory ? FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE : GENERIC_WRITE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  const opts = (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT;
  const st = a.NtCreateFile(out, access, oa, iosb, null, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_CREATE, opts, null, 0) >>> 0;
  if (st !== 0) {
    if (st === STATUS_OBJECT_NAME_COLLISION) throw new Win32Error("NtCreateFile", ERROR_FILE_EXISTS);
    throw new Win32Error("NtCreateFile", a.RtlNtStatusToDosError(st));
  }
  return out[0];
}

export interface DirEntry { name: string; isDirectory: boolean; isReparse: boolean; size: number; modifiedAt: string }

/** Lists a directory from its verified handle (names and types only; "." and ".." skipped). */
export function listDir(h: Handle): DirEntry[] {
  const a = w();
  const out: DirEntry[] = [];
  const buf = Buffer.alloc(64 * 1024);
  let cls = FileIdBothDirectoryRestartInfo;
  for (;;) {
    if (!a.GetFileInformationByHandleEx(h, cls, buf, buf.length)) {
      const e = a.GetLastError();
      if (e === 18 /* ERROR_NO_MORE_FILES */) break;
      throw new Win32Error("GetFileInformationByHandleEx", e);
    }
    cls = FileIdBothDirectoryInfo;
    let off = 0;
    for (;;) {
      const next = buf.readUInt32LE(off);
      const lastWrite = buf.readBigInt64LE(off + 24);
      const eof = Number(buf.readBigInt64LE(off + 40));
      const attrs = buf.readUInt32LE(off + 56);
      const nameLen = buf.readUInt32LE(off + 60);
      const name = buf.toString("utf16le", off + 104, off + 104 + nameLen);
      if (name !== "." && name !== "..") {
        out.push({
          name,
          isDirectory: (attrs & FILE_ATTRIBUTE_DIRECTORY) !== 0,
          isReparse: (attrs & FILE_ATTRIBUTE_REPARSE_POINT) !== 0,
          size: eof,
          modifiedAt: new Date(Number(lastWrite / 10000n - 11644473600000n)).toISOString(),
        });
      }
      if (next === 0) break;
      off += next;
    }
  }
  return out;
}
