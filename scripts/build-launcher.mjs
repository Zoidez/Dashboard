// Compiles the launcher (launcher/Launcher.cs, docs/LASS.md 8) with the C# compiler that ships with
// Windows (.NET Framework 4), into the given file (normally Build\Dashboard.exe).
//   node scripts/build-launcher.mjs <out.exe>
// Also usable as a module: buildLauncher(outExe).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeIcon } from "./icon.mjs";

export const CSC = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "launcher", "Launcher.cs");

/** An .ico that holds one 256 px PNG (Windows Vista and later read PNG icons). */
function writeIco(file) {
  const png = join(tmpdir(), `dashboard-icon-${process.pid}.png`);
  writeIcon(png, 256);
  const data = readFileSync(png);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(0, 6); head.writeUInt8(0, 7); head.writeUInt8(0, 8); head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(data.length, 14); head.writeUInt32LE(22, 18);
  writeFileSync(file, Buffer.concat([head, data]));
}

export function buildLauncher(outExe) {
  if (!existsSync(CSC)) throw new Error(`C# compiler not found at ${CSC}`);
  mkdirSync(dirname(outExe), { recursive: true });
  const ico = join(tmpdir(), `dashboard-launcher-${process.pid}.ico`);
  writeIco(ico);
  execFileSync(CSC, ["/nologo", "/target:winexe", "/optimize+", `/win32icon:${ico}`, `/out:${outExe}`, "/r:System.Web.Extensions.dll", "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", SRC], { stdio: "pipe" });
  return outExe;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) { console.error("usage: node scripts/build-launcher.mjs <out.exe>"); process.exit(2); }
  try { console.log(`launcher: ${buildLauncher(resolve(out))}`); }
  catch (e) { console.error(String(e.stdout ?? "") + String(e.message)); process.exit(1); }
}
