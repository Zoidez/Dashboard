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
- [ ] **Attach each task to its own `Build\ClaudeExchange\reports\<task-id>\` folder in the desktop app.** Without it reports cannot be written.
- [x] Paid "extra usage" is off.
- [x] UI framework: React.
- [x] **Run `spikes\spike1-cli.ps1`** on CLI 2.1.293 (runs 2026-10-08 05:27 and 19:08; Process Monitor analysis of the 19:08 run). Results: see "Spike 1 results".
- [x] Generator boundary for v1: **Option A** (`--restricted`, no OS isolation), decided 2026-10-09.
- [ ] **Run spike v3.8 on CLI 2.1.293** (v3.7's run on 2026-10-08 20:30 was blocked by a harness bug: it rejected a helper command line Windows logged with a double space; v3.8 fixes it and ignores 3.7 runs). Repeat if it ends INCOMPLETE; passes add up.
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
- [ ] Native file helper (koffi: CreateFileW + GetFinalPathNameByHandleW, NtCreateFile with RootDirectory) and `api.fs` read/list/stat/write, with A4. Delete last, only if race-resistant. ADS detection (FindFirstStreamW) for VALIDATOR V0.
- [ ] Reports + watch-feed preset (chokidar, report validation, offline banner, retention) and the sanitized Markdown renderer (replaces the interim plain-text `ui.markdown`).
- [ ] `worker.js` as a Web Worker in the card view (messaging over the same port).
- [ ] React grid, File > Options, tray and start with Windows.
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
- [ ] **Electron fuses vs. tests on the packaged build.** The shipped exe should disable RunAsNode, NODE_OPTIONS and the inspect arguments (otherwise anyone can run Dashboard.exe as Node). Playwright drives Electron through the inspector, so a hardened build cannot be driven. Options: test an otherwise identical build with only the inspect fuse on, or add a host-side test mode. Until decided, e2e runs on the unpackaged build (TESTPLAN says packaged).
- [ ] **`net.http` to private IP literals** (e.g. `https://169.254.169.254`, `https://192.168.1.10`) passes the manifest schema, and the broker allows it because the permission names the address. PERMISSIONS.md marks only localhost red. Proposal: mark any private, link-local or loopback IP literal red too.
- [ ] `ui.openLink` "after the user clicks": the host cannot see user activation in the card's process. Current guard: https only, no credentials, one link per 2 s per card. Accept, or route links through a host-drawn confirmation.
- [ ] CPU watchdog (90 % for 30 s) has no automated test yet; memory, message size and rate do.

## Status
Architecture revised after two external reviews; DLL/executable capabilities removed from v1; spike v3 written for Option A and on the PC. Spike 1 run on CLI 2.1.293: the `--restricted` lockdown held everywhere it was exercised (see "Spike 1 results"). Generator boundary decided: Option A. Waiting on the user: attach task folders. CLI gate written and tested (`src/main/generator/cli-gate.ts`, 10 tests, now on Windows with a compiled fake CLI). **Runtime skeleton built (2026-10-09)**: Electron 44 window, one sandboxed `WebContentsView` per approved card, broker with channel identity, lazy grants, network client with DNS pinning and redirect checks, version-bound approvals, audit/Stop/Revoke, memory/CPU/rate/size limits, and the OS-rights check. Verified on this PC: card processes run at **Untrusted** integrity with a restricted token, each in its own process. Next for Claude: native file helper (A4), then reports and the watch feed.

## Working rules for Claude on this project
- User wants blunt correction. Attack weak ideas directly; don't soften.
- Write plainly: who does what, no evasive phrasing.
- Flag unverified claims (especially about Anthropic tooling) as unverified until checked.
