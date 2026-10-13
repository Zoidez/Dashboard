/**
 * The generator pipeline (ARCHITECTURE.md, "Generator pipeline"; RULES.md, "Generator").
 * Started only by the user's typed request on the New card (host invariant 1).
 *   1. gate + host-suite checks (before any Claude usage)
 *   2. a fresh request folder: reference files in _ref/, and for an update the card's current files
 *   3. one locked-down CLI run in that card's own conversation (new, or resumed for updates)
 *   4. nothing may appear outside the request folder
 *   5. validation V0-V5; on failure the same conversation gets the errors (at most 3 retries)
 *   6. the approval canvas; 7. install (atomic, hash-bound)
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import { join, relative } from "node:path";
import type { AuditLog } from "../audit.js";
import type { Permission } from "../broker/permissions.js";
import { CARD_ID_RE, hashCardFolder } from "../cards/approvals.js";
import type { InstancePaths } from "../instance.js";
import { report, validate, type LoadedCard, type StageResult } from "../validator/validate.js";
import type { GateResult, GeneratorGate } from "./cli-gate.js";
import { retryMessage, systemPrompt, userMessage, type PromptDocs } from "./prompt.js";
import { MCP_JSON, runGenerator, SETTINGS_JSON, type RunResult } from "./runner.js";

export const MAX_RETRIES = 3;
const STOPWORDS = new Set(["the", "and", "that", "with", "card", "show", "shows", "make", "create", "how", "much", "many", "what", "which", "this", "into", "from", "for", "please", "want", "need", "should", "display", "displays", "can", "you", "all", "any", "its", "every"]);

export type Phase = "idle" | "checking" | "writing" | "validating" | "approval" | "installing" | "done" | "failed" | "stopped";
export interface PipelineState {
  phase: Phase;
  cardId?: string;
  kind?: "new" | "update";
  attempt?: number;
  message?: string;
  progress?: string;
  errors?: string;
  gate?: { ok: boolean; code?: string; reason?: string; version?: string };
}

export interface GenerationRequest { text: string; target: { kind: "new" } | { kind: "update"; cardId: string }; preset: "watch-feed" | null }

export interface ReviewRequest { card: LoadedCard; kind: "new" | "update"; installed: { permissions: Permission[]; files: Record<string, string>; version: string } | null }
export type ReviewResult = { approved: true; permissions: Permission[] } | { approved: false };

export interface PipelineDeps {
  gate: GeneratorGate;
  checkGate: () => Promise<GateResult>;
  hostSuiteProblem: () => string | null;
  paths: InstancePaths;
  distDir: string;
  docs: () => PromptDocs;
  manifestSchema: () => object;
  hostApiDts: () => string;
  tsLibDir?: string;
  feedTaskIds: () => string[];
  /** Watched feeds with their names, shown to the generator in the request header (2026-10-13). */
  feeds?: () => ReadonlyArray<{ taskId: string; name: string }>;
  installedInfo: (cardId: string) => { version: string; permissions: Permission[]; files: Record<string, string> } | null;
  smoke: (card: LoadedCard) => Promise<string[]>;
  streamsOf?: (p: string) => string[];
  review: (r: ReviewRequest) => Promise<ReviewResult>;
  install: (card: LoadedCard, permissions: Permission[], kind: "new" | "update") => Promise<void>;
  audit: AuditLog;
  timeoutMs?: number;
}

function slug(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return words.slice(0, 3).join("-").slice(0, 30).replace(/-+$/, "") || "card";
}

/** Every file under `dir`, except `skip`, with size and mtime (to spot files appearing outside the request folder). */
async function snapshot(dir: string, skip: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (p.toLowerCase() === skip.toLowerCase()) continue;
      if (e.isDirectory()) await walk(p);
      else { try { const st = await fsp.lstat(p); out.set(relative(dir, p), `${st.size}:${st.mtimeMs}`); } catch { /* vanished */ } }
    }
  };
  await walk(dir);
  return out;
}

export class GeneratorPipeline extends EventEmitter {
  private state: PipelineState = { phase: "idle" };
  private ctl: AbortController | null = null;

  constructor(private readonly d: PipelineDeps) { super(); }

  get current(): PipelineState { return { ...this.state }; }
  get busy(): boolean { return !["idle", "done", "failed", "stopped"].includes(this.state.phase); }

  private set(s: Partial<PipelineState>): void {
    this.state = { ...this.state, ...s };
    this.emit("state", this.current);
  }

  /** The New card's Stop button: kills the run (through the gate) and ends the request. */
  stop(): void {
    if (!this.busy) return;
    this.ctl?.abort();
  }

