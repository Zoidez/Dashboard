/**
 * Permission display rules (docs/PERMISSIONS.md): one plain-words line per permission, single
 * markings (red section 3, yellow section 3a) and dangerous combinations (section 4, D1-D3).
 * Used by the approval dialog now and by the approval canvas later.
 */
import os from "node:os";
import { join, resolve } from "node:path";
import { fsScopeCovers, type Permission } from "../broker/permissions.js";
import { nonPublicReason } from "../broker/net.js";

export interface Line { text: string; reason: string; marks: Array<{ level: "red" | "yellow"; tag: string; why: string }> }
export interface Combination { id: "D1" | "D2" | "D3"; sentence: string; lines: number[] }
export interface Display { lines: Line[]; combinations: Combination[]; red: boolean; yellow: boolean }

const SYSINFO_WORDS: Record<string, string> = {
  cpu: "processor load", memory: "memory use", disk: "disk space", network: "network adapter names and traffic",
  os: "Windows version and computer name", battery: "battery level", gpu: "graphics card", processes: "the names of running programs",
};

export function lineText(p: Permission, taskName: (id: string) => string): string {
  const sub = (r?: boolean) => (r ? " and all its subfolders" : "");
  switch (p.type) {
    case "fs.read": return `Read files in ${p.path}${sub(p.recursive)}`;
    case "fs.write": return `Create and change files in ${p.path}${sub(p.recursive)}`;
    case "fs.delete": return `Delete files in ${p.path}${sub(p.recursive)}. Deleted files go to the Recycle Bin.`;
    case "net.http": {
      const sends = p.methods.some((m) => m !== "GET" && m !== "HEAD");
      const where = `${p.origin}${p.pathPrefix && p.pathPrefix !== "/" ? ` (paths starting ${p.pathPrefix})` : ""}`;
      return sends ? `Send data to and fetch data from ${where}` : `Fetch data from ${where}`;
    }
    case "sysinfo": return `Read your computer's ${p.fields.map((f) => SYSINFO_WORDS[f] ?? f).join(", ")}`;
    case "reports.read": return `Read the reports of your scheduled task "${taskName(p.taskId)}"`;
    case "links.open": return p.any ? "Open any web link in your browser" : `Open links to ${(p.origins ?? []).join(", ")} in your browser`;
  }
}

/** Folders whose damage is large (PERMISSIONS.md 3): drive roots, the user folder and its top-level folders. */
function broadFolders(): string[] {
  const home = os.homedir();
  return [home, ...["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos", "AppData", "OneDrive"].map((f) => join(home, f))];
}
function startupFolders(): string[] {
  const appData = process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming");
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  return [join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup"), join(programData, "Microsoft", "Windows", "Start Menu", "Programs", "StartUp")];
}
const same = (a: string, b: string) => resolve(a).toLowerCase().replace(/\\+$/, "") === resolve(b).toLowerCase().replace(/\\+$/, "");
const isDriveRoot = (p: string) => /^[A-Za-z]:\\?$/.test(p);

export function display(perms: readonly Permission[], taskName: (id: string) => string = (id) => id): Display {
  const lines: Line[] = perms.map((p) => ({ text: lineText(p, taskName), reason: p.reason, marks: [] }));
  perms.forEach((p, i) => {
    const mark = (level: "red" | "yellow", tag: string, why: string) => lines[i].marks.push({ level, tag, why });
    if (p.type === "fs.write" || p.type === "fs.delete") {
      if (isDriveRoot(p.path) || broadFolders().some((f) => same(f, p.path) || (p.recursive && fsScopeCovers(p.path, true, f)))) mark("red", "R", "can change or delete a large part of your files");
    }
    if (p.type.startsWith("fs.") && "path" in p && startupFolders().some((f) => fsScopeCovers(p.path, p.recursive ?? false, f) || fsScopeCovers(f, true, p.path))) {
      mark("red", "R", "can make programs start with Windows");
    }
    if (p.type === "net.http") {
      const host = new URL(p.origin).hostname.replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "127.0.0.1") mark("red", "R", "can talk to programs running on this computer");
      else if (nonPublicReason(host) !== null && nonPublicReason(host) !== "not an IP address") mark("red", "R", "can talk to devices on your local network or to this computer");
    }
    if (p.type === "links.open" && p.any) mark("yellow", "Y", "can open any web link in your browser. A link's address can carry what the card reads.");
  });

  const combos: Combination[] = [];
  const idx = (pred: (p: Permission) => boolean) => perms.map((p, i) => (pred(p) ? i : -1)).filter((i) => i >= 0);
  const readers = idx((p) => p.type === "fs.read" || p.type === "reports.read" || p.type === "sysinfo");
  const nets = idx((p) => p.type === "net.http");
  const writers = idx((p) => p.type === "fs.write");
  const origins = nets.map((i) => (perms[i] as Extract<Permission, { type: "net.http" }>).origin).join(", ");
  if (readers.length && nets.length) {
    const what = readers.map((i) => lines[i].text.replace(/^Read (the |your computer's )?/i, "")).join("; ");
    combos.push({ id: "D1", sentence: `Can read ${what} and send it to ${origins}.`, lines: [...readers, ...nets] });
  }
  if (nets.length && writers.length) {
    combos.push({ id: "D2", sentence: `Can download data from ${origins} and save it into ${writers.map((i) => (perms[i] as { path: string }).path).join(", ")}.`, lines: [...nets, ...writers] });
  }
  for (const r of idx((p) => p.type === "fs.read")) {
    for (const w of idx((p) => p.type === "fs.write" || p.type === "fs.delete")) {
      const a = perms[r] as { path: string; recursive?: boolean }, b = perms[w] as { path: string; recursive?: boolean };
      const overlap = fsScopeCovers(a.path, a.recursive ?? false, b.path) || fsScopeCovers(b.path, b.recursive ?? false, a.path);
      if (overlap && (lines[r].marks.some((m) => m.level === "red") || lines[w].marks.some((m) => m.level === "red"))) {
        combos.push({ id: "D3", sentence: `Can read and rewrite or delete ${a.path}.`, lines: [r, w] });
      }
    }
  }
  for (const c of combos) for (const i of c.lines) lines[i].marks.push({ level: "red", tag: c.id, why: c.sentence });
  return {
    lines,
    combinations: combos,
    red: lines.some((l) => l.marks.some((m) => m.level === "red")),
    yellow: lines.some((l) => l.marks.some((m) => m.level === "yellow")),
  };
}
