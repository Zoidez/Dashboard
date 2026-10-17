/**
 * The validator (docs/VALIDATOR.md). Decides whether a generated card may be shown for approval.
 * Stages run in order and the first failing stage stops the run:
 *   V0 staging hygiene  V1 manifest  V2 permissions  V3 typecheck  V4 static checks  V5 smoke test
 * The files are read once into memory; every later stage (and the approval) uses those bytes.
 */
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join, posix } from "node:path";
import type { Permission } from "../broker/permissions.js";
import { FORBIDDEN_PERMISSION_TYPES, fsScopeCovers } from "../broker/permissions.js";
import { isCardFilePath } from "../cards/approvals.js";
import { isInsideInstance } from "../instance.js";
import { checkSyntax, PathSyntaxError } from "../../filehelper/path-syntax.js";
import { staticChecks, svgChecks, themeWarnings, type ApiUse } from "./static-checks.js";
import { typecheck } from "./typecheck.js";

export type Stage = "V0" | "V1" | "V2" | "V3" | "V4" | "V5";
/** warnings never fail a stage (theme warnings in V4); they are shown to the user and sent with a retry. */
export interface StageResult { stage: Stage; title: string; errors: string[]; warnings?: string[] }
export interface Manifest { id: string; name: string; version: string; apiVersion: 0; worker?: boolean; permissions: Permission[]; [k: string]: unknown }

export interface ValidationInput {
  /** The request folder in ClaudeExchange/staging/<card-id>/<request-id>/. */
  dir: string;
  cardId: string;
  instanceRoot: string;
  /** For an update: the installed version (the new one must be higher). */
  installedVersion?: string;
  /** Task ids of the watched feeds (Options > Feeds). */
  feedTaskIds: string[];
  manifestSchema: object;
  hostApiDts: string;
  /** TypeScript lib files as .txt (packaged app); see typecheck.ts. */
  tsLibDir?: string;
  /** VALIDATOR.md: an untested host does not judge cards. null = this build passed its security suite. */
  hostSuiteProblem: string | null;
  /** V5, run by the host in the real card runtime with a deny-all broker. */
  smoke?: (card: LoadedCard) => Promise<string[]>;
}

export interface LoadedCard { cardId: string; manifest: Manifest; files: Record<string, Buffer>; hashes: Record<string, string> }
export type ValidationResult = { ok: true; card: LoadedCard; stages: StageResult[] } | { ok: false; stages: StageResult[]; card?: LoadedCard };

export const LIMITS = { totalBytes: 2 * 1024 * 1024, codeBytes: 512 * 1024, otherBytes: 2 * 1024 * 1024 };
const TITLES: Record<Stage, string> = {
  V0: "Staging hygiene", V1: "Manifest", V2: "Permissions", V3: "Type check", V4: "Static security checks", V5: "Smoke test with zero capabilities",
};
const FORBIDDEN_NAMES = new Set([".claude", ".mcp.json", "claude.md", "claude.local.md"]);
const HOST_REF_FOLDER = "_ref";              // reference files the host copied in for the model; never part of the card

// ---------- V0 ----------

