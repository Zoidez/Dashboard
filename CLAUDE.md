# Dashboard — instructions for Claude Code

A standalone, portable Windows desktop app (Electron + TypeScript, React UI) that shows a grid of sandboxed "cards". A permanent **New** card lets the user describe a card; the Claude Code CLI generates it, the host validates it, the user approves its permissions, and it goes live.

## Read before doing anything
All design lives in `docs\`. Read in this order:
1. `docs\PROJECT.md` — goals, constraints, scope, checklist, decision log, current status
2. `docs\RULES.md` — host invariants (enforced in code), generator rules, CLI rules
3. `docs\ARCHITECTURE.md` — the wrapper (capability broker), process model, storage, pipeline
4. `docs\PRESETS.md` — card presets (watch feed) and the report format
5. As the task needs: `docs\PERMISSIONS.md`, `docs\VALIDATOR.md`, `docs\GENERATOR-PROMPT.md`, `docs\CARDS.md`, `docs\TESTPLAN.md`

Machine-readable specs are in `spec\` (manifest schema, host API, report schema, CLI approval schema).

**`docs\` is the source of truth.** These files are copies of the claude.ai Project "Dashboard" docs, made 2026-10-09. From now on, change the design here and record each decision in `docs\PROJECT.md` (decision log). The Project copy is a mirror and may lag.

## Hard constraints
- **No additional payments.** Only what the user's Claude subscription includes. No API keys, no paid services.
- **Portable instance.** Everything the app writes stays under `Build\`. Never %APPDATA%, never the user profile.
- **Security comes first.** The host invariants in `docs\RULES.md` are not negotiable; if a task conflicts with one, stop and say so.
- Cards never get Node.js, direct network, DLL calls, program launching, or Claude.

## Do not touch
- `Build\data\claude\` — the generator's CLI config and **login token**. Never read, copy, print or move anything in it (RULES.md, Binary and config 3).
- `Build\data\generator\cli-approval.json` — written only by the spike.
- `Build\data\vendor\claude\` — CLI builds, installed only by the spike; never replace or delete them.
- `setup\setup-generator-account.ps1` — withdrawn; never run.
- The user's Claude scheduled tasks — never delete or recreate them.
- Do not run `spikes\spike1-cli.ps1` yourself; the user runs it (it needs UAC and the user's sign-in).

## Current state (2026-10-09)
- Runtime skeleton built and tested (see `docs\PROJECT.md`, Status). CLI gate still a prototype: rework for the tested list.
- **Next:** the native file helper and `api.fs` (TESTPLAN A4), then reports and the watch feed.

## Working in this repo
- Use the project's Node: prepend `tools\node` to PATH (Node 24.21.0; the system Node 20 is too old for Electron 44).
- `npm run build` bundles into `dist\`; `npm start` runs the app on `Build\`; `npm test` = typecheck + unit (`test\unit`) + e2e (`test\e2e`, Playwright, throwaway instances in %TEMP%).
- E2E fixture cards are approved by writing approval records directly (`test\e2e\helpers.ts`); there is no approval canvas yet.

## Note on this file and the generator
The generator CLI runs in folders under `Build\ClaudeExchange\staging\`, below this file. Under `--restricted` it does not load ancestor `CLAUDE.md` files (spike test T8, CLI 2.1.293). Keep it that way: never weaken the generator's lockdown flags, and re-run the spike on every new CLI version (RULES.md 1a/1b).

## How to work with this user
- Blunt, direct correction; attack weak ideas, don't soften.
- Plain writing: say who does what.
- Flag anything unverified as unverified.
