# Dashboard — Project Brief

Read this first in every session, then RULES.md, PRESETS.md and ARCHITECTURE.md; for specific work PERMISSIONS.md, VALIDATOR.md, GENERATOR-PROMPT.md, CARDS.md, TESTPLAN.md. Keep it current: update "Status" and "Decision log" when anything changes.

## Goal
A standalone, portable Windows desktop app: one customizable window (multiple windows possibly later, NOT in v1) showing modular "cards". Each card is individually configurable and does one task. New cards can be added after release and hot-loaded without restarting.

## Constraints (user, 2026-10-08)
- **No additional payments.** Anything included in the user's Claude subscription is allowed (Claude Desktop, scheduled tasks, Claude Code CLI on the subscription login). No API key, no API billing, no paid extras.
- The only other limits are technology and security.
- **Design is delegated to Claude.** The user decides goals and constraints; Claude makes the design calls and records them here; both revise as needed.

## Locations
- Project directory (on the user's PC): `D:\ProgramFiles\Projects\JavaScript\Dashboard` (not OneDrive-synced).
- Instance: `...\Dashboard\Build\` — the app runs from here.
- Specs: `...\Dashboard\spec\` (manifest schema, host API, report schema). Spikes: `...\Dashboard\spikes\`.
- **Design docs: `...\Dashboard\docs\`** (copied from this claude.ai Project on 2026-10-09 so Claude Code on the PC can read them) and `...\Dashboard\CLAUDE.md` (read automatically by Claude Code). From 2026-10-09 the `docs\` folder is the source of truth; the Project docs are a mirror.
- This session has file access to the project directory but **no shell on the PC**: anything that must run on the PC (spikes, builds) is a script the user runs, or needs a session with a shell.
- Tool note: re-committing the same staged file path to the PC can deliver a stale copy; stage each new version under a new name and verify the size on the PC afterwards.

## Card capabilities
In v1:
- File operations (scoped; read, write, delete-to-Recycle-Bin, list, watch)
- Web actions (HTTP, webhooks) through the broker
- Reading simple system info (RAM, CPU, disk, etc.)
- Running in the background and monitoring external sources (including the user's Claude scheduled tasks)
- Opening https links in the default browser (host-controlled)

Removed from v1 by user decision (2026-10-08), names reserved for later:
- Launching apps / executables and console interaction (`process.launch`, `process.run`)

Removed from cards permanently (user decision 2026-10-09):
- Calling DLLs. No `ffi.call`, no `api.ffi`. Only the host calls Windows functions, in its own file helper.

Later:
- Talking to other cards (manifest reserves `channels` from v0)
- Talking to Claude (`api.claude` reserved, hard-disabled in v1)

## The Claude card (permanent, always present)
The first card. Has an input field. The user types a new card request, or picks an existing card and types a change -> the Dashboard starts a locked-down local Claude Code CLI run on the user's subscription, in **that card's own conversation** (new for a new card, resumed for an update), with host-added context -> Claude writes into `ClaudeExchange/staging/<card-id>/<request-id>/` -> the host validates (smoke test with zero capabilities) and feeds errors back (max 3 retries) -> the canvas shows the proposed permissions (and a diff for updates) -> user approves -> the card goes live. It cannot be removed.

Example of a request the generator must eventually handle: a card that shows the "bottom line" of the last run of a scheduled task, colored by a severity level. Severity is built into all reports (PRESETS.md); applying task changes is manual for now.

## Presets
New cards can be built from presets (fixed card types). See PRESETS.md. First preset: **watch feed** (severity-colored).

## First four cards
1. Claude card (generator)
2. Watch feed: "Weekday morning brief" (trig_01ErEFUF3HVkStP55y82wGH1)
3. Watch feed: "Daily gamedev industry moves watch" (trig_01JKJw5sKmS7HACpjCGdDWw8)
4. Watch feed: "Daily Kessler Syndrome watch" (trig_01AmX52WU9gtbFB6fHLAW7A6)

All three tasks stay in the cloud. Each writes its report to `Build\ClaudeExchange\reports\<task-id>\`. Each feed card's only permission: read its own task's report folder.

## v1 scope (approved 2026-10-08, amended same day)
**In v1:** the window with the card grid (React); File menu with Options; the four first cards; creating and updating cards through the CLI; the capability broker (files, network, system info, reports) with the isolation in ARCHITECTURE.md "The wrapper"; the permission approval canvas; version-bound approvals; audit log, Stop and Revoke; hot-loading; tray icon and start with Windows.
**Removed for good:** DLL calls from cards. **Reserved, not built:** running/launching executables, inter-card bus, `api.claude`, censor channel, multiple windows.
**Deferred to v1.1:** the Dashboard's own updater.

## Pre-build checklist
### User
- [x] Project directory set.
- [x] Report-writing step (with severity) applied to all three task prompts; re-signed for the computer.
- [x] **Attach each task to its own `Build\ClaudeExchange\reports\<task-id>\` folder in the desktop app.** Done by the user 2026-10-09; confirmed only when the first report file lands.
- [x] Paid "extra usage" is off.
- [x] UI framework: React.
- [x] **Run `spikes\spike1-cli.ps1`** on CLI 2.1.293 (runs 2026-10-08 05:27 and 19:08; Process Monitor analysis of the 19:08 run). Results: see "Spike 1 results".
- [x] Generator boundary for v1: **Option A** (`--restricted`, no OS isolation), decided 2026-10-09.
- [x] **Run spike v3.8 on CLI 2.1.293**: run 2026-10-08 22:21 (local) APPROVED, 45 passed, 0 failed, 0 inconclusive. The CLI gate accepts the installed build (version + SHA-256 checked).
### Claude: to implement for the CLI test button
- [x] Spike: tested list `cli-approvals.json` (one record per build; written by v3.9 alongside the single `cli-approval.json`); install candidates into `data/vendor/claude/<version>-<sha12>/` (done in v3.8, 2026-10-09); take the build to test as a parameter.
- [x] CLI gate: looks the installed build up in the list by its SHA-256 (an untested binary is never started, not even for --version); reason codes; minimum harness 3.9. Done 2026-10-09.
- [x] Claude card (New): the states and buttons in ARCHITECTURE.md; "Test the new CLI version" opens the spike in a visible PowerShell window. Not yet: "Switch to CLI x.y.z" (the active build is the newest approved one installed).
### Claude — documents
- [x] Manifest schema v0 — tested; process/claude permissions reserved and rejected; `ffi.call` removed (2026-10-09); `worker` description fixed (Web Worker in the card's view).
- [x] Host API v0 — typechecks; `api.process` reserved; `api.ffi` removed (2026-10-09); runtime description fixed (own view per card, worker as Web Worker, lazy grants); `api.ui.openLink` added.
- [x] `EXCHANGE.md` + report schema (severity required).
- [x] Permission display rules — PERMISSIONS.md (red marking and the No / Yes, always / Yes, only now dialog: user decisions 2026-10-09)
- [x] Validator spec v0 — VALIDATOR.md (security tests mandatory: host suite + per-card checks)
- [x] Generator prompt v0 — GENERATOR-PROMPT.md
- [x] Reference cards defined — CARDS.md: New (permanent, multi-line input), watch feed, system info, file watcher. Code to follow.
- [x] v1 test plan — TESTPLAN.md (approved 2026-10-09)
### Next build step
- [x] Runtime skeleton: Electron, one card view, broker with network blocking and channel identity, first negative tests (proves "The wrapper" in code). Done 2026-10-09: TESTPLAN A1, A2, A3, A6, A7, A8, A9 (memory, size, rate), A10, A11 pass as automated tests (8 e2e, 30 unit incl. the CLI gate).
### Next build steps
- [x] Native file helper and `api.fs` (read, list, stat, write, append, mkdir, watch, delete to the Recycle Bin) with the file check protocol; A4 passes (unit, e2e, and two 5-minute races). Done 2026-10-09.
- [ ] ADS detection (FindFirstStreamW) for VALIDATOR V0 (staging check, with the validator).
- [x] Reports + watch-feed preset (report validation, offline banner incl. overdue, retention 30) and the safe Markdown renderer; the three feed cards install from **Cards > Install watch-feed cards…** (interim approval dialog). E1-E4 pass. Done 2026-10-09.
- [x] `worker.js` as a Web Worker in the card view: calls relayed over the card's port (no `api.ui`), `api.messaging` to ui.js, host-driven `tick()` with a 60 s watchdog. Done 2026-10-09.
- [x] React grid (12 columns, drag to reorder, resize handle, layout.json), File > Options (General, Feeds, Cards with permissions and audit log, Claude, Security log), tray, close to tray, start with Windows (packaged exe only), hot-loading. Done 2026-10-09.
- [x] Generator pipeline: New card, locked-down runner through the gate, one conversation per card, validator V0-V5 with 3 retries in the same conversation, host security-suite record, approval canvas (PERMISSIONS.md incl. allowances and update diffs), atomic install and update. Tested with a fake CLI. Done 2026-10-09.
- [x] **User: run spike v3.9** — superseded: spike v3.10 approved CLI 2.1.296 on 2026-10-10; the host suite passed the same day; first real generations ran (RTX price card, Ulam spiral and others).
- [ ] **Package and run the host suite again** after the 2026-10-13 generator change (feed list in the request header).
- [x] Portable packaged build: `npm run package` writes `Build/app/Dashboard.exe` (electron-builder 26.15.3, unpacked folder); `npm run setup:shortcut` made `Build/Dashboard.lnk`. All 16 e2e tests pass on the packaged exe (`DASH_EXE=...`). Done 2026-10-09.
- [x] **User: test the packaged Dashboard** — in daily use since 2026-10-10. Electron fuses are still default (deferred decision; see Open questions).
- [ ] **User: confirm on screen** the fine-grid resize and the clipping of partly hidden cards (packaged 2026-10-10).
- [x] **Theme rework** (THEMES.md), built 2026-10-16: one theme definition, Options picker, live theme in cards, host-drawn severity methods, contrast unit test, generator rule 10 (now sent), validator theme warnings, reference feed card and its approved update path. Tests: 76 unit, 17 e2e pass.
- [x] **Theme fonts:** Inter, IBM Plex Sans and Source Sans 3 (SIL OFL 1.1, `@fontsource` 5.3.x) ship in `dist/fonts` (453 KB) and are served to card pages by the host. Done 2026-10-16.
- [ ] **User: look at the themes on screen** (File > Options > General > Appearance), and use Cards > Install or update watch-feed cards… to move the three feed cards to the new reference version (one approval each).
- [ ] **Package and run the host suite again** after the theme rework (`src\main`, `src\preload` and `src\card-runtime` changed).
- [x] **Commit** everything since 2026-10-09 07:06 (689d41a, 2026-10-13).

### Before building container card workers (user request 2026-10-13: remind the user when this work starts)
- [ ] Remind the user of the rule changes in INFRASTRUCTURE.md, "Required rule changes before building", and get explicit approval for each.
- [ ] CLAUDE.md hard constraint ("Cards never get Node.js…"): amend for sealed worker containers only.
- [ ] RULES.md host invariant 7: add container workers as an allowed place for worker code.
- [ ] RULES.md host invariant 11, manifest schema, VALIDATOR.md: only if cards may run programs inside their container.
- [ ] GENERATOR-PROMPT.md and the RULES.md generator rules: describe the container worker runtime.
- [ ] ARCHITECTURE.md: add the container topology.

## Decision log
| Date | Decision | Reason |
|---|---|---|
| 2026-10-07 | Standalone app, not browser | User preference |
| 2026-10-07 | Electron + TypeScript | Cards are plain JS -> trivial hot-load; Node in the host covers native access. Tauri rejected: native calls need Rust recompile. .NET rejected: hot-loading backend logic needs runtime Roslyn compile. |
| 2026-10-07 | ~~Claude integration via Claude Agent SDK~~ | SUPERSEDED 2026-10-08: requires an API key (paid). |
| 2026-10-08 | Cards will talk to each other (eventually); manifest reserves channels from v0 | Retrofitting later rewrites every card. |
| 2026-10-08 | Cards run in the background and monitor external sources | User requirement. Tray + start with Windows. |
| 2026-10-08 | Permissions: least privilege, scoped; Claude proposes, user approves; broker enforces | User decision. |
| 2026-10-08 | Task reports reach the Dashboard by **file drop** via the desktop-app bridge | Works when the Dashboard is closed; narrowest permission. |
| 2026-10-08 | Card presets; first is "watch feed"; offline handling | User decision. |
| 2026-10-08 | **Portable instance, no %APPDATA%.** | User decision. |
| 2026-10-08 | Blockchain/signature scheme rejected | Single owner, single machine; Claude runs can't hold a secret. |
| 2026-10-08 | No additional payments (not "no CLI") | User decision. |
| 2026-10-08 | All file exchange through `ClaudeExchange/` | User decision. |
| 2026-10-08 | **Generator = the unmodified Claude Code CLI headless on the subscription login**, locked down; one conversation per card with DEVLOG.md | User decision / requirement. |
| 2026-10-08 | Instance = `<project dir>/Build/`; File > Options; React; severity in reports | User decisions. |
| 2026-10-08 | ~~Generator runs as a separate Windows account (dashgen)~~ | WITHDRAWN same day after external review: required drive-wide permission changes, untrustworthy undo. Never run. |
| 2026-10-08 | **The wrapper (capability broker) is the security boundary for cards**: one isolated Node-free renderer per card, no direct network, channel-based identity, handle-based file checks, version-bound approvals, audit + revoke, zero-capability smoke test | User framing + external review. ARCHITECTURE.md. |
| 2026-10-08 | **DLL calls and running/launching executables removed from v1**; permission names reserved | User decision. Also removes the "power card" tier and the FFI helper. |
| 2026-10-08 | Spike v3 replaces v2.3: tests Option A directly, incl. prompt injection via card files (T6), junctions (T7), hostile project settings/hooks/MCP/CLAUDE.md (T8) | External review: old spike depended on withdrawn dashgen. |
| 2026-10-08 | Trust levels for generator input: card source and DEVLOG are lower-trust data, not instructions; cards can't write `Build\` (invariant 12); host never copies `.claude/`, `.mcp.json`, `CLAUDE.md` or reparse points into the work folder | External review point A: the docs wrongly called card source trusted. |
| 2026-10-08 | Broker: DNS-pinned, private-address-refusing, hop-by-hop redirect checks; verified per-card OS process; atomic hash-then-approve install; Recycle-Bin delete built last and only if race-resistant | External review points B–E. |
| 2026-10-09 | **Generator boundary = Option A**: the CLI runs as the user under `--restricted`, no OS isolation; WSL2 only if the generator must ever take untrusted input | User decision after spike 1 (CLI 2.1.293): lockdown held in every attempted test; Process Monitor showed no access outside the instance. |
| 2026-10-09 | **CLI gate**: the Dashboard runs only a CLI build (version + SHA-256) the spike approved; otherwise it refuses, kills running CLI processes and disables the generator. Spike v3.7 writes the approval record. | User requirement. |
| 2026-10-09 | Design docs copied into the project folder (`docs\`, plus `CLAUDE.md`); `docs\` becomes the source of truth, the Project is a mirror | Claude Code on the PC cannot read claude.ai Project docs. |
| 2026-10-09 | **DLL calls removed from cards permanently** (`ffi.call`, `api.ffi` deleted, not reserved) | User decision. The host still calls Windows functions in its own file helper (koffi); Node stays in the host. |
| 2026-10-09 | **Host invariants approved**, with invariant 4 changed to **lazy grants**: a permission is granted when the running card first requests it and withdrawn when the card shuts down for any reason; added invariant 13 (CLI gate) | User decision: no dangling permissions at either end of the grant period. |
| 2026-10-09 | `src/main/generator/cli-gate.ts` kept as a **prototype**: tested logic, reworked for the tested list when development starts | User decision. |
| 2026-10-09 | The permanent card is titled **New**; its input is a multi-line text area (Ctrl+Enter sends) | User requirement. CARDS.md. |
| 2026-10-09 | **CLI builds live in `Build/data/vendor/claude/<version>-<sha12>/`**, not `Build/app/` | User approved. Builds own `app/` and may wipe it; the approved CLI is state the spike writes. The tested 2.1.293 binary was moved there, hash re-checked. |
| 2026-10-09 | **`Dashboard.exe` lives in `Build/app/`**; `Build/Dashboard.lnk` is a shortcut made once by setup, never by a build | User approved. Keeps "builds write only `app/`" true. |
| 2026-10-09 | **OS rights under the broker**: card renderers run under Chromium's Windows sandbox (Untrusted integrity, restricted token, job object without child processes); the host suite verifies it on every card process and refuses cards that fail | User direction: enforce through process rights where possible. Unverified until TESTPLAN A1 passes. |
| 2026-10-09 | Git repository initialised; docs committed as the baseline | User approved. |
| 2026-10-09 | **Toolchain pinned**: Electron 44.7.0, TypeScript 5.9.3, esbuild 0.28.2, tsx 4.23.15, Playwright 1.64.0, koffi 3.3.2. **Node 24.21.0 portable in `tools/node/`** (git-ignored; SHA-256 checked against SHASUMS256.txt, whose GPG signature verified with Node's release keys) | Every supported Electron line needs Node >= 22.12; the system Node was 20.11 (EOL). User chose the project-local Node. TypeScript 5.9, not 7.0: the validator needs the compiler API (checkJs), unverified on the 7.0 native port. npm 11 install scripts allowed only for esbuild and koffi. |
| 2026-10-09 | Skeleton Dashboard page is plain TS; React arrives with the grid | The skeleton's job was the wrapper; a grid framework added nothing to that. |
| 2026-10-09 | **Network: CSP is the first line, the session filter the second, a dead proxy the third.** CSP violations are logged from the card's console as blocked requests | Tests showed CSP stops every in-page attempt before the session filter sees it; the session filter is tested separately by loading a CSP-free page into the card's session (ERR_BLOCKED_BY_CLIENT). |
| 2026-10-09 | **Any navigation or reload of a card view ends the card** (fail closed) | A hostile form submit/`location` change must never load another page; ending the card is simpler than proving every navigation path is cancelled. |
| 2026-10-09 | A fresh in-memory session partition per card **start** (not per card id) | A restarted card must not inherit in-memory state; different partitions also guarantee different renderer processes. |
| 2026-10-09 | The approval is re-checked on **every** broker call, not only on first use | Revocation and version mismatch take effect on the next call; costs a map lookup. |
| 2026-10-09 | **`net.http` to a non-public IP literal is marked red** on the approval canvas | User decision. The broker already allows such an address only when the permission names it. |
| 2026-10-09 | **New permission `links.open`** (`origins` list, or `any: true`); `api.ui.openLink` is denied without it. `any: true` is marked **yellow**, a new caution level below red that does not trigger the approval dialog | User decision: reaching known sites is fine; opening arbitrary links is yellow. The host cannot see clicks inside the card process, so links stay https-only and rate-limited (1 per 2 s per card). |
| 2026-10-09 | Electron fuses vs. testing the packaged build: deferred | User decision: decide when the packaged build exists. |
| 2026-10-09 | **File check protocol** before every card file operation: syntax, scope, verified real path, kind, type-matches-extension, write rules; extra file controls go there | User requirement. ARCHITECTURE.md 4a. |
| 2026-10-09 | Race tests run for 5 minutes with checks every 0.5 s against a swapper at random 50-400 ms (`npm run test:race`) | User design, after the first race test barely swapped (the open handles blocked the swapper, which is correct behaviour). |
| 2026-10-09 | The broker runs the syntax check on the card's **raw** path; nothing normalizes a card path first | Found by the A4 e2e test: Node's path.resolve removed ".." and turned `\\?\C:\...` and UNC paths into paths on the current drive before any check saw them. |
| 2026-10-09 | **Delete ships** (Recycle Bin only): parent pinned, rename on the verified handle to a random name, recycle that name, Windows asks if a file cannot be recycled | Race-resistant per the 5-minute delete race; ARCHITECTURE.md 4. |
| 2026-10-09 | File types: text (txt, md, csv, json, xml, yaml, ini, ...), images, pdf, audio writable; html/svg, archives, office files, video read-only; programs and scripts never | Writing html/svg, archives or office files can carry scripts, programs or macros. |
| 2026-10-09 | **Interim approval dialog** (native message box: plain-words lines, red/yellow tags, file hashes; Cancel is the default) until the approval canvas exists. All-or-nothing: no per-line checkboxes yet; red shows No / Yes, only now | The feed cards must be approved by the user (host invariant 5) before the canvas is built. Install follows ARCHITECTURE.md 6: hashed in a host-only folder, that folder renamed into `data/cards/`. |
| 2026-10-09 | Report folders watched with Node's `fs.watch` plus a 750 ms settle window and a minute rescan, not chokidar | One dependency fewer; write-finish detection and overdue checks need only this. |
| 2026-10-09 | Markdown links only for **https** (the only kind `api.ui.openLink` opens); images become their alt text; raw HTML stays literal text | Report content is untrusted (PRESETS.md display rule 4). A report source with an http URL is shown but cannot be opened. |
| 2026-10-09 | Feed card ids are derived from the task name (`feed-daily-kessler-syndrome-watch`); the task id is a config default the card reads | One reference card file for all feeds; the permission names the task id. |
| 2026-10-09 | **worker.js**: started by the page runtime as a module Web Worker in the same view; its calls are relayed over the card's own port; `ui.*` from the worker is refused; host events are forwarded to it | Same process, sandbox, CSP and identity as ui.js; nothing new to secure. |
| 2026-10-09 | Ticks: the host sends one tick per `schedule.intervalSeconds`; while a tick is running the next is skipped; a tick running longer than 60 s stops and flags the card | spec/host-api.d.ts ("must finish within 60 s"); skipping avoids piling up. |
| 2026-10-09 | **Grid**: the page reports each frame body's rectangle; the host validates and places the card's view there; a view whose frame is partly scrolled out is hidden (native views cannot be clipped). Resize handle sits in a strip below the body (the view covers the body) | Card views are separate processes drawn over the page. |
| 2026-10-09 | **Start with Windows** writes the per-user sign-in entry (registry, HKCU) only from the packaged exe; a development or test run never touches Windows | The one write outside the instance, and only when the user switches it on. |
| 2026-10-09 | Pages (grid, Options) talk to the host only through narrow preloads; every message is checked to come from that page's own window and validated in the main process | Same rule as for cards: the host decides. |
| 2026-10-09 | Hot-loading: the host watches `data/cards/`; a new approved folder starts, a removed folder stops its card | v1 scope. |
| 2026-10-09 | **Generator command line** = the spike's `$Lockdown` exactly, plus `--append-system-prompt` (GENERATOR-PROMPT.md); prompt on stdin; environment from scratch. **Spike v3.9 adds T9** to test that flag (tool list, no MCP, no shell, prompt takes effect); the gate's minimum harness is 3.9 | The flag only adds prompt text, but it changes the tested command line, so it must be tested. The current approval (harness 3.8) no longer counts: the user re-runs the spike. |
| 2026-10-09 | System prompt and generator rules are read from `docs/GENERATOR-PROMPT.md` and `docs/RULES.md`, copied into the app at build time | docs/ stays the single source of the prompt. |
| 2026-10-09 | **Validator**: Ajv 8.20.0 for the manifest schema; TypeScript compiler API (5.9.3, now a runtime dependency) for V3 checkJs and V4's syntax tree; V5 runs the staged card in the real card runtime with a deny-all broker (files served from memory, in-memory storage, no host UI, process check) | Tested libraries instead of hand-written schema and JS parsing. |
| 2026-10-09 | **Host security-suite record**: `data/generator/host-suite.json` names the SHA-256 of the build's security-relevant files (main, preloads, card runtimes, file helper); written by `npm run test:host-suite` only after the suite passed; the pipeline refuses before any Claude usage when it does not match | VALIDATOR.md: an untested host does not judge cards. |
| 2026-10-09 | Card ids for new cards: three meaningful words of the request + 4 random hex (`memory-use-6827`); the model must use it (V1) | The host names the card; the model cannot pick another card's id. |
| 2026-10-09 | Approval canvas: unchecked permissions are not granted (the approval record holds only the checked ones); "Yes, always" is stored per card for the exact red scopes in `data/approvals/<id>.allowances.json` | PERMISSIONS.md 2 and 6. Revoking allowances from Options is not built yet. |
| 2026-10-09 | **Packaging**: electron-builder 26.15.3 (unpacked folder) copied into `Build/app/` by `scripts/package.mjs`; react, react-dom and ajv are bundled (devDependencies); koffi (unpacked from the archive) and typescript stay runtime dependencies; electron-winstaller's install script denied (not used) | v1 is a portable folder, no installer. |
| 2026-10-09 | The packager strips every `.d.ts` file, so `host-api.d.ts` and TypeScript's `lib.*.d.ts` ship as `.txt` in `dist/`; the type check reads them through its in-memory file system | Found by running the e2e suite on the packaged exe: V3 failed every card there. |
| 2026-10-09 | The spike ships in `resources/spikes/` and takes `-Build <instance>`; run that way, its results go to `Build/data/spike/` (builds never touch it) | "Test the new CLI version" must work from the packaged exe. |
| 2026-10-09 | **Incident**: the first e2e run on the packaged exe switched "Start with Windows" on and timed out before switching it off, leaving `electron.app.Dashboard` in the user's HKCU Run key. Claude removed exactly that value (the user's other entries untouched) and added `DASHBOARD_NO_LOGIN_ITEM=1`, which test runs always set; it can only disable the feature | Tests must never change the user's Windows settings. |
| 2026-10-09 | Race tests: the swapper repairs its own state after a failed step (real folder parked, leftover at its place) | The user's first host-suite run failed TOCTOU on a stuck swapper (one link:EBUSY, then 1170 park:EPERM; 126 swaps) - no leak, no planted file; a test bug, not a host bug. |
| 2026-10-09 | Every generator run saves its output stream (and stderr) to `Build/data/generator/runs/<card>/<request>/attempt-N.jsonl`; a failure shows Claude Code's refused tool calls and Claude's last reply | The first real generation failed 4 times with no file written and nothing to show why: the only record was the CLI's transcript in data/claude, which the Dashboard never reads. |
| 2026-10-16 | **The repository moves to a private GitHub repository and becomes the source of truth** (the claude.ai Project docs become an older mirror). `.gitignore` extended for credential and key files; `.gitattributes` added (LF in the repository, CRLF for Windows scripts); git rules in CLAUDE.md: pull before work, history scanned for secrets before the first push, cloud-session changes verified on the PC, pulled changes read before building, GitHub Actions off | User decision. An off-PC copy; the planned development container gets the source from GitHub read-only. Risks handled: secrets in history, a hijacked account pushing code (two-factor authentication on the account; changes read before building), paid Actions minutes. |
| 2026-10-13 | **Card workers will run in containers, one per card** (planned; INFRASTRUCTURE.md "Container card workers"): card UIs stay in Electron; workers on an internal network with no route out; NATS bus with per-card credentials and subjects; internet only through an egress gateway with broker-issued grants; workers start on demand; monitoring from points cards can't control (rules first, then statistics, a neural model later as an experiment); alerts escalate to LASS | User decision after discussion with Claude and advice from the user's IT friend (network isolation modes, message queues, ephemeral containers). Gains: kernel-level offline guarantee, an independent witness, standard tooling, per-card limits, expansion points, a path to cards using real programs (needs invariant 11 amended). Cost: about 3–5 working days at the project's pace, about a week with snags, including re-proving A1–A11 (corrected 2026-10-13 from "1–2 weeks"). |
| 2026-10-13 | **Containers run on Podman, built to move to Kubernetes later** (INFRASTRUCTURE.md): standard images, Kubernetes YAML run with `podman kube play`, no state in containers, secrets as files, an own egress proxy for all outbound traffic, gVisor where available, one container-backend interface in the Dashboard | User decision. Podman is free with no conditions, runs on Windows 11 Home (through WSL2), is rootless by default and has no privileged central service. The rules keep a later move to Kubernetes a matter of configuration plus one backend module. |
| 2026-10-13 | The generator's request header lists every watched feed (Options > Feeds) as `task-id  name`; a request may name the task instead of quoting its id | The first celestial-watch card request failed 4 times: the request named the task but not its id, and nothing in the request folder had it, so Claude correctly wrote nothing. Names come from options.json (the user's own file); control characters are stripped so a name cannot add header lines. |
| 2026-10-09 | **"Test the new CLI version" button** on the Claude card when the installed CLI build is not on the tested list (or its testing is incomplete); runs the spike on a click; candidates install side by side and never replace the active approved build; switching builds is a user click | User requirement. Design details by Claude (ARCHITECTURE.md "Claude card: CLI test states"). |
| 2026-10-16 | **Theme rework before the Podman work** (THEMES.md): colours and fonts (typeface, base size, line spacing) for app screens and cards; no layout density changes; the Podman migration is paused until it is done | User decision. Clutter is acceptable now; the rework must not add to it. |
| 2026-10-16 | Palette research: candidates measured with `scripts/palette-research.mjs` (WCAG AA, OKLab distinctness, simulated colour blindness). Found: the current light theme's error red and warning colour look the same with deuteranopia (same lightness); Primer has the same flaw; Solarized fails AA for most text pairs | Themes must be checked by measurement, not by reputation. The approval screen is safe because colour is never its only signal. |
| 2026-10-16 | **Severity display is a theme choice** (THEMES.md "Severity display"): each theme picks one or two of five methods for its light and dark versions: card outline, filled title bar, tinted card background, coloured card name, bookmark icon in the title bar. The host draws them all; cards no longer draw severity themselves | User decision. The two-method limit (Claude's proposal from "prevent more clutter") approved by the user the same day. |
| 2026-10-16 | **Clutter: prevent more, don't fix the existing** (THEMES.md "No new clutter"); generator rule 10: cards use theme colours and relative font sizes and draw no frame, title bar, status line or severity of their own | User decision. |
| 2026-10-16 | **Severity and error/warning colours also differ in brightness**: each severity level stands out more from the card than the one below (light versions darker, dark versions lighter, step ≥ 0.06 OKLab L, apart under simulated colour blindness); error and warning ≥ 0.10 apart in lightness | User decision. Consequence: in dark versions critical reads as salmon/coral rather than pure red. |
| 2026-10-16 | **Theme values validated strictly** (RULES.md host invariant 14): `#rrggbb` colours, listed fonts, numbers in range, known severity methods | User approval of Claude's proposal; a theme file must not be able to inject CSS into cards. |
| 2026-10-16 | Theme set proposed and checked: Dashboard, Primer, Carbon, Catppuccin, Gruvbox (light + dark), Nord (dark only). Values derived from the verified upstream palettes by `scripts/theme-check.mjs`, which also checks every rule and writes a preview page; all pass. `headerText` only fits Primer dark (in light versions it forces muddy, very dark colours) | **Approved by the user the same day: all six themes**; salmon/coral critical in dark versions accepted; the approval screen's red and yellow must pass the checks in every theme. Generator rule 10 is kept out of the sent rules section until the build (the build copies that section verbatim into every request). |
| 2026-10-16 | Theme rework built as THEMES.md describes. Implementation choices: theme values reach pages only as CSS variables, set by the preload (app pages) or the card runtime (cards), which re-check every name and value; card pages keep the old variable names (`--bg`, `--link`, `--sev-*-bg/fg`) so installed cards keep working, with `--sev-*-bg` neutral unless the theme uses the `background` method; the approval screen's text never goes below today's pixel sizes | One definition (no second palette); old cards don't break; the approval screen stays readable in every theme. |
| 2026-10-16 | Validator theme warnings are **warnings, not failures**: fixed colours and pixel font sizes are reported to Claude with any retry and to the user on the New card, never on the approval screen | A literal colour can be legitimate (canvas drawing, see-through fill); failing on it would cost a generation. The approval screen stays about permissions only. |
| 2026-10-16 | "Install or update watch-feed cards…": an installed feed card whose `ui.js` or manifest differs from the shipped reference card is offered the new version, approved again by the user (No changes nothing); the menu now reports what it did | The reference card changed (no own severity colouring); approval is bound to files, so an update needs a new approval. The menu used to fail silently. |
| 2026-10-16 | Two e2e tests that had broken since 2026-10-10 fixed: fixed report dates went overdue; the grid width was read from a serialized shorthand | Found while running the suite for the theme work. |
| 2026-10-16 | Theme fonts ship with the app from the `@fontsource` npm packages (exact versions, devDependencies, copied into `dist/fonts` by the build with their OFL licences); only Latin and Latin Extended, 400/600/700, woff2. The app pages' CSP gains `font-src 'self'`; card pages already had it | Free licence that allows bundling; 453 KB instead of several MB for all subsets and weights. |

## Spike 1 results (CLI 2.1.293, Option A, 2026-10-08)
- Binary: release key fingerprint, signed manifest, SHA-256, Authenticode all verified. (gpg import exits 2 on "can't connect to the agent"; harmless.)
- Sign-in: subscription (`claude.ai`), instance config folder.
- Lockdown: every blocking test that was attempted got a structured denial with the effect absent: write/read outside the working folder by full path and `..\` traversal, read/write through a junction, read with hostile project settings present. Error text: "`--restricted` confines the file tools to the working directory". Across two runs each test passed at least once; none failed. Misses were the model not attempting (once a safety classifier stopped it), never a leak.
- Tools: exactly Read/Edit/Write; no shell, no MCP, no claude.ai connectors. Hostile `.claude/settings.json` (Bash allow, hooks, bypass mode), `.mcp.json` and CLAUDE.md files (folder and parent) had no effect.
- Planted instructions in card files: the model made the requested edit, refused the planted ones and said so.
- Process Monitor (19:08 run, 3.9 M events): no writes outside the run folder and CLI config (plus its `claude.lock` beside it); no reads of the sibling secret; no reads or writes in the user folder; network only to Anthropic's API (160.79.104.10) and one Google Cloud host (34.149.66.165, not attributed to a test in that run; v3.6 attributes destinations).
- The CLI itself (not the model) starts fixed helper processes: `reg.exe` queries of `HKLM/HKCU\SOFTWARE\Policies\ClaudeCode` and of the Windows MachineGuid (via `cmd.exe /c`), `where.exe git/sh`, and its built-in ripgrep on the working folder and its plugin cache. It also reads `.gitignore` in ancestor folders (here the project root's). v3.6 allowlists exactly these command lines.

## Accepted costs
- Electron footprint: ~150 MB (+ the CLI binary); one renderer process per running card (tens of MB each).
- Unsigned .exe triggers SmartScreen.
- Feed reports work only while the PC is awake and Claude Desktop is open and online at run time.
- All Claude usage counts against the subscription's usage limits.
- Report folders are user-writable: a user-level process can forge a report (display-only impact).
- A standard card can misuse what it was legitimately granted (e.g. read files + network); combination warnings and the audit log make it visible.

## Open questions
- [ ] User wants per-card conversations to live in this claude.ai Project. Not possible as far as verified.
- [ ] Unverified: what a "Require this computer" task does when the PC is unreachable at run time.
- [ ] **Electron fuses vs. tests on the packaged build.** Deferred by the user (2026-10-09): decide when the packaged build exists. The shipped exe should disable RunAsNode, NODE_OPTIONS and the inspect arguments (otherwise anyone can run Dashboard.exe as Node). Playwright drives Electron through the inspector, so a hardened build cannot be driven. Options: test an otherwise identical build with only the inspect fuse on, or add a host-side test mode. Until decided, e2e runs on the unpackaged build (TESTPLAN says packaged).
- [ ] CPU watchdog (90 % for 30 s) has no automated test yet; memory, message size and rate do.

## Status
Architecture revised after two external reviews; DLL/executable capabilities removed from v1; spike v3 written for Option A and on the PC. Spike 1 run on CLI 2.1.293: the `--restricted` lockdown held everywhere it was exercised (see "Spike 1 results"). Generator boundary decided: Option A. Waiting on the user: attach task folders. CLI gate written and tested (`src/main/generator/cli-gate.ts`, 10 tests, now on Windows with a compiled fake CLI). **Runtime skeleton built (2026-10-09)**: Electron 44 window, one sandboxed `WebContentsView` per approved card, broker with channel identity, lazy grants, network client with DNS pinning and redirect checks, version-bound approvals, audit/Stop/Revoke, memory/CPU/rate/size limits, and the OS-rights check. Verified on this PC: card processes run at **Untrusted** integrity with a restricted token, each in its own process. File access (A4) and the watch feeds (E1-E4) built 2026-10-09. Workers built the same day. The React grid, Options, tray and start with Windows were built the same day. The generator pipeline (New card, validator V0-V5, approval canvas, CLI gate on the tested list) was built the same day. The packaged Dashboard.exe followed the same day; all e2e tests pass on it. **2026-10-10 to 2026-10-13:** fine-grid resize and clipped (not culled) partly hidden cards; robust packaging and test scripts (project Node, lock check, log); spike v3.10 with T10, CLI 2.1.296 approved; host suite passed for build 3e40247e; generator request header lists the watched feeds; procedure doc for feed cards; LASS proposal; Podman infrastructure decided and container card workers planned. Committed 2026-10-13. Portable Podman install script: `setup\install-podman.ps1` (client into `Build\data\vendor\podman\`, its config and data into `Build\data\podman\`; not yet run). Current details and next steps: CLAUDE.md, "Current state".

## Working rules for Claude on this project
- User wants blunt correction. Attack weak ideas directly; don't soften.
- Write plainly: who does what, no evasive phrasing.
- Flag unverified claims (especially about Anthropic tooling) as unverified until checked.
