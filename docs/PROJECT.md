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
- [ ] Spike: tested list `cli-approvals.json` (one record per build) instead of the single `cli-approval.json`; install candidates into `data/vendor/claude/<version>-<sha12>/` (done in v3.8, 2026-10-09); take the build to test as a parameter.
- [ ] CLI gate: look the installed build up in the list; return a reason code (untested, incomplete, blocked, hash-mismatch, unreadable) instead of text only, so the card picks the state.
- [ ] Claude card: the states and buttons in ARCHITECTURE.md; launch the spike window; "Switch to CLI x.y.z".
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
- [ ] Portable packaged build into `Build/app/` + `Build/Dashboard.lnk` setup step; decide Electron fuses vs. testing the packaged build (see Open questions).

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
| 2026-10-09 | **"Test the new CLI version" button** on the Claude card when the installed CLI build is not on the tested list (or its testing is incomplete); runs the spike on a click; candidates install side by side and never replace the active approved build; switching builds is a user click | User requirement. Design details by Claude (ARCHITECTURE.md "Claude card: CLI test states"). |

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
Architecture revised after two external reviews; DLL/executable capabilities removed from v1; spike v3 written for Option A and on the PC. Spike 1 run on CLI 2.1.293: the `--restricted` lockdown held everywhere it was exercised (see "Spike 1 results"). Generator boundary decided: Option A. Waiting on the user: attach task folders. CLI gate written and tested (`src/main/generator/cli-gate.ts`, 10 tests, now on Windows with a compiled fake CLI). **Runtime skeleton built (2026-10-09)**: Electron 44 window, one sandboxed `WebContentsView` per approved card, broker with channel identity, lazy grants, network client with DNS pinning and redirect checks, version-bound approvals, audit/Stop/Revoke, memory/CPU/rate/size limits, and the OS-rights check. Verified on this PC: card processes run at **Untrusted** integrity with a restricted token, each in its own process. File access (A4) and the watch feeds (E1-E4) built 2026-10-09. Workers built the same day. The React grid, Options, tray and start with Windows were built the same day. Next for Claude: the generator pipeline (New card, validator, approval canvas).

## Working rules for Claude on this project
- User wants blunt correction. Attack weak ideas directly; don't soften.
- Write plainly: who does what, no evasive phrasing.
- Flag unverified claims (especially about Anthropic tooling) as unverified until checked.
