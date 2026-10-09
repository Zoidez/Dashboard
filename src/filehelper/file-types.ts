/**
 * File type rules (part of the file check protocol, ARCHITECTURE.md 4a).
 * A file is served or written only if its extension is known here AND its bytes really are that
 * type. Unknown extensions, files without an extension and every program or script type are refused.
 * Add a type here, with a content check, to make it available to cards.
 */

export interface FileType {
  /** Shown in plain words in errors and on the approval canvas later. */
  label: string;
  text: boolean;
  /** Cards may create or overwrite files of this type. */
  writable: boolean;
  /** Cards may append to files of this type (line-based text only). */
  appendable: boolean;
  /** null if the bytes are this type; otherwise the reason. */
  check(bytes: Uint8Array): string | null;
}

const starts = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Text: UTF-8 (optional BOM) or UTF-16 with BOM; no NUL; no control characters except tab, LF, CR, FF. */
export function decodeText(b: Uint8Array): { text: string } | { error: string } {
  let text: string;
  try {
    if (starts(b, [0xff, 0xfe])) text = new TextDecoder("utf-16le", { fatal: true }).decode(b.subarray(2));
    else if (starts(b, [0xfe, 0xff])) text = new TextDecoder("utf-16be", { fatal: true }).decode(b.subarray(2));
    else text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    return { error: "is not valid text (UTF-8 or UTF-16)" };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(text)) return { error: "contains binary control characters, so it is not a text file" };
  return { text };
}

const textCheck = (extra?: (t: string) => string | null) => (b: Uint8Array) => {
  const d = decodeText(b);
  if ("error" in d) return d.error;
  return extra ? extra(d.text) : null;
};
const jsonCheck = textCheck((t) => { try { JSON.parse(t.replace(/^﻿/, "")); return null; } catch { return "is not valid JSON"; } });
const markupCheck = textCheck((t) => (/^﻿?\s*</.test(t) ? null : "does not start like XML"));
const sig = (label: string, test: (b: Uint8Array) => boolean) => (b: Uint8Array) => (test(b) ? null : `is not a ${label} file (its content does not match)`);

const T = (label: string, opts: { writable?: boolean; appendable?: boolean; check?: FileType["check"] } = {}): FileType =>
  ({ label, text: true, writable: opts.writable ?? true, appendable: opts.appendable ?? false, check: opts.check ?? textCheck() });
const B = (label: string, test: (b: Uint8Array) => boolean, writable: boolean): FileType =>
  ({ label, text: false, writable, appendable: false, check: sig(label, test) });

const riff = (form: string) => (b: Uint8Array) => starts(b, ascii("RIFF")) && starts(b, ascii(form), 8);
const zip = (b: Uint8Array) => starts(b, [0x50, 0x4b, 0x03, 0x04]) || starts(b, [0x50, 0x4b, 0x05, 0x06]);
const ftyp = (b: Uint8Array) => starts(b, ascii("ftyp"), 4);
const mp3 = (b: Uint8Array) => starts(b, ascii("ID3")) || (b.length > 1 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0);

export const FILE_TYPES: Readonly<Record<string, FileType>> = {
  // text
  ".txt": T("text", { appendable: true }),
  ".md": T("Markdown", { appendable: true }),
  ".markdown": T("Markdown", { appendable: true }),
  ".log": T("log", { appendable: true }),
  ".csv": T("CSV", { appendable: true }),
  ".tsv": T("TSV", { appendable: true }),
  ".json": T("JSON", { check: jsonCheck }),
  ".xml": T("XML", { check: markupCheck }),
  ".yaml": T("YAML"),
  ".yml": T("YAML"),
  ".ini": T("INI"),
  ".toml": T("TOML"),
  // read-only text: a browser runs scripts in these when the user opens them
  ".html": T("HTML", { writable: false, check: markupCheck }),
  ".htm": T("HTML", { writable: false, check: markupCheck }),
  ".svg": T("SVG", { writable: false, check: markupCheck }),
  // images
  ".png": B("PNG", (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), true),
  ".jpg": B("JPEG", (b) => starts(b, [0xff, 0xd8, 0xff]), true),
  ".jpeg": B("JPEG", (b) => starts(b, [0xff, 0xd8, 0xff]), true),
  ".gif": B("GIF", (b) => starts(b, ascii("GIF87a")) || starts(b, ascii("GIF89a")), true),
  ".webp": B("WebP", riff("WEBP"), true),
  ".bmp": B("BMP", (b) => starts(b, ascii("BM")), true),
  ".ico": B("icon", (b) => starts(b, [0, 0, 1, 0]), false),
  // documents and archives (read-only: archives and office files can carry programs or macros)
  ".pdf": B("PDF", (b) => starts(b, ascii("%PDF-")), true),
  ".zip": B("ZIP", zip, false),
  ".docx": B("Word document", zip, false),
  ".xlsx": B("Excel workbook", zip, false),
  ".pptx": B("PowerPoint presentation", zip, false),
  ".odt": B("OpenDocument text", zip, false),
  ".gz": B("gzip", (b) => starts(b, [0x1f, 0x8b]), false),
  ".7z": B("7-Zip", (b) => starts(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), false),
  // audio and video
  ".mp3": B("MP3", mp3, true),
  ".wav": B("WAV", riff("WAVE"), true),
  ".flac": B("FLAC", (b) => starts(b, ascii("fLaC")), true),
  ".ogg": B("Ogg", (b) => starts(b, ascii("OggS")), true),
  ".mp4": B("MP4", ftyp, false),
  ".m4a": B("M4A", ftyp, false),
  ".mov": B("QuickTime", ftyp, false),
};

/**
 * Never written, whatever the card asks (they run code when opened). Listed so the refusal names
 * the reason; they are also absent from FILE_TYPES, so they can never be read either.
 */
export const PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".dll", ".sys", ".com", ".scr", ".cpl", ".msi", ".msp", ".msc", ".bat", ".cmd", ".ps1", ".psm1", ".psd1",
  ".vbs", ".vbe", ".js", ".jse", ".mjs", ".wsf", ".wsh", ".hta", ".lnk", ".url", ".reg", ".jar", ".py", ".pyw",
  ".sh", ".application", ".appref-ms", ".chm", ".inf", ".scf", ".library-ms", ".search-ms", ".settingcontent-ms",
  ".docm", ".xlsm", ".pptm", ".dotm", ".xlam",
]);

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}