/** Lists the request folder, refusing links and forbidden files; reads every card file once. */
async function stageV0(dir: string, streamsOf?: (p: string) => string[]): Promise<{ errors: string[]; files: Record<string, Buffer> }> {
  const errors: string[] = [];
  const files: Record<string, Buffer> = {};
  let total = 0;
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch (e) { errors.push(`cannot read ${rel || "the request folder"}: ${(e as Error).message}`); return; }
    for (const ent of entries) {
      const r = rel ? posix.join(rel, ent.name) : ent.name;
      const p = join(abs, ent.name);
      if (!rel && ent.name === HOST_REF_FOLDER) continue;
      if (FORBIDDEN_NAMES.has(ent.name.toLowerCase())) { errors.push(`${r}: not allowed in a card (project settings, MCP config or CLAUDE.md)`); continue; }
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) { errors.push(`${r}: links (junctions, symbolic links) are not allowed`); continue; }
      if (ent.name.startsWith(".")) { errors.push(`${r}: hidden files are not allowed`); continue; }
      if (st.isDirectory()) {
        if (r !== "assets") { errors.push(`${r}/: only an assets/ folder is allowed`); continue; }
        await walk(p, r);
        continue;
      }
      if (!st.isFile()) { errors.push(`${r}: not a regular file`); continue; }
      if (!isCardFilePath(r)) { errors.push(`${r}: not an allowed card file (manifest.json, ui.js, worker.js, DEVLOG.md, assets/*.png|svg|webp|woff2)`); continue; }
      if (streamsOf) {
        try {
          const extra = streamsOf(p).filter((s) => s.toUpperCase() !== "::$DATA");
          if (extra.length) { errors.push(`${r}: has hidden alternate data streams (${extra.join(", ")})`); continue; }
        } catch (e) { errors.push(`${r}: its streams cannot be checked: ${(e as Error).message}`); continue; }
      }
      const isCode = r.endsWith(".js");
      const limit = isCode ? LIMITS.codeBytes : LIMITS.otherBytes;
      if (st.size > limit) { errors.push(`${r}: ${st.size} bytes, over the ${limit}-byte limit`); continue; }
      total += st.size;
      const data = await fsp.readFile(p);
      if (/\.(js|json|md|svg)$/.test(r)) {
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { errors.push(`${r}: not valid UTF-8 text`); continue; }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) { errors.push(`${r}: contains control characters`); continue; }
      }
      files[r] = data;
    }
  };
  await walk(dir, "");
  if (total > LIMITS.totalBytes) errors.push(`the card is ${total} bytes, over the ${LIMITS.totalBytes}-byte limit`);
  for (const need of ["manifest.json", "ui.js", "DEVLOG.md"]) if (!files[need] && !errors.some((e) => e.startsWith(need))) errors.push(`${need} is missing`);
  return { errors, files };
}

// ---------- V1 ----------

let ajvCache: { schema: object; validate: ReturnType<InstanceType<typeof Ajv2020>["compile"]> } | null = null;

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function stageV1(files: Record<string, Buffer>, input: ValidationInput): { errors: string[]; manifest?: Manifest } {
  let m: unknown;
  try { m = JSON.parse(files["manifest.json"].toString("utf8")); } catch { return { errors: ["manifest.json is not valid JSON"] }; }
  if (!ajvCache || ajvCache.schema !== input.manifestSchema) {
    const ajv = new (Ajv2020 as unknown as typeof Ajv2020)({ strict: false, allErrors: true });
    ajvCache = { schema: input.manifestSchema, validate: ajv.compile(input.manifestSchema) };
  }
  const errors: string[] = [];
  const types = Array.isArray((m as Manifest)?.permissions) ? (m as Manifest).permissions.map((p) => (p as { type?: string })?.type) : [];
  for (const t of types) if (t && FORBIDDEN_PERMISSION_TYPES.has(t)) errors.push(`permission "${t}" is ${t === "ffi.call" ? "removed: cards can never call native code" : "reserved and disabled in apiVersion 0"}`);
  if (!ajvCache.validate(m)) {
    for (const e of ajvCache.validate.errors ?? []) {
      if (e.keyword === "oneOf" || e.keyword === "not" || e.keyword === "if") continue;     // the specific errors are listed separately
      errors.push(`manifest${e.instancePath || ""}: ${e.message}${e.params && "additionalProperty" in e.params ? ` (${(e.params as { additionalProperty: string }).additionalProperty})` : ""}`);
    }
    if (!errors.length) errors.push("manifest.json does not match the manifest schema (apiVersion 0)");
  }
  const man = m as Manifest;
  if (man && typeof man === "object") {
    if (man.id !== input.cardId) errors.push(`manifest id "${String(man.id)}" must be "${input.cardId}"`);
    if (input.installedVersion && typeof man.version === "string" && /^\d+\.\d+\.\d+$/.test(man.version) && cmpSemver(man.version, input.installedVersion) <= 0) {
      errors.push(`version ${man.version} must be higher than the installed ${input.installedVersion}`);
    }
    const hasWorker = !!files["worker.js"];
    if ((man.worker === true) !== hasWorker) errors.push(hasWorker ? "worker.js exists but manifest.worker is not true" : "manifest.worker is true but there is no worker.js");
  }
  return errors.length ? { errors: [...new Set(errors)] } : { errors: [], manifest: man };
}

