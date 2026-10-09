# Dashboard — Architecture (v0, pre-code)

Status: agreed direction, not implemented. Sections marked DRAFT are proposals, not decisions. Enforced rules live in RULES.md; card presets in PRESETS.md. Reviewed externally 2026-10-08; the review's P0/P1 items are addressed below and must be proven by the negative tests in "Verification".

## Stack
- Shell: Electron (main process + renderers), TypeScript throughout
- Distribution: **portable instance folder**. For v1 the instance is `<project dir>/Build/`, and the app runs from there.
- Native access — **host only, never card code**: Win32 file handles via a host-owned native file helper; `systeminformation`; `child_process` only for the host's own use (the generator CLI). The host calls Windows functions (CreateFileW and friends) only inside its own file helper, through koffi; cards can never call DLLs (removed permanently, user decision 2026-10-09).
- Card hot-reload and exchange watching: `chokidar`
- UI: React for the Dashboard's own interface. Card contract is framework-agnostic.
- Claude: **the unmodified Claude Code CLI (`claude.exe`) shipped inside the instance, run headless on the user's subscription login**, one persistent conversation per card (RULES.md "Generator").

## The wrapper (capability broker) — the security boundary for cards
User framing (2026-10-08): the Dashboard does all outside operations; cards ask the Dashboard; anything not permitted is denied and flagged. The broker holds only if ALL of the following hold.

### 1. One isolated runtime per card
- Each card runs in **its own `WebContentsView`** (its own renderer process), not an iframe inside the Dashboard's page. UI in the view; background logic as a Web Worker inside the same view. Reason: process separation from the Dashboard and from other cards; no shared DOM, no shared origin.
- Settings: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInWorker: false`, `webSecurity: true`, `backgroundThrottling: false` (background logic keeps running when the window is hidden to the tray), **no preload that exposes privileged APIs**. The card-side `api` object is plain JS that only posts messages over the card's MessagePort.
- Cards load from a custom scheme `card://<card-id>/`, served by the host from that card's folder only. Each card is its own origin.
- Navigation and windows: `will-navigate` / `will-redirect` cancelled; `setWindowOpenHandler` denies; `<webview>` disabled. Links go through `api.ui.openLink` (https only, host opens the default browser).
- Browser permissions (camera, mic, geolocation, notifications, clipboard, USB/HID/serial, etc.): `setPermissionRequestHandler`, `setPermissionCheckHandler` and `setDevicePermissionHandler` deny everything.
- Resource limits: per-card memory cap (renderer killed and card paused on breach), message size cap, request rate cap, CPU watchdog.
- **OS rights below the broker** (user direction 2026-10-09: enforce through process rights where possible). With `sandbox: true`, Chromium starts each renderer under its Windows sandbox: a restricted token at Untrusted integrity level, in a job object that forbids creating child processes, with win32k system calls locked down. Such a process cannot open the user's files, the registry or the network by itself; it only gets what the main process hands it over IPC. The broker therefore decides what a card can reach, and Windows refuses everything else at the process level. UNVERIFIED for our exact Electron build: the host suite checks it on every card's process (TESTPLAN A1): integrity level Untrusted, restricted token, job object with no child processes allowed. A card whose process fails the check does not start.
- Process separation is **verified, not assumed**: Chromium can reuse processes. `card://` is registered as a standard, secure scheme and every card is its own host, so each card is a separate site. At start the host reads each view's OS process ID (`webContents.getOSProcessId()`), refuses to run a card that shares a process with the Dashboard or another card, and applies the memory limit to that process.

