# Dashboard — Validator spec (v0, what we have so far)

The validator decides whether a generated card (new or updated) may be shown to the user for approval. It runs in the host after every generator run, on the files in `ClaudeExchange/staging/<card-id>/<request-id>/`. A card that fails any stage is never shown for approval. Errors go back to the generator in the same conversation (at most 3 retries); after that the user sees the errors on the Claude card.

**Passing security tests is a must** (user requirement, 2026-10-09). That has two meanings here, and both are required:
1. **The host is tested.** The validator refuses to approve any card unless the running Dashboard build has passed its own security test suite (TESTPLAN.md, part A) — the same idea as the CLI gate: an untested host does not judge cards.
2. **The card is tested.** Every card must pass the security checks in stages V4 and V5 below.

Stages run in order; the first failing stage stops the run.

## V0 — Staging hygiene
- Only allowed files: `manifest.json`, `ui.js`, optional `worker.js`, `DEVLOG.md`, and static assets under `assets/` (png, svg, webp, woff2; SVG checked by V4).
- Never present: `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, hidden files, reparse points (junctions, symlinks), alternate data streams.
- Limits: total size and per-file size (values to be set; start 2 MB total, 512 KB per code file); UTF-8 text without control characters other than tab and newline.
- Nothing appeared outside the request folder during the run (RULES.md, Run lockdown 7).

## V1 — Manifest
- Valid against `spec/manifest.schema.json` (apiVersion 0). Reserved permissions (`process.run`, `process.launch`, `claude`), the removed `ffi.call`, and non-empty `channels` are rejected.
- `id` equals the card folder's ID; for an update, `id` is unchanged and `version` is higher than the installed one.
- `worker` true only if `worker.js` exists, and the reverse.

## V2 — Permissions
- Every permission has a reason. No duplicate or overlapping scopes of the same type.
- No file scope inside the Dashboard's instance folder (RULES.md, host invariant 12). Paths resolved to absolute form and checked; `./` paths may only point to folders the user created for cards (to be defined).
- No permission is declared that the code never uses (V4 builds the list of used APIs). Unused permissions fail: least privilege is a rule, not a hint.
- `reports.read` names a task that exists in Options > Feeds.

## V3 — Typecheck
- `ui.js` and `worker.js` are type-checked as JavaScript (checkJs) against `spec/host-api.d.ts`. Unknown `api.*` members, wrong argument types and calls to reserved or removed APIs (`api.process`, `api.ffi`, `api.claude`, `api.bus`) fail.

## V4 — Static security checks (on the code, without running it)
Fails on any of:
- `eval`, `new Function`, string arguments to `setTimeout`/`setInterval`.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc`; dynamic `<script>`, `<iframe>`, `<object>`, `<embed>` creation.
- Direct network: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`, `RTCPeerConnection`, `importScripts`, dynamic `import()` of anything but the card's own files.
- Navigation: `window.open`, assignments to `location`, `<a target>` without going through `api.ui.openLink`.
- Node: `require`, `process`, `module`, `Buffer`, `globalThis` property access by computed string.
- Each `api.*` call must be covered by a declared permission (e.g. `api.net.request` needs `net.http`, `api.fs.remove` needs `fs.delete`, `api.ui.openLink` needs `links.open`).
- SVG assets: no scripts, no event attributes, no external references.
**Theme warnings (never fail the card; THEMES.md rule 6, generator rule 10):** fixed colours (`#rrggbb`, `rgb()`, `hsl()`) and fixed pixel font sizes in card code. They go back to Claude with any retry ("Warnings: the card works, but fix these if you can") and the New card shows them to the user next to the result. They are not on the approval screen, which shows only permissions.

Static checks catch honest mistakes and obvious tricks. They are not the boundary: the runtime wrapper (ARCHITECTURE.md, "The wrapper") is, and V5 tests it on this card.

## V5 — Smoke test with zero capabilities
The card runs once in the real card runtime with the broker in deny-all mode (ARCHITECTURE.md, section 8). Pass requires all of:
- `mount()` returns within 10 s without an uncaught exception; `unmount()` succeeds.
- The card reports a state with `api.ui.setStatus` (RULES.md, generator rule 7).
- No blocked direct network attempt and no blocked navigation, window or browser-permission attempt (any one fails the card).
- Every capability call it attempted is covered by its declared permissions (calls outside them fail the card even though they were denied).
- Resource limits held (memory, message size, rate).

## V6 — Result
- Pass: the canvas shows the card with its permissions (PERMISSIONS.md) and, for updates, the file diff.
- Fail: errors in plain words, grouped by stage, to the generator (retries) and then to the user.

## Open
- Exact size limits and the allowed folder roots for `./` paths.
- How the host records "passed its security test suite" for its own build (likely the same pattern as the CLI approval record).
- More rules will be added as reference cards and real generations show gaps.