// ---------- V2 (needs the API uses from V4's parse) ----------

const SYSINFO_FIELD: Record<string, string> = { cpu: "cpu", memory: "memory", disks: "disk", network: "network", os: "os", battery: "battery", gpus: "gpu", processes: "processes" };
const FS_TYPE: Record<string, string> = {
  readText: "fs.read", readBytes: "fs.read", list: "fs.read", stat: "fs.read", watch: "fs.read",
  writeText: "fs.write", writeBytes: "fs.write", appendText: "fs.write", mkdir: "fs.write", remove: "fs.delete",
};

function stageV2(man: Manifest, uses: ApiUse[], input: ValidationInput): string[] {
  const errors: string[] = [];
  const perms = man.permissions;
  // Every permission has a reason (the schema enforces length); no duplicates or overlaps of the same type.
  for (let i = 0; i < perms.length; i++) {
    for (let j = i + 1; j < perms.length; j++) {
      const a = perms[i] as Permission, b = perms[j] as Permission;
      if (a.type !== b.type) continue;
      if (JSON.stringify({ ...a, reason: "" }) === JSON.stringify({ ...b, reason: "" })) errors.push(`permission #${j + 1} duplicates #${i + 1}`);
      else if ((a.type === "fs.read" || a.type === "fs.write" || a.type === "fs.delete") && (b as typeof a).path) {
        const pa = a.path, pb = (b as typeof a).path;
        if (fsScopeCovers(pa, a.recursive ?? false, pb) || fsScopeCovers(pb, (b as typeof a).recursive ?? false, pa)) errors.push(`${a.type} permissions #${i + 1} and #${j + 1} overlap; merge them`);
      } else if (a.type === "net.http" && new URL(a.origin).origin === new URL((b as typeof a).origin).origin) errors.push(`net.http permissions #${i + 1} and #${j + 1} name the same origin; merge them`);
      else if (a.type === "sysinfo" || a.type === "links.open") errors.push(`${a.type} is listed twice (#${i + 1}, #${j + 1}); merge them`);
    }
  }
  for (const [i, p] of perms.entries()) {
    if (p.type === "fs.read" || p.type === "fs.write" || p.type === "fs.delete") {
      try {
        const path = checkSyntax(p.path);
        if (isInsideInstance(input.instanceRoot, path)) errors.push(`permission #${i + 1}: ${p.path} is inside the Dashboard's own folder (host invariant 12)`);
      } catch (e) { errors.push(`permission #${i + 1}: ${e instanceof PathSyntaxError ? e.message : String(e)}`); }
    }
    if (p.type === "reports.read" && !input.feedTaskIds.includes(p.taskId)) errors.push(`permission #${i + 1}: ${p.taskId} is not a watched feed (File > Options > Feeds)`);
  }

  // Coverage: every api use needs a permission; unused permissions fail (least privilege is a rule).
  const used = new Set<string>();
  const usedFields = new Set<string>();
  for (const u of uses) {
    if (u.ns === "fs" && FS_TYPE[u.member]) used.add(FS_TYPE[u.member]);
    if (u.ns === "net" && u.member === "request") used.add("net.http");
    if (u.ns === "sysinfo" && SYSINFO_FIELD[u.member]) { used.add("sysinfo"); usedFields.add(SYSINFO_FIELD[u.member]); }
    if (u.ns === "reports" && ["state", "history", "onChange"].includes(u.member)) used.add("reports.read");
    if (u.ns === "ui" && u.member === "openLink") used.add("links.open");
  }
  const declared = new Set(perms.map((p) => p.type));
  for (const t of used) if (!declared.has(t as Permission["type"])) errors.push(`the code uses ${t === "links.open" ? "api.ui.openLink" : `api.${t.split(".")[0]}`} but the manifest has no ${t} permission`);
  for (const [i, p] of perms.entries()) {
    if (!used.has(p.type)) errors.push(`permission #${i + 1} (${p.type}) is never used by the code; remove it`);
    if (p.type === "sysinfo") {
      for (const f of p.fields) if (!usedFields.has(f)) errors.push(`sysinfo field "${f}" is never used by the code; remove it`);
      for (const f of usedFields) if (!p.fields.includes(f as never)) errors.push(`the code reads sysinfo "${f}" but the permission does not list it`);
    }
  }
  return errors;
}