### 2. No network except through the broker
- Each card gets **its own in-memory session partition** (`card:<card-id>`, not persisted). On that session `webRequest.onBeforeRequest` cancels **every** request except `card://<card-id>/` itself: `fetch`, XHR, WebSocket, `sendBeacon`, images, CSS, fonts, forms, workers, prefetch.
- Belt and braces: CSP `default-src 'none'; script-src card:; style-src card: 'unsafe-inline'; img-src card: data: blob:; connect-src 'none'`; WebRTC IP handling `disable_non_proxied_udp`; the session proxy set to an unroutable address; DNS prefetch off.
- Permitted networking happens only via `api.net.request`, which the broker performs itself after checking origin, path prefix and method.
- Destination checks in the broker (added after external review): the broker resolves the hostname itself and **connects to the exact IP it checked** (no second lookup, so DNS rebinding can't swap the target); it refuses loopback, private, link-local, multicast and unspecified addresses (IPv4 and IPv6, including IPv4-mapped forms) unless the permission names that address explicitly; it follows redirects itself, one hop at a time, re-checking every hop against the approved origin and path, with a hop limit; https only unless the permission says otherwise.

### 3. The broker knows who is asking — from the channel, never from the message
- At card start the host creates the view and a MessagePort pair, and records `webContents.id -> card-id + approved-version-hash` in the main process. Every request is attributed by the port it arrived on. **Any `cardId` field in a message is ignored.**
- The mapping is invalidated when the view is destroyed, reloaded, or crashes; a hot-reload or update creates a new view, port and mapping. Old ports are closed.
- **Lazy grants** (RULES.md, host invariant 4): the broker keeps a grant table per running card session, empty at start. A capability is added on the card's first request for it, after re-checking the approval (version hash, scope, not revoked). When the session ends for any reason (Stop, Revoke, crash, reload, update, view closed, app quit) the whole table is dropped and everything opened under it is closed: file handles, watches, in-flight network requests, timers the broker runs for the card. A new session starts with an empty table again. Only the approval record persists; grants never do.
- Every message is validated against a strict schema (unknown fields rejected), with size and rate limits, before any permission check.

### 4. File operations are race-resistant
- File access runs in a small **native file helper** owned by the host, because Node's `fs` cannot work on verified handles.
- Read / write / stat / delete: `CreateFileW` once (with `FILE_FLAG_OPEN_REPARSE_POINT`), `GetFinalPathNameByHandleW` on that handle, compare with the approved scope, then perform the operation **on the same handle**. Reparse points (junctions, symlinks) inside a granted scope are refused.
- Create: open the **parent directory** handle the same way and verify it, then create the child relative to that handle (`NtCreateFile` with `RootDirectory`). Names are single components only: no separators, no `..`, no `:` (alternate data streams), no reserved device names (CON, NUL, COM1...), no trailing dots or spaces.
- Delete goes to the Recycle Bin. Rename, copy and recursive operations are **not in v1**.
- Build order: read, create and write first, with their negative tests. **Delete is built last.** The Windows Recycle Bin API works on paths, not handles, so it reopens the race the handle checks close. Delete ships in v1 only if the prototype proves a race-resistant way to recycle; otherwise it is deferred.
- Directory listing returns names and types only, from a verified directory handle.

### 5. Programs: not in v1. DLLs: never for cards
- Running or launching executables (including console interaction) is **removed from v1** (user decision 2026-10-08). `api.process` exists only as a reserved name and always fails; the schema rejects `process.run` and `process.launch`. Reason it needs a separate design before returning: it can grant full control of the user's account (shells, interpreters), which no wrapper can narrow. If it comes back, it comes back with its own model (e.g. a separately approved tier), not as an ordinary permission.
- Calling DLL functions is **removed from cards permanently** (user decision 2026-10-09): there is no `api.ffi`, no `ffi.call` permission and no reserved name. Native code can do anything the user can, so no permission could narrow it. Only the host calls Windows functions, inside its own file helper.

### 6. Approval is bound to a reviewed version
- An approval records the SHA-256 of every file in the card plus the manifest. The broker refuses to serve a card whose files no longer match its approval.
- Install is one atomic step: after validation the host copies the staging files into a host-only folder, hashes them **there**, shows those exact hashes and files on the canvas, and on approval renames that same folder into `data/cards/`. Files are never re-read from staging after hashing. The loader re-checks the hashes when it serves each file.
- Any update shows a diff; permissions are re-approved whenever they change.
- The approval canvas evaluates permissions **in combination** and warns in plain words, e.g. "reads `D:\Reports` AND can send data to `api.example.com` = can upload those reports".

### 7. Audit, revoke, stop
- Per-card audit log of **successful** sensitive operations (file writes and deletes, every network destination), not only denials.
- Denials are logged; repeated denials flag and pause the card.
- Every card has **Stop** and **Revoke**: Stop kills its view immediately and drops its grants; Revoke removes its approval, which also stops the card and drops its grants.

### 8. Validation smoke test runs with zero capabilities
- Generated code IS executed during validation (smoke-load). It runs in exactly the card runtime above with a broker in **deny-all mode**: every capability call is refused and recorded.
- Correction of an earlier statement: staged code is executed once, inside the zero-capability sandbox, and is never given capabilities until approved and installed.

## Process model
- Main process: window, menu, tray, broker (permission checks, attribution, audit), card loader, exchange watcher, generator pipeline.
- Dashboard renderer: the grid and Dashboard UI (React). It positions the card views; it never hosts card code.
- One WebContentsView per running card (UI + background Web Worker), each in its own renderer process and session partition.
- Native file helper: host-owned helper process.
- Generator runs: one `claude -p` child process per request, started only through the CLI gate, locked down (RULES.md), with a wall-clock timeout.
- Background: app runs in the tray and starts with Windows. Hiding the window keeps card views running; quitting from the tray stops them.

## Storage: portable, instance-relative only
No %APPDATA%. Every path is relative to the instance folder, which for v1 is `<project dir>/Build/`.
```
<project dir>/
  src/ ...          ← source code (git repo)
  spec/             ← manifest schema, host API, report schema
  Build/            ← the instance; the user runs the app from here
    Dashboard.lnk   ← shortcut to app/Dashboard.exe; created once by a setup step, never by a build
    app/            ← build output; the only folder a build writes (a build may wipe it)
      Dashboard.exe
    data/
      vendor/claude/<version>-<sha12>/claude.exe  ← unmodified signed CLI builds, side by side, installed only by the spike; the active one is set in options.json; the CLI gate checks it before every launch
      cards/        ← installed cards (hot-loaded)
      approvals/    ← per-card approval records (file hashes, permissions, timestamp)
      audit/        ← per-card audit logs
      config/
        options.json
        <card-id>/generator.json   ← that card's generator session ID (host-only)
      secrets/      ← DPAPI-encrypted
      claude/       ← CLAUDE_CONFIG_DIR for the generator; never read by Dashboard code
      generator/cli-approvals.json ← the tested list, written only by the spike; the CLI gate runs only an approved build
      electron/     ← Electron/Chromium userData, cache, logs, crash dumps
      layout.json
    ClaudeExchange/
      EXCHANGE.md
      reports/<task-id>/
      staging/<card-id>/<request-id>/
      inbox/  todo/ ← reserved (censor channel, not in v1)
```
- **Builds write only `Build/app/`.** `Build/data/` and `Build/ClaudeExchange/` are state and git-ignored. The CLI builds are state too (the spike installs and approves them), so they live in `data/vendor/`, where no build can delete them (decision 2026-10-09).
- The root shortcut is a convenience. A `.lnk` stores an absolute target, so it breaks if the instance folder moves; the setup step recreates it.
- `app.setPath()` for `userData`, `sessionData`, `logs`, `crashDumps` before `ready`, into `data/electron/`. Card sessions are in-memory and leave nothing on disk.
- The instance must not be in a OneDrive-synced folder.
- v1 has no updater; v1.1 adds one.

## Menu and Options (DRAFT v0)
Menu bar: **File** (Options…, Quit), **Cards** (Add card…, Rescan cards), **Help** (About, Open instance folder).

**File > Options**, saved to `data/config/options.json`:
- **General:** start with Windows; close-to-tray; exchange folder path.
- **Claude (generator):** CLI version and verification; Sign in / Sign out via the CLI's own flow; model; retries; timeout; per-card Reset conversation; recent usage; "Allow the generator to apply approved scheduled-task changes" (off, greyed out until verified possible).
- **Feeds:** per watched task: name, ID, report folder, offline grace period, reports kept.
- **Cards:** installed cards with approved permissions, approval hash, audit log, devlog; Stop, Revoke, enable/disable, remove (not for the Claude card).
- **Security log:** denials, flagged/paused cards, validation failures, approval mismatches. Read-only.

Never an option: letting cards invoke Claude, skipping approval or validation, giving card code Node or direct network, trusting a card-supplied identity, running staged code with capabilities, enabling reserved capabilities, connecting `ClaudeExchange/` as a whole, turning off CLI verification, re-enabling CLI self-updates or telemetry.

## Card format (DRAFT)
```
data/cards/<card-id>/
  manifest.json  ← spec/manifest.schema.json
  ui.js          ← exports mount(el, api) and unmount()
  worker.js      ← optional; runs as a Web Worker in the card's own view; no Node
  DEVLOG.md
```
- Host API: `spec/host-api.d.ts`. Every `api.*` call is a message over the card's port.

## Claude card: CLI test states (DESIGN REQUIREMENT, user 2026-10-09)
The CLI gate (RULES.md 1b) looks up the installed CLI build (version + SHA-256) in the **tested list**, `Build/data/generator/cli-approvals.json`: one record per build the spike has tested. The Claude card shows one of these states:

| Gate result | Card shows | Button |
|---|---|---|
| Build approved | normal input | none |
| **Build not on the tested list** | "This CLI version (x.y.z) has not been tested. The generator is off until it passes." | **Test the new CLI version** |
| Build on the list, status incomplete | "Testing of CLI x.y.z is not finished: N checks have not passed yet." | **Test the new CLI version** (runs it again; passes add up) |
| Build on the list, status blocked | "CLI x.y.z failed the security test (checks listed). The generator stays off." | none for this build; **Switch to CLI a.b.c** if an older approved build is kept |
| Version on the list but SHA-256 differs | "The CLI file does not match the tested build of x.y.z. It may be damaged or replaced." | none; reinstall the verified build |
| No tested list, unreadable list | reason in plain words | **Test the new CLI version** |

Button behaviour:
1. Only a click by the user starts it. Nothing starts a test automatically, and the generator stays off for the whole test.
2. The Dashboard opens the spike in a visible PowerShell window (normal, not elevated; the spike asks for UAC only to start and stop Process Monitor) with the build's version. This is the host running its own maintenance tool, not a card capability.
3. The spike verifies and installs the candidate into its own folder, `data/vendor/claude/<version>-<sha12>/`. It never replaces or deletes the active approved build, so testing a new version never leaves the Dashboard without a working generator.
4. The spike adds or updates that build's record in the tested list. The gate watches the list and re-checks when it changes.
5. While the window is open the button reads "Testing... (see the PowerShell window)" and is disabled. When the spike finishes, the card shows the new state.
6. If the candidate is approved, the card offers **Switch to CLI x.y.z** (user click). Switching changes the active build in `data/config/options.json`; the gate re-checks before the next launch.
7. Approved builds are kept side by side so the user can switch back. Removing an old build is a user action in Options.

## Generator pipeline (Claude card)
1. User types a request in the Claude card (new card, or a change to an existing one).
2. The host creates `ClaudeExchange/staging/<card-id>/<request-id>/` and writes only the context that request needs (never other cards, secrets or Dashboard config).
3. The CLI gate (RULES.md, Binary and config 1b) checks that the installed `claude.exe` is the exact build the spike approved (version + SHA-256 + approval status); only then does it spawn `claude -p`, locked down per RULES.md. On any failed check the gate refuses, kills running CLI processes and disables the generator.
4. Claude writes the card into the staging folder and appends to `DEVLOG.md`. Scheduled-task changes are written as a proposed diff, not applied.
5. The host checks that only expected files appeared, then validates: schema -> typecheck -> static capability check -> smoke-load with zero capabilities (section 8). On failure it resumes the same conversation with the errors (bounded retries).
6. Approval canvas: permissions in plain words, combination warnings, diff for updates.
7. The host records the approval (hashes), copies the card into `data/cards/`, and starts it in a fresh view.

## Verification (negative tests, required before v1 ships)
For each, a test card tries the forbidden thing and the test asserts it was blocked AND logged:
- direct `fetch`, XHR, WebSocket, `sendBeacon`, `<img>`/CSS/font loads, form submit, `window.open`, navigation, Worker `importScripts` from a remote URL, WebRTC
- a message claiming another card's ID
- file access via `..`, junction, symlink, 8.3 short name, `\\?\` path, UNC path, alternate data stream, reserved device name; swapping a junction between check and use
- calling the reserved `api.process`, `api.claude`, `api.bus`, or the non-existent `api.ffi`; a manifest requesting reserved permissions or `ffi.call`
- a card whose files changed after approval
- browser permission requests (camera, mic, clipboard, notifications, USB)
- the smoke test attempting every capability
- resource limits (memory, message size, rate)
- two cards (and a card and the Dashboard) sharing an OS process
- `api.net.request` to loopback, private and IPv4-mapped IPv6 addresses; a redirect from an approved origin to an unapproved one; a hostname that resolves to a public IP and then to 127.0.0.1
- card files changed between hashing and approval, and between approval and load
- a manifest whose file scope covers `Build\` or anything inside it

## Security model — honest version
- The wrapper is the boundary for cards: isolated Node-free runtimes, no direct network, channel-based identity, handle-based file checks, version-bound approval. It is only as good as the negative tests show.
- With programs out of v1 and DLLs out of cards for good, every v1 capability is one the broker can narrow (scoped paths, origins, fields, task IDs).
- A card can still misuse what it was legitimately granted (e.g. read files + network = upload them). The combination warnings and the audit log make this visible; the user's approval decides.
- Report folders are user-writable, so a user-level process can forge a report (display-only impact; accepted in PRESETS.md).
- The generator is a separate program (Claude Code) that does its own file I/O, so the card wrapper cannot wrap it. It is confined by its own `--restricted` mode and the lockdown in RULES.md. Instructions come only from the user and the host; card source and devlogs are lower-trust data, and the lockdown must hold even if the model obeys text planted in them (spike v3, T6). OS-level isolation for it is required before it ever processes untrusted input.
