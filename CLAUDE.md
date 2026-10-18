# Dashboard — instructions for Claude Code

A standalone, portable Windows desktop app (Electron + TypeScript, React UI) that shows a grid of sandboxed "cards". A permanent **New** card lets the user describe a card; the Claude Code CLI generates it, the host validates it, the user approves its permissions, and it goes live.

## Read before doing anything
All design lives in `docs\`. Read in this order:
1. `docs\PROJECT.md` — goals, constraints, scope, checklist, decision log, current status
2. `docs\RULES.md` — host invariants (enforced in code), generator rules, CLI rules
3. `docs\ARCHITECTURE.md` — the wrapper (capability broker), process model, storage, pipeline
4. `docs\PRESETS.md` — card presets (watch feed) and the report format
5. As the task needs: `docs\PERMISSIONS.md`, `docs\VALIDATOR.md`, `docs\GENERATOR-PROMPT.md`, `docs\CARDS.md`, `docs\TESTPLAN.md`, `docs\NEW-FEED-CARD.md` (procedure for feed cards), `docs\LASS.md` (proposal), `docs\INFRASTRUCTURE.md` (container rules: Podman now, Kubernetes-ready; follow them for anything that runs in a container), `docs\THEMES.md` (colour and font themes)

Machine-readable specs are in `spec\` (manifest schema, host API, report schema, CLI approval schema).

**The git repository is the source of truth** (user decision 2026-10-16: the repository moves to a private GitHub repository). Its `docs\` holds the design; change it here and record each decision in `docs\PROJECT.md` (decision log). The claude.ai Project's docs are an older mirror and may lag: never treat them as current.

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

## Current state (2026-10-18)
Details and decisions: `docs\PROJECT.md` (decision log, checklist). What exists, newest last:
- **App (built 2026-10-09):** runtime and broker, file access (file check protocol, 5-minute races), watch feeds, workers, grid/Options/tray, generator pipeline with validator V0-V5 and approval canvas, packaged `Build\app\Dashboard.exe` (`npm run package`, which refuses while `Build\app` is locked and logs to `pack-resources\package.log`).
- **Grid (2026-10-10):** fine 96-column / 10 px grid, smooth resize with a snapping outline, partly hidden cards clipped by a parent `View`. **Not yet confirmed by the user on screen.**
- **Themes (2026-10-16):** six themes from `src\shared\themes.json` (generated and checked by `scripts\theme-check.mjs`, which must exit 0; regenerate with `--json src/shared/themes.json`), validated by `src\shared\theme.ts` (host invariant 14); picker in File > Options > General; live in cards; host-drawn severity; generator rule 10 sent; validator theme warnings; fonts in `dist\fonts`. **Not yet:** the user's look on screen; the three installed feed cards updated (Cards > Install or update watch-feed cards…).
- **CLI:** **2.1.296 approved** for the generator and for LASS triage by spike v3.11 (2026-10-18; tested list `Build\data\generator\cli-approvals.json`, `triage` verdict separate). 2.1.293 retired (`MIN_HARNESS` 3.10). The spike's process tree drops exited PIDs (Claude Desktop's own git once landed on reused PIDs).
- **Host suite:** passed 2026-10-18 for build `b15d41322be9…`, the packaged one. Any change under `src\main`, `src\preload`, `src\card-runtime` or `src\filehelper` needs `npm run package` and `npm run test:host-suite` again.
- **Podman (2026-10-17):** 6.1.4 portable; run it by hand with `Build\data\podman\podman.cmd`. Machine `dashboard` set up as option A (rootless + gVisor wrapper `/usr/local/bin/runsc-rootless`, no sudo, drives and interop off, capped by the user's `.wslconfig`). Development / LASS container and egress proxy: `infra\`, `setup\lass-dev.ps1`; the user is signed in inside it. Container backend: `src\main\containers\` (tests: `npm run test:podman`), not yet used by the app. Results: INFRASTRUCTURE.md, "Verified on this PC".
- **LASS:** approved 2026-10-17 (host invariants 1, 8, 13 amended). Phase 1 built: `src\main\lass\` (activity log, prompt history and pre-filter, investigations, Help > Something's wrong), previous failed attempts in the generator's request header. Phase 2 built 2026-10-18: triage via the gate (purpose `triage`, T11 flags), same-card check, budget 10/day, LASS bar, "not a bug" answers.
- **Feeds (unverified since 2026-10-16):** "Daily celestial events watch" (`trig_01Y1GXmdmH2nc1r4KhLi9Fpn`) has its report step but needs "Require this computer" and its folder connected (user steps, `docs\NEW-FEED-CARD.md`). The RTX card still defaults to the mock feed; the mock folder `reports\trig_MOCKrtx5050test` awaits deletion by the user.
- **Next:** LASS phase 3 (launcher with side-by-side builds) and phase 4 (fix runs in the container, on the user's click; rollout approved by the user). User steps any time: check themes and grid, update the feed cards, celestial task steps, delete the local branch `backup/before-trailer-removal` if no longer wanted.

## Git and GitHub (2026-10-16)
- **Pull before work, push after.** Start with `git pull --ff-only`; commit in small steps with messages that say what changed and why; push when a piece of work is committed and its tests pass. Never force-push, never rewrite pushed history.
- **Never commit credentials.** Check `git status` before each commit. `.gitignore` keeps out `Build\data\` (Claude login, approvals, audit), report files (the morning brief holds calendar and email content), spike raw captures (may hold the account e-mail) and key/credential files (`*.creds`, `*.nk`, `*.pem`, `*.key`, `.env`, `infra/**/secrets/`). If a credential was ever committed, stop and tell the user: it must be revoked and replaced; deleting it from history is not enough.
- **Before the first push:** scan the whole history for secrets (for example `gitleaks detect`, or review `git log --all --stat`) and report the result to the user.
- **Line endings:** `.gitattributes` stores text with LF; `.ps1`/`.cmd`/`.bat` keep CRLF. After it was added, run `git add --renormalize .` once and commit that separately.
- **Changes from outside a session.** Claude in claude.ai sometimes writes files on this PC directly. They appear as uncommitted changes: review them and commit them with a message saying where they came from.
- **Changes from cloud sessions are unverified on Windows.** Cloud sessions can't run the Windows-only tests, the spike or the host suite. Run `npm test` (and the host suite when `src\main`, `src\preload`, `src\card-runtime` or `src\filehelper` changed) on this PC before packaging.
- **Read pulled changes before building.** A matching host-suite record only proves the tests passed on that build; a hostile change could have edited the tests too. Tell the user about any change to tests, `RULES.md`, the spike, the CLI gate or the validator.
- **GitHub Actions stays off** unless the user decides otherwise: private repositories get limited free minutes, and "no additional payments" applies.
- **The development container (planned, INFRASTRUCTURE.md)** gets the source from GitHub with a read-only token for this repository only. It never gets write access; its fixes come out as patches the user approves.

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