// ---------- run ----------

export async function validate(input: ValidationInput, streamsOf?: (p: string) => string[]): Promise<ValidationResult> {
  const stages: StageResult[] = [];
  const done = (stage: Stage, errors: string[], warnings?: string[]) => { stages.push({ stage, title: TITLES[stage], errors, ...(warnings?.length ? { warnings } : {}) }); return errors.length === 0; };

  const v0 = await stageV0(input.dir, streamsOf);
  if (!done("V0", v0.errors)) return { ok: false, stages };
  const files = v0.files;
  const v1 = stageV1(files, input);
  if (!done("V1", v1.errors)) return { ok: false, stages };
  const manifest = v1.manifest!;
  const hashes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p, createHash("sha256").update(b).digest("hex")]));
  const card: LoadedCard = { cardId: input.cardId, manifest, files, hashes };

  // V4's parse also feeds V2 (which api members the code uses), so it runs first, reported in order.
  const codeFiles = Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith(".js")).map(([p, b]) => [p, b.toString("utf8")]));
  const parsed = Object.entries(codeFiles).map(([p, src]) => staticChecks(p, src));
  const v4errors = parsed.flatMap((r) => r.errors);
  for (const [p, b] of Object.entries(files)) if (p.endsWith(".svg")) v4errors.push(...svgChecks(p, b.toString("utf8")));
  const uses = parsed.flatMap((r) => r.uses);

  if (!done("V2", stageV2(manifest, uses, input))) return { ok: false, stages, card };
  if (!done("V3", typecheck({ files: codeFiles, hostApiDts: input.hostApiDts, libDir: input.tsLibDir }))) return { ok: false, stages, card };
  const v4warnings = Object.entries(codeFiles).flatMap(([p, src]) => themeWarnings(p, src));
  if (!done("V4", v4errors, v4warnings)) return { ok: false, stages, card };
  if (input.hostSuiteProblem) { done("V5", [input.hostSuiteProblem]); return { ok: false, stages, card }; }
  if (input.smoke && !done("V5", await input.smoke(card))) return { ok: false, stages, card };
  return { ok: true, card, stages };
}

/** Errors in plain words, grouped by stage (V6): for the generator's retry and for the user. */
export function report(stages: StageResult[]): string {
  const errs = stages.filter((s) => s.errors.length).map((s) => `${s.stage} ${s.title}:\n${s.errors.map((e) => `- ${e}`).join("\n")}`);
  const warn = warnings(stages);
  return [...errs, ...(warn ? [`Warnings (the card works, but fix these if you can):\n${warn}`] : [])].join("\n\n");
}

/** Theme warnings of all stages, one per line, or "" (generator rule 10). */
export function warnings(stages: StageResult[]): string {
  return stages.flatMap((s) => s.warnings ?? []).map((w) => `- ${w}`).join("\n");
}
