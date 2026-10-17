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

## Current state (2026-10-13)
Built 2026-10-09 (see `docs\PROJECT.md`, Status): runtime, broker, file access, feeds, workers, grid/Options/tray, generator pipeline with validator and approval canvas, packaging. Since then, done by Claude in claude.ai sessions working on the files directly, committed 2026-10-13 (689d41a and after):
- **Grid:** fine 96-column / 10 px grid (`src/main/layout.ts`, old layouts converted on load); smooth resize with a snapping outline; partly hidden cards are shown clipped by a parent `View` (`card-host.ts` `applyRects`) and hidden only when fully out of view. In the packaged app since 2026-10-10; **not yet confirmed by the user on screen.**
- **Scripts:** `npm run package` logs to `pack-resources\package.log`, refuses to run while `Build\app` is locked, swaps `Build\app` via `app.old`. `scripts\project-node.mjs` re-runs package / unit tests / host suite with `tools\node` when the system Node is too old (the user's PATH has Node 20.11). `scripts\run-tests.mjs` replaces the `node --test` glob.
- **CLI:** spike v3.10 (adds T10: every tool call in every run is Read/Edit/Write) approved **CLI 2.1.296** (2026-10-10); the Dashboard uses the newest approved installed build. The 2.1.293 approval is still on the list; whether to retire it (raise `MIN_HARNESS` to 3.10) is an open user decision.
- **Host suite:** passed 2026-10-10 for build `3e40247e…`. The generator change of 2026-10-13 changed `src/main`, so **`npm run package` and `npm run test:host-suite` must run again** before the New card accepts requests.
- **Generator:** the request header now lists watched feeds (`task-id  name`, from Options) so a request can name a task (`src/main/generator/prompt.ts`, test `test\unit\generator-prompt.test.ts`).
- **Feeds:** "Daily celestial events watch" (`trig_01Y1GXmdmH2nc1r4KhLi9Fpn`) is in `options.json` and has its report folder, but its prompt has no report step and it is not connected to the computer yet (user steps; `docs\NEW-FEED-CARD.md`). The RTX card still defaults to the mock feed; the mock folder `reports\trig_MOCKrtx5050test` awaits deletion by the user.
- **New docs:** `NEW-FEED-CARD.md` (procedure), `LASS.md` (proposal, not approved), `INFRASTRUCTURE.md` (Podman decided; container card workers planned; rule changes required first; see the reminder under Hard constraints).
- **Podman:** WSL 2 installed (2026-10-17). Podman 6.1.4 installed portably by `setup\install-podman.ps1` (`Build\data\vendor\podman\6.1.4\`; config and data in `Build\data\podman\` via `env.ps1`). `setup\verify-podman.ps1` (open items 1-3 plus storage location and an internal network) written, not yet run; the user runs it, results in `Build\data\podman\verify\<time>\`.
- **Celestial watch task:** its prompt has the report step since 2026-10-16 (list format for the card: `sources` titles `section | headline | source | date`). The user still has to turn on "Require this computer" and connect its folder before reports arrive.
- **Themes (2026-10-16):** built (`docs\THEMES.md` status): one definition `src\shared\themes.json` generated by `scripts\theme-check.mjs` (run it, it must exit 0; regenerate with `--json src/shared/themes.json`), validated by `src\shared\theme.ts` (host invariant 14), picker in Options, live in cards (`host:theme` event, `api.ui.onThemeChange`), host-drawn severity methods, generator rule 10 sent, validator theme warnings. Fonts Inter, IBM Plex Sans, Source Sans 3 ship in `dist\fonts` (SIL OFL). Not yet: the user's look on screen; feed cards updated via Cards > Install or update watch-feed cards….
- **Next, in order:** package + host suite; user checks the themes and updates the feed cards; user confirms the grid fixes; celestial card once its first report has arrived; then the Podman verification script (`INFRASTRUCTURE.md`, open items).

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