  async refreshGate(): Promise<void> {
    const g = await this.d.checkGate();
    this.set({ gate: g.ok ? { ok: true, version: g.version } : { ok: false, code: g.code, reason: g.reason } });
  }

  async start(req: GenerationRequest): Promise<void> {
    if (this.busy) throw new Error("a generation is already running");
    if (typeof req.text !== "string" || !req.text.trim() || req.text.length > 20_000) throw new Error("type what the card should do (at most 20,000 characters)");
    this.ctl = new AbortController();
    const signal = this.ctl.signal;
    const kind = req.target.kind;
    this.set({ phase: "checking", kind, cardId: undefined, attempt: 0, message: "checking the generator", progress: undefined, errors: undefined });
    try {
      const g = await this.d.checkGate();
      this.set({ gate: g.ok ? { ok: true, version: g.version } : { ok: false, code: g.code, reason: g.reason } });
      if (!g.ok) return this.fail(`The generator is off: ${g.reason}`);
      const suite = this.d.hostSuiteProblem();
      if (suite) return this.fail(`Cards cannot be validated: ${suite}`);

      let cardId: string;
      let installed: ReturnType<PipelineDeps["installedInfo"]> = null;
      if (req.target.kind === "update") {
        cardId = req.target.cardId;
        if (!CARD_ID_RE.test(cardId)) return this.fail("unknown card");
        installed = this.d.installedInfo(cardId);
        if (!installed) return this.fail(`${cardId} is not an installed, approved card`);
      } else {
        do { cardId = `${slug(req.text)}-${randomBytes(2).toString("hex")}`; } while (this.d.installedInfo(cardId) || !CARD_ID_RE.test(cardId));
      }
      const requestId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
      const work = join(this.d.paths.staging, cardId, requestId);
      this.set({ cardId, message: "preparing the request folder" });
      await this.prepare(work, cardId, kind, req.preset);
      const before = await snapshot(this.d.paths.staging, work);

      const sessionFile = join(this.d.paths.config, cardId, "generator.json");
      let sessionId: string | undefined;
      if (kind === "update") { try { sessionId = (JSON.parse(await fsp.readFile(sessionFile, "utf8")) as { sessionId?: string }).sessionId; } catch { /* new conversation */ } }
      const sys = systemPrompt(this.d.docs());
      let prompt = userMessage({ cardId, kind, preset: req.preset, feeds: this.d.feeds?.() }, req.text);

      // Each run's output stream, for the user and for diagnosis (the CLI's own transcript lives in data/claude, which the Dashboard never reads).
      const runDir = join(this.d.paths.generator, "runs", cardId, requestId);
      const runLog = (attempt: number, suffix = "") => join(runDir, `attempt-${attempt + 1}${suffix}.jsonl`);

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        this.set({ phase: "writing", attempt, message: attempt === 0 ? "Claude is writing the card" : `Claude is fixing validator errors (retry ${attempt} of ${MAX_RETRIES})`, progress: undefined });
        let run = await runGenerator({
          gate: this.d.gate, workDir: work, prompt, systemPrompt: sys, hostDir: join(this.d.paths.generator, "host"),
          configDir: join(this.d.paths.data, "claude"), resumeSessionId: sessionId, timeoutMs: this.d.timeoutMs ?? 10 * 60_000, logFile: runLog(attempt),
          onProgress: (t) => this.set({ progress: t }),
        }, signal);
        if (run.resumeFailed) {
          // RULES.md: a new conversation, seeded with the card's current source and DEVLOG (already in the folder).
          this.d.audit.write(cardId, "session-start", "generator conversation could not be resumed; started a new one");
          sessionId = undefined;
          run = await runGenerator({
            gate: this.d.gate, workDir: work, prompt, systemPrompt: sys, hostDir: join(this.d.paths.generator, "host"),
            configDir: join(this.d.paths.data, "claude"), timeoutMs: this.d.timeoutMs ?? 10 * 60_000, logFile: runLog(attempt, "-new-conversation"), onProgress: (t) => this.set({ progress: t }),
          }, signal);
        }
        if (run.stopped) return this.set({ phase: "stopped", message: "stopped by you" });
        if (run.sessionId) {
          sessionId = run.sessionId;
          await fsp.mkdir(join(this.d.paths.config, cardId), { recursive: true });
          await fsp.writeFile(sessionFile, JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }));
        }
        if (!run.ok) return this.fail(`The generator run failed: ${run.reason}`, whatClaudeSaid(run, runDir));

        const after = await snapshot(this.d.paths.staging, work);
        const appeared = [...after.entries()].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
        if (appeared.length) return this.fail(`Files appeared or changed outside the request folder during the run (RULES.md, Run lockdown 7): ${appeared.slice(0, 5).join(", ")}`);

