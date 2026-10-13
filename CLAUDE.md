# Dashboard — instructions for Claude Code

A standalone, portable Windows desktop app (Electron + TypeScript, React UI) that shows a grid of sandboxed "cards". A permanent **New** card lets the user describe a card; the Claude Code CLI generates it, the host validates it, the user approves its permissions, and it goes live.

## Read before doing anything
All design lives in `docs\`. Read in this order:
1. `docs\PROJECT.md` — goals, constraints, scope, checklist, decision log, current status
2. `docs\RULES.md` — host invariants (enforced in code), generator rules, CLI rules
3. `docs\ARCHITECTURE.md` — the wrapper (capability broker), process model, storage, pipeline
4. `docs\PRESETS.md` — card presets (watch feed) and the report format
5. As the task needs: `docs\PERMISSIONS.md`, `docs\VALIDATOR.md`, `docs\GENERATOR-PROMPT.md`, `docs\CARDS.md`, `docs\TESTPLAN.md`, `docs\NEW-FEED-CARD.md` (procedure for feed cards), `docs\LASS.md` (proposal), `docs\INFRASTRUCTURE.md` (container rules: Podman now, Kubernetes-ready; follow them for anything that runs in a container)

Machine-readable specs are in `spec\` (manifest schema, host API, report schema, CLI approval schema).

**`docs\` is the source of truth.** These files are copies of the claude.ai Project "Dashboard" docs, made 2026-10-09. From now on, change the design here and record each decision in `docs\PROJECT.md` (decision log). The Project copy is a mirror and may lag.

## Hard constraints
- **No additional payments.** Only what the user's Claude subscription includes. No API keys, no paid services.
- **Portable instance.** Everything the app writes stays under `Build\`. Never %APPDATA%, never the user profile.
- **Security comes first.** The host invariants in `docs\RULES.md` are not negotiable; if a task conflicts with one, stop and say so.
- Cards never get Node.js, direct network, DLL calls, program launching, or Claude.
- **Reminder (user request 2026-10-13):** before starting any work on container card workers (`docs\INFRASTRUCTURE.md`, "Container card workers"), stop and remind the user that the rule above, host invariants 7 and 11, and the other items in "Required rule changes before building" must be changed first. Get the user's explicit approval for each change before writing any code for it.

## Do not touch
- `Build\data\claude\` — the generator's CLI config and **login token**. Never read, copy, print or move anything in it (RULES.md, Binary and config 3).
- `Build\data\generator\cli-approval.json` and `cli-approvals.json` — written only by the spike.
- `Build\data\generator\host-suite.json` — written only by `npm run test:host-suite` after the suite passed.
- `Build\data\vendor\claude\` — CLI builds, installed only by the spike; never replace or delete them.
- `setup\setup-generator-account.ps1` — withdrawn; never run.
- The user's Claude scheduled tasks — never delete or recreate them.
- Do not run `spikes\spike1-cli.ps1` yourself; the user runs it (it needs UAC and the user's sign-in).

## Current state (2026-10-13)
Built 2026-10-09 (see `docs\PROJECT.md`, Status): runtime, broker, file access, feeds, workers, grid/Options/tray, generator pipeline with validator and approval canvas, packaging. Since then, done by Claude in claude.ai sessions working on the files directly, committed 2026-10-13 (689d41a and after):
- **Grid:** fine 96-column / 10 px grid (`src/main/layout.ts`, old layouts converted on load); smooth resize with a snapping outline; partly hidden cards are shown clipped by a parent `View` (`card-host.ts` `applyRects`) and hidden only when fully out of view. In the packaged app since 2026-10-10; **not yet confirmed by the user on screen.**
- **Scripts:** `npm run package` logs to `pack-resources\package.log`, refuses to run while `Build\app` is locked, swaps `Build\app` via `app.old`. `scripts\project-node.mjs` re-runs package / unit tests / host suite with `tools\node` when the system Node is too old (the user's PATH has Node 20.11). `scripts\run-tests.mjs` replaces the `node --test` glob.
- **CLI:** spike v3.10 (adds T10: every tool call in every run is Read/Edit/Write) approved **CLI 2.1.296** (2026-10-10); the Dashboard uses the newest approved installed build. The 2.1.293 approval is still on the list; whether to retire it (raise `MIN_HARNESS` to 3.10) is an open user decision.
- **Host suite:** passed 2026-10-10 for build `3e40247e…`. The generator change of 2026-10-13 changed `src/main`, so **`npm run package` and `npm run test:host-suite` must run again** before the New card accepts requests.
- **Generator:** the request header now lists watched feeds (`task-id  name`, from Options) so a request can name a task (`src/main/generator/prompt.ts`, test `test\unit\generator-prompt.test.ts`).
- **Feeds:** "Daily celestial events watch" (`trig_01Y1GXmdmH2nc1r4KhLi9Fpn`) is in `options.json` and has its report folder, but its prompt has no report step and it is not connected to the computer yet (user steps; `docs\NEW-FEED-CARD.md`). The RTX card still defaults to the mock feed; the mock folder `reports\trig_MOCKrtx5050test` awaits deletion by the user.
- **New docs:** `NEW-FEED-CARD.md` (procedure), `LASS.md` (proposal, not approved), `INFRASTRUCTURE.md` (Podman decided; container card workers planned; rule changes required first; see the reminder under Hard constraints).
- **Podman:** `setup\install-podman.ps1` installs the client portably (`Build\data\vendor\podman\<version>\`; config and data in `Build\data\podman\` via `env.ps1`). Written, not yet run. The user installs WSL first (`wsl.exe --install --no-distribution`, admin, reboot).
- **Next, in order:** package + host suite; user confirms the grid fixes; celestial task report step and card; then the Podman verification script (`INFRASTRUCTURE.md`, open items).

## Working in this repo
- Use the project's Node: prepend `tools\node` to PATH (Node 24.21.0; the system Node 20 is too old for Electron 44 and electron-builder). `package`, `test:unit`, `test:race` and `test:host-suite` switch to it by themselves; `typecheck`, `build` and `test:e2e` do not.
- `npm run build` bundles into `dist\`; `npm start` runs the app on `Build\`; `npm test` = typecheck + unit (`test\unit`) + e2e (`test\e2e`, Playwright, throwaway instances in %TEMP%).
- E2E fixture cards are approved by writing approval records directly (`test\e2e\helpers.ts`); real cards go through the approval canvas.

## Note on this file and the generator
The generator CLI runs in folders under `Build\ClaudeExchange\staging\`, below this file. Under `--restricted` it does not load ancestor `CLAUDE.md` files (spike test T8, CLI 2.1.293). Keep it that way: never weaken the generator's lockdown flags, and re-run the spike on every new CLI version (RULES.md 1a/1b).

## How to work with this user
- Blunt, direct correction; attack weak ideas, don't soften.
- Plain writing: say who does what.
- Flag anything unverified as unverified.
