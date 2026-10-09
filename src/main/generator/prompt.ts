/**
 * What the generator is given (docs/GENERATOR-PROMPT.md). The system prompt and the generator rules
 * are read from the design docs that the build copies into dist/generator/, so docs/ stays the only
 * source: the "System prompt" block of GENERATOR-PROMPT.md, then RULES.md "Generator rules", verbatim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PromptDocs { systemPrompt: string; rules: string; presets: string }

export function loadPromptDocs(dir: string): PromptDocs {
  const gp = readFileSync(join(dir, "GENERATOR-PROMPT.md"), "utf8").replace(/\r\n/g, "\n");
  const rules = readFileSync(join(dir, "RULES.md"), "utf8").replace(/\r\n/g, "\n");
  const presets = readFileSync(join(dir, "PRESETS.md"), "utf8");
  const sys = /## System prompt[^\n]*\n```\n([\s\S]*?)\n```/.exec(gp)?.[1];
  if (!sys) throw new Error("GENERATOR-PROMPT.md has no system prompt block");
  const r = /## Generator rules \(sent with every request\)\n([\s\S]*?)(?:\n## |$)/.exec(rules)?.[1];
  if (!r) throw new Error("RULES.md has no generator rules section");
  return { systemPrompt: sys.trim(), rules: r.trim(), presets };
}

export function systemPrompt(docs: PromptDocs): string {
  return `${docs.systemPrompt}\n\nGenerator rules (standing requirements for every card):\n${docs.rules}`;
}

export interface RequestHeader { cardId: string; kind: "new" | "update"; preset: "watch-feed" | null }

/** The user message: a host header with the card id, new/update and preset, then the typed text unchanged. */
export function userMessage(h: RequestHeader, text: string): string {
  return [
    "[Dashboard request]",
    `Card ID: ${h.cardId} (use exactly this as manifest.id)`,
    `Kind: ${h.kind === "new" ? "new card" : "update of the card in this folder (raise manifest.version)"}`,
    `Preset: ${h.preset ?? "none"}`,
    "Reference files: _ref/host-api.d.ts, _ref/manifest.schema.json, _ref/PRESETS.md" + (h.preset ? ", _ref/reference-card/ (start from it)" : ""),
    "---",
    text,
  ].join("\n");
}

export function retryMessage(validatorReport: string): string {
  return `Validator errors (fix these, change nothing else):\n\n${validatorReport}`;
}
