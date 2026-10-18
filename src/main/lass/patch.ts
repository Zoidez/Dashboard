/**
 * A fix run's patch (docs/LASS.md 8), as the host reads it: which files it changes, which of those are
 * security-relevant (listed first, in red), and whether the patch may be applied at all. The fix run
 * worked from untrusted input, so the host never takes its word for what changed: the list comes from
 * the patch text itself, and Windows' git checks it again (`git apply --numstat`) before applying.
 */

export interface PatchFile {
  path: string;
  change: "added" | "deleted" | "modified" | "renamed";
  /** Renames: the old path. */
  from?: string;
  security: boolean;
  /** Why it is security-relevant, in plain words. */
  why?: string;
}

export interface PatchReview { files: PatchFile[]; refused: string[]; added: number; removed: number }

export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Paths a fix may never change (LASS.md 8: host invariants, the spike, approvals, the login, scheduled tasks; plus the repository's own machinery). */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/^Build\//i, "the instance folder (approvals, login, data) is not part of the source"],
  [/^tools\//i, "the project's own Node is not part of the source"],
  [/^node_modules\//i, "installed packages"],
  [/(^|\/)\.git(\/|$)/i, "git's own files"],
  [/^spikes\//i, "the spike (the CLI security test) is changed only by a person"],
  [/^docs\/RULES\.md$/i, "the host invariants are changed only by the user"],
  [/^setup\/setup-generator-account\.ps1$/i, "withdrawn script"],
  [/^\.gitmodules$/i, "submodules"],
];

/** Security-relevant paths (shown first and in red): what enforces the invariants, tests it, builds it, or describes it. */
const SECURITY: Array<[RegExp, string]> = [
  [/^src\/(main|preload|card-runtime|filehelper)\//, "the security core of the Dashboard (needs the security tests)"],
  [/^src\/shared\//, "code shared with the security core"],
  [/^test\//, "the tests that prove the security rules"],
  [/^scripts\//, "build, packaging and test scripts (including the one that records the security tests)"],
  [/^launcher\//, "the launcher that starts and rolls back builds"],
  [/^(infra|setup)\//, "the container and machine set-up"],
  [/^spec\//, "machine-readable rules (manifest schema, host API)"],
  [/^(package\.json|package-lock\.json)$/, "dependencies: new code from the internet"],
  [/^(electron-builder\.json|tsconfig\.json|\.gitignore|\.gitattributes)$/, "build and repository settings"],
  [/^CLAUDE\.md$/, "the instructions every Claude session follows"],
  [/^docs\/(VALIDATOR|PERMISSIONS|GENERATOR-PROMPT|ARCHITECTURE|LASS|INFRASTRUCTURE)\.md$/, "the security design"],
];

/** A path from the patch is used as is only when it is plain: relative, forward slashes, no "..", no Windows tricks. */
export function plainPath(p: string): boolean {
  if (!p || p.length > 300 || p.startsWith("/") || p.includes("\\") || p.includes(":") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[. ]$/.test(seg) && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(seg) && /^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]*$/.test(seg));
}

export function classify(path: string): { security: boolean; why?: string } {
  for (const [re, why] of SECURITY) if (re.test(path)) return { security: true, why };
  return { security: false };
}

/** Reads a `git diff` patch. Anything git could do besides changing plain text files is refused. */
export function reviewPatch(text: string): PatchReview {
  const refused: string[] = [];
  const files: PatchFile[] = [];
  let added = 0, removed = 0;
  if (Buffer.byteLength(text, "utf8") > MAX_PATCH_BYTES) refused.push(`the patch is larger than ${MAX_PATCH_BYTES / 1024 / 1024} MB`);
  if (!text.trim()) refused.push("the patch is empty: the fix run changed nothing");
  let cur: PatchFile | null = null;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) { refused.push(`unusual file name in: ${line.slice(0, 120)}`); cur = null; continue; }
      if (m[1] !== m[2]) { cur = { path: m[2], from: m[1], change: "renamed", ...classify(m[2]) }; }
      else cur = { path: m[2], change: "modified", ...classify(m[2]) };
      files.push(cur);
      continue;
    }
    if (!cur) { if (line.trim() && !inHunk) refused.push(`text outside a file section: ${line.slice(0, 80)}`); continue; }
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
      else if (line.startsWith("\\") || line.startsWith(" ") || line === "") { /* context */ }
      else inHunk = false;
      if (inHunk) continue;
    }
    if (line.startsWith("new file mode ")) { cur.change = "added"; if (!/^new file mode 100(644|755)$/.test(line)) refused.push(`${cur.path}: ${line} (only plain files)`); }
    else if (line.startsWith("deleted file mode ")) { cur.change = "deleted"; if (!/^deleted file mode 100(644|755)$/.test(line)) refused.push(`${cur.path}: ${line} (only plain files)`); }
    else if (/^(old|new) mode /.test(line)) { if (!/^(old|new) mode 100(644|755)$/.test(line)) refused.push(`${cur.path}: ${line} (only plain files)`); }
    else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("similarity index ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) { /* header */ }
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") refused.push(`${cur.path}: binary changes cannot be reviewed`);
    else if (line.startsWith("copy from ") || line.startsWith("copy to ") || line.startsWith("dissimilarity index ")) { /* header */ }
    else if (line.trim()) refused.push(`${cur.path}: unexpected line: ${line.slice(0, 80)}`);
  }
  for (const f of files) {
    for (const p of [f.path, ...(f.from ? [f.from] : [])]) {
      if (!plainPath(p)) { refused.push(`${JSON.stringify(p).slice(0, 80)}: not a plain path`); continue; }
      const bad = FORBIDDEN.find(([re]) => re.test(p));
      if (bad) refused.push(`${p}: ${bad[1]}`);
    }
  }
  files.sort((a, b) => Number(b.security) - Number(a.security) || a.path.localeCompare(b.path));
  return { files, refused: [...new Set(refused)], added, removed };
}

/** `git apply --numstat` output -> paths (renames shown by git as "old => new" or "dir/{a => b}"). */
export function numstatPaths(out: string): string[] {
  const paths: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const p = m[3];
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
    if (brace) paths.push(`${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, "/"));
    else if (p.includes(" => ")) paths.push(p.split(" => ")[1]);
    else paths.push(p);
  }
  return paths;
}
