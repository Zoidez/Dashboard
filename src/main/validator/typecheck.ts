/**
 * VALIDATOR.md V3: ui.js and worker.js are type-checked as JavaScript (checkJs) against
 * spec/host-api.d.ts. The exported lifecycle functions get their parameter types injected as JSDoc
 * for the check only (the card's files are not changed), so every api.* use is checked: unknown
 * members (api.ffi), wrong argument types and misuse fail.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface TypecheckInput {
  files: Record<string, string>;
  hostApiDts: string;
  /** Folder with TypeScript's lib.*.d.ts files saved as .txt (the packaged app strips .d.ts); default: TypeScript's own. */
  libDir?: string;
}

const LIFECYCLE: Record<string, string[]> = {
  "ui.js": ["mount", "unmount"],
  "worker.js": ["start", "tick", "stop"],
};
const PARAM_TYPES: Record<string, string[]> = {
  mount: ["HTMLElement", "HostApi"],
  unmount: [],
  start: ["HostApi"],
  tick: ["HostApi"],
  stop: [],
};

/** Inserts a JSDoc block with parameter types before each exported lifecycle function; returns where lines were added. */
export function annotate(file: string, source: string): { text: string; added: Array<{ beforeLine: number; lines: number }> } {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  const inserts: Array<{ pos: number; text: string }> = [];
  const names = new Set(LIFECYCLE[file] ?? []);
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name || !names.has(st.name.text)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const types = PARAM_TYPES[st.name.text];
    const tags = st.parameters.map((p, i) => (ts.isIdentifier(p.name) && types[i] ? ` * @param {${types[i]}} ${p.name.text}` : null)).filter(Boolean);
    if (tags.length) inserts.push({ pos: st.getStart(sf), text: `/**\n${tags.join("\n")}\n */\n` });
  }
  let out = source;
  for (const ins of inserts.sort((a, b) => b.pos - a.pos)) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  const added = inserts.map((i) => ({ beforeLine: sf.getLineAndCharacterOfPosition(i.pos).line + 1, lines: i.text.split("\n").length - 1 })).sort((a, b) => a.beforeLine - b.beforeLine);
  return { text: out, added };
}

export function typecheck(input: TypecheckInput): string[] {
  const root = "/card/";
  const sources = new Map<string, string>();
  // The host API's declarations become global types for the check (no module resolution needed).
  sources.set(root + "host-api.d.ts", input.hostApiDts.replace(/^export\s+/gm, ""));
  const shifts = new Map<string, Array<{ beforeLine: number; lines: number }>>();
  for (const [name, text] of Object.entries(input.files)) {
    if (name !== "ui.js" && name !== "worker.js") continue;
    const a = annotate(name, text);
    sources.set(root + name, a.text);
    shifts.set(name, a.added);
  }
  /** Maps a line of the annotated text back to the card's own line. */
  const original = (file: string, line: number) => {
    let shift = 0;
    for (const s of shifts.get(file) ?? []) { if (line > s.beforeLine + shift + s.lines - 1) shift += s.lines; else break; }
    return line - shift;
  };
  const options: ts.CompilerOptions = {
    allowJs: true, checkJs: true, noEmit: true, strict: false, noImplicitAny: false,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], types: [], skipLibCheck: true,
  };
  const defaultHost = ts.createCompilerHost(options);
  const LIB = "/tslib";
  const libText = (f: string): string | undefined => {
    if (!input.libDir || !norm(f).startsWith(LIB + "/")) return undefined;
    try { return readFileSync(join(input.libDir, basename(f) + ".txt"), "utf8"); } catch { return undefined; }
  };
  const host: ts.CompilerHost = {
    ...defaultHost,
    ...(input.libDir ? { getDefaultLibLocation: () => LIB, getDefaultLibFileName: (o: ts.CompilerOptions) => `${LIB}/${ts.getDefaultLibFileName(o)}` } : {}),
    fileExists: (f) => sources.has(norm(f)) || libText(f) !== undefined || defaultHost.fileExists(f),
    readFile: (f) => sources.get(norm(f)) ?? libText(f) ?? defaultHost.readFile(f),
    getSourceFile: (f, lang) => {
      const text = sources.get(norm(f)) ?? libText(f);
      return text !== undefined ? ts.createSourceFile(f, text, lang, true) : defaultHost.getSourceFile(f, lang);
    },
    writeFile: () => undefined,
    getCurrentDirectory: () => root,
  };
  const program = ts.createProgram([...sources.keys()], options, host);
  const out: string[] = [];
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (d.category !== ts.DiagnosticCategory.Error) continue;
    if (d.code === 2307 || d.code === 2792) continue;       // "cannot find module": V4 reports imports and require() in plain words
    const f = d.file?.fileName ? norm(d.file.fileName) : "";
    if (!f.endsWith(".js")) continue;                        // only the card's own files
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
    const name = f.slice(root.length);
    out.push(`${name}:${original(name, line)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  }
  return out;
}

function norm(f: string): string {
  return f.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
}