        this.set({ phase: "validating", message: attempt === 0 ? "validating" : `validating (retry ${attempt} of ${MAX_RETRIES})` });
        const v = await validate({
          dir: work, cardId, instanceRoot: this.d.paths.root, installedVersion: installed?.version, feedTaskIds: this.d.feedTaskIds(),
          manifestSchema: this.d.manifestSchema(), hostApiDts: this.d.hostApiDts(), tsLibDir: this.d.tsLibDir, hostSuiteProblem: this.d.hostSuiteProblem(), smoke: this.d.smoke,
        }, this.d.streamsOf);
        if (signal.aborted) return this.set({ phase: "stopped", message: "stopped by you" });
        if (v.ok) return await this.approveAndInstall(v.card, kind, installed);
        const errors = report(v.stages);
        this.d.audit.write(cardId, "denied", `validation failed (attempt ${attempt + 1}): ${errors.slice(0, 500)}`);
        if (attempt === MAX_RETRIES || !sessionId) return this.fail(`The card did not pass validation${attempt ? ` after ${attempt} retries` : ""}.`, `${errors}${whatClaudeSaid(run, runDir)}`, v.stages);
        prompt = retryMessage(errors);
      }
    } catch (e) {
      if (signal.aborted) return this.set({ phase: "stopped", message: "stopped by you" });
      return this.fail(`Something went wrong: ${(e as Error).message}`);
    }
  }

  private fail(message: string, errors?: string, _stages?: StageResult[]): void {
    this.set({ phase: "failed", message, errors });
  }

  private async approveAndInstall(card: LoadedCard, kind: "new" | "update", installed: ReturnType<PipelineDeps["installedInfo"]>): Promise<void> {
    this.set({ phase: "approval", message: "ready for approval" });
    const r = await this.d.review({ card, kind, installed });
    if (!r.approved) return this.set({ phase: "done", message: "not approved; nothing was installed" });
    this.set({ phase: "installing", message: "installing" });
    await this.d.install(card, r.permissions, kind);
    this.set({ phase: "done", message: kind === "new" ? `${card.manifest.name} is on the grid` : `${card.manifest.name} was updated` });
  }

  /** The request folder: reference files in _ref/, the card's own files for an update. Nothing else. */
  private async prepare(work: string, cardId: string, kind: "new" | "update", preset: "watch-feed" | null): Promise<void> {
    await fsp.mkdir(join(work, "_ref"), { recursive: true });
    const hostDir = join(this.d.paths.generator, "host");
    await fsp.mkdir(hostDir, { recursive: true });
    await fsp.writeFile(join(hostDir, "settings.json"), SETTINGS_JSON);
    await fsp.writeFile(join(hostDir, "mcp.json"), MCP_JSON);
    await fsp.writeFile(join(work, "_ref", "host-api.d.ts"), this.d.hostApiDts());
    await fsp.writeFile(join(work, "_ref", "manifest.schema.json"), JSON.stringify(this.d.manifestSchema(), null, 2));
    await fsp.writeFile(join(work, "_ref", "PRESETS.md"), this.d.docs().presets);
    if (preset === "watch-feed") {
      await fsp.mkdir(join(work, "_ref", "reference-card"), { recursive: true });
      await fsp.copyFile(join(this.d.distDir, "cards", "watch-feed", "ui.js"), join(work, "_ref", "reference-card", "ui.js"));
    }
    if (kind === "update") {
      // Only card files (no links, no .claude/, .mcp.json or CLAUDE.md: hashCardFolder refuses them).
      const src = join(this.d.paths.cards, cardId);
      const files = await hashCardFolder(src);
      for (const rel of Object.keys(files)) {
        const to = join(work, ...rel.split("/"));
        await fsp.mkdir(join(to, ".."), { recursive: true });
        await fsp.copyFile(join(src, ...rel.split("/")), to);
      }
    }
    // RULES.md, Run lockdown 9: checked before every run.
    for (const bad of [".claude", ".mcp.json", "CLAUDE.md", "CLAUDE.local.md"]) {
      try { await fsp.lstat(join(work, bad)); throw new Error(`the request folder contains ${bad}`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
  }
}

/** Shown to the user with a failure: what Claude Code refused, Claude's last reply, and where the run log is. */
function whatClaudeSaid(run: RunResult, runDir: string): string {
  const parts: string[] = [];
  if (run.denials.length) parts.push(`Claude Code refused these tool calls:\n${run.denials.slice(0, 10).map((d) => `- ${d}`).join("\n")}`);
  if (run.text.trim()) parts.push(`Claude's last reply:\n${run.text.trim().slice(0, 1500)}`);
  parts.push(`Run logs: ${runDir}`);
  return `\n\n${parts.join("\n\n")}`;
}
