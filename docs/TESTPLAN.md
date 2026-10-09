# Dashboard — v1 test plan

Approved 2026-10-09. Built around the negative tests in ARCHITECTURE.md "Verification". Every test is automated unless marked MANUAL, runs on the user's Windows PC against a packaged build in a throwaway instance folder (`DASH_EXE=<path to Dashboard.exe> npx playwright test -c test/e2e/playwright.config.ts`; without DASH_EXE the same tests run on the dev build), and reports PASS / FAIL / INCONCLUSIVE under the same evidence rules as the spike (RULES.md, Spike evidence rules): a blocking test passes only if the forbidden thing was attempted, was refused and logged, and its effect is absent.

Tooling: Node's built-in test runner for host modules; Playwright's Electron support for the running app; hostile test cards that try forbidden things; Process Monitor for the file and process checks, as in the spike.

## A. Host security suite (the build must pass all of these; VALIDATOR.md depends on it)
1. **Card isolation:** each card runs in its own OS process (process IDs compared), sandboxed, without Node (`require`, `process` undefined), with no preload API beyond the message port. The card's OS process runs at Untrusted integrity level with a restricted token, in a job object that forbids child processes; a card trying to open a file in the user folder outside the broker fails at the OS level (ARCHITECTURE.md, "OS rights below the broker").
2. **Network blocked:** a hostile card tries `fetch`, XHR, WebSocket, `sendBeacon`, EventSource, `<img>`/CSS/font/`<link>` loads, form submit, `window.open`, navigation, Worker `importScripts` from a URL, WebRTC, DNS prefetch. All blocked and logged; a local listener sees no connection.
3. **Identity:** a card's message claiming another card's ID gets only its own permissions; a stale port after reload is refused.
4. **Files:** reads, writes and deletes via `..`, a junction, a symlink, an 8.3 short name, `\\?\`, a UNC path, an alternate data stream, a reserved device name; a junction swapped between check and use. All refused; Process Monitor confirms nothing outside the scope was touched. The junction swap is a 5-minute race (user design 2026-10-09, `npm run test:race`): a separate process flips the folder between real and junction at random 50–400 ms intervals while the checker reads and writes every 0.5 s; it passes only with at least 300 swaps, checks that met both states, no leak, nothing planted outside. The same race runs for delete (`test/race/delete-race.test.ts`): nothing outside may disappear or change.
5. **Broker network:** an `api.net.request` to an unapproved origin, path or method; a redirect from an approved origin to an unapproved one; to loopback, private and IPv4-mapped IPv6 addresses; a hostname that first resolves public and then to 127.0.0.1. All refused.
6. **Reserved and removed APIs:** `api.process`, `api.claude`, `api.bus` always fail; `api.ffi` does not exist; manifests requesting reserved permissions or `ffi.call` are rejected.
7. **Version binding:** a card whose files change after approval, between hashing and approval, or between approval and load is not served.
8. **Browser permissions:** camera, microphone, clipboard, notifications, geolocation, USB/HID/serial requests are denied.
9. **Resource limits:** memory, message size and rate limits stop and flag the card.
10. **Audit, Stop, Revoke:** successful sensitive operations appear in the audit log; Stop kills the view at once; Revoke removes the approval and the card stays stopped.
11. **Lazy grants (host invariant 4):** a freshly started card holds no grants until it calls; the first call is checked against the current approval. After Stop, Revoke, a forced crash, a reload, an update and an app quit: the grant table is empty, every file handle, watch and in-flight request opened for the card is closed (Process Monitor and the broker's own counters), and an old port's request is refused. Revoking while the card runs refuses its next request and stops it.

## B. Generator and CLI gate
1. The CLI gate unit tests (`test/cli-gate.test.ts`), plus on Windows: a running CLI and its children are killed with `taskkill /T` when the binary or the approval changes.
2. A CLI build without an approved record is never started; the New card shows the matching state and button (ARCHITECTURE.md, "Claude card: CLI test states").
3. "Test the new CLI version" opens the spike, never replaces the active build, and the card updates when the tested list changes. MANUAL for the UAC prompts.
4. The CLI is started only through the gate (code search plus a runtime check that every CLI process has the gate as parent).
5. Every generation's tool list is exactly Read/Edit/Write; anything else aborts the run.
6. Spike 1 itself, for every new CLI version (RULES.md, 1a/1b).

## C. Validator
1. Each V0–V5 rule has a failing fixture card and a passing one.
2. The reference cards (CARDS.md) pass.
3. A card that tries a forbidden call in the smoke test fails even though the call was denied.
4. With the host security suite marked failed, nothing is approved.

## D. Approval canvas (PERMISSIONS.md)
1. Every permission type renders its plain-words line and reason.
2. Each single-permission marking and combination D1–D3 turns red and is tagged; unchecking a line clears the marking at once.
3. Approve with red present shows the dialog; No changes nothing; Yes, only now asks again on the next update; Yes, always does not ask again for the same scopes and asks again when a scope changes; allowances are per card and revocable.
4. Update diffs show added, removed and changed permissions.

## E. Feeds (PRESETS.md)
1. Valid report: severity colour and label, bottom line, body, sources.
2. Invalid JSON, missing severity, `status: failed`, and an overdue report each show the "Feed offline" banner with the last good report kept.
3. Markdown with script, HTML, `javascript:` links and remote images is rendered inert.
4. Retention keeps the last 30 reports.

## F. App
1. Portability: nothing written outside the instance folder (Process Monitor over a full session); no %APPDATA%.
2. Tray, start with Windows, close-to-tray; cards keep running when the window is hidden.
3. Hot-loading: an approved card appears without restart; a removed card stops.
4. The New card: multi-line input, Ctrl+Enter sends, text kept on failure, Stop kills the run. MANUAL for feel.

## Exit criteria for v1
All of A, B1–B5, C, D and E pass on the user's PC; F passes or its failures are accepted in writing in PROJECT.md.
