/**
 * One generator run (RULES.md, "Run lockdown"): the unmodified Claude Code CLI, started only
 * through the CLI gate, with exactly the lockdown the spike tested (spikes/spike1-cli.ps1, $Lockdown,
 * plus --append-system-prompt, covered by spike test T9), an environment built from scratch, and
 * the prompt on stdin. The session's tool list is checked on every run: anything beyond
 * Read/Edit/Write aborts it (RULES.md, Binary and config 2a).
 */
import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GeneratorGate } from "./cli-gate.js";

export const ALLOWED_TOOLS = ["Read", "Edit", "Write"];
export const MAX_TURNS = 12;

export interface RunInput {
  gate: GeneratorGate;
  workDir: string;
  prompt: string;
  systemPrompt: string;
  /** Holds settings.json and mcp.json, outside every working folder (the model cannot edit its own rules). */
  hostDir: string;
  /** CLAUDE_CONFIG_DIR: Build/data/claude (sign-in lives there; the Dashboard never reads it). */
  configDir: string;
  resumeSessionId?: string;
  timeoutMs: number;
  onProgress?: (text: string) => void;
  /** Where to save this run's output stream and stderr (under data/generator/runs/; never the CLI config folder). */
  logFile?: string;
}

export interface RunResult {
  ok: boolean;
  reason?: string;
  sessionId?: string;
  text: string;
  tools: string[];
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  resumeFailed: boolean;
  /** Tool calls Claude Code refused during the run (result.permission_denials), as "Tool: target". */
  denials: string[];
}

export function lockdownArgs(hostDir: string): string[] {
  return [
    "-p",
    "--restricted",
    "--tools", ALLOWED_TOOLS.join(","),
    "--disallowedTools", "mcp__*",
    "--mcp-config", join(hostDir, "mcp.json"), "--strict-mcp-config",
    "--settings", join(hostDir, "settings.json"),
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--disable-slash-commands",
    "--max-turns", String(MAX_TURNS),
    "--output-format", "stream-json", "--verbose",
  ];
}

/** The environment, built from scratch (spike Get-GeneratorEnv): these steer the CLI; they are not isolation. */
export function generatorEnv(configDir: string): NodeJS.ProcessEnv {
  const sys = process.env.SystemRoot ?? "C:\\Windows";
  const home = join(configDir, "home");
  const tmp = join(configDir, "tmp");
  for (const d of [tmp, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) mkdirSync(d, { recursive: true });
  return {
    SystemRoot: sys, windir: sys, SystemDrive: process.env.SystemDrive ?? "C:",
    ComSpec: `${sys}\\system32\\cmd.exe`, PATH: `${sys}\\system32;${sys};${sys}\\System32\\Wbem`, PATHEXT: ".COM;.EXE;.BAT;.CMD",
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    COMPUTERNAME: process.env.COMPUTERNAME, USERNAME: process.env.USERNAME, USERDOMAIN: process.env.USERDOMAIN,
    USERPROFILE: home, HOME: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TEMP: tmp, TMP: tmp,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_UPDATES: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** The settings and MCP files the run uses (written by the host, outside the working folder). */
export const SETTINGS_JSON = JSON.stringify({
  disableClaudeAiConnectors: true,
  permissions: { allow: ["Read(./**)", "Edit(./**)"], deny: ["Bash", "PowerShell", "WebFetch", "WebSearch", "Agent", "NotebookEdit"] },
});
export const MCP_JSON = JSON.stringify({ mcpServers: {} });

export async function runGenerator(input: RunInput, signal: AbortSignal): Promise<RunResult> {
  const args = [...lockdownArgs(input.hostDir), "--append-system-prompt", input.systemPrompt, ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : [])];
  const res: RunResult = { ok: false, text: "", tools: [], exitCode: null, timedOut: false, stopped: false, resumeFailed: false, denials: [] };
  const log = (s: string) => { if (input.logFile) { try { appendFileSync(input.logFile, s); } catch { /* logging never breaks a run */ } } };
  if (input.logFile) { try { mkdirSync(dirname(input.logFile), { recursive: true }); } catch { /* ignore */ } }
  let child: ChildProcess;
  try {
    child = await input.gate.launch(args, { cwd: input.workDir, env: generatorEnv(input.configDir), stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return { ...res, reason: (e as Error).message };
  }
  let result: Record<string, unknown> | null = null;
  let aborted = "";
  let buf = "";
  let stderr = "";
  const kill = (why: string) => { if (!aborted) { aborted = why; input.gate.kill(child); } };
  const timer = setTimeout(() => { res.timedOut = true; kill(`the generator took longer than ${Math.round(input.timeoutMs / 60000)} minutes`); }, input.timeoutMs);
  const onAbort = () => { res.stopped = true; kill("stopped by you"); };
  signal.addEventListener("abort", onAbort, { once: true });

  const onLine = (line: string) => {
    if (!line.trim()) return;
    log(line + "\n");
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (ev.type === "system" && ev.subtype === "init") {
      res.tools = Array.isArray(ev.tools) ? (ev.tools as unknown[]).map(String) : [];
      if (typeof ev.session_id === "string") res.sessionId = ev.session_id;
      const extra = res.tools.filter((t) => !ALLOWED_TOOLS.includes(t));
      if (!res.tools.length || extra.length) kill(`the session offered tools beyond Read/Edit/Write (${extra.join(", ") || "none listed"}); the run was aborted`);
    } else if (ev.type === "assistant") {
      const content = (ev.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined)?.content ?? [];
      for (const c of content) {
        if (c.type === "text" && c.text) input.onProgress?.(c.text.slice(0, 300));
        if (c.type === "tool_use") input.onProgress?.(`${c.name}…`);
      }
    } else if (ev.type === "result") {
      result = ev;
      if (typeof ev.session_id === "string") res.sessionId = ev.session_id;
      if (Array.isArray(ev.permission_denials)) {
        res.denials = (ev.permission_denials as Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>).map((d) => {
          const t = d.tool_input ?? {};
          const target = t.file_path ?? t.path ?? t.command ?? t.pattern ?? "";
          return `${d.tool_name ?? "?"}${target ? `: ${String(target).slice(0, 200)}` : ""}`;
        });
      }
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => { buf += d; let i: number; while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => { if (stderr.length < 8000) stderr += d; });
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(input.prompt);

  const code = await new Promise<number | null>((resolve) => { child.once("close", (c) => resolve(c)); child.once("error", () => resolve(null)); });
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  if (buf) onLine(buf);
  if (stderr) log(`\n[stderr]\n${stderr}\n`);
  log(`[exit] ${code}${aborted ? ` (aborted: ${aborted})` : ""}\n`);
  res.exitCode = code;
  const r = result as Record<string, unknown> | null;
  res.text = typeof r?.result === "string" ? r.result : "";
  if (aborted) return { ...res, reason: aborted };
  if (input.resumeSessionId && !r && /no conversation found|session.*not found/i.test(stderr)) return { ...res, resumeFailed: true, reason: "the card's conversation could not be resumed" };
  if (code !== 0 || !r) return { ...res, reason: `the generator ended without a result (exit code ${code ?? "none"})${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}` };
  if (r.subtype !== "success") return { ...res, reason: `the generator stopped: ${String(r.subtype)}${res.text ? ` (${res.text.slice(0, 200)})` : ""}` };
  return { ...res, ok: true };
}
