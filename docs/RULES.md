# Dashboard — Rules

Two kinds of rules live here:
- **Host invariants**: enforced by the app's code. A generated card cannot change them, and the generator is never asked to.
- **Generator rules**: injected into every card-generation request as standing requirements. They are part of the generator's system prompt.

The user and Claude add to this file as the project goes. Every rule gets a one-line reason.

## Host invariants (enforced in code; approved by the user 2026-10-09)
1. Only the human-typed input on the Claude card can invoke Claude. No card, timer, event or fetched content can start a generation or send a prompt. Reason: anything else lets untrusted content write code on the machine.
2. No card gets the Claude generator, the Claude credentials, or the ability to send prompts to Claude. A card may only **read the output** of the specific Claude task(s) its manifest names. Reason: least privilege; a feed card needs to read, not to ask.
3. Changes to a Claude scheduled task are made only by the generator pipeline. The user sees the exact change and approves it before it is applied. Reason: editing a task changes what runs unattended in the cloud.
4. Permissions are granted **lazily** (user correction 2026-10-09). An approved permission is only a record of the user's consent; it gives the card nothing by itself. The broker grants a capability at the moment the running card first requests it, after checking the request against the current approval (card version hash, scope, not revoked), and withdraws every grant the moment the card shuts down for any reason: Stop, Revoke, crash, reload, update, the view closing, or the Dashboard quitting. Withdrawal also closes everything opened under the grant (file handles, watches, network requests in flight). Nothing is granted before the card asks and nothing survives the card, so no grant is left dangling at either end. A call outside the approved permissions is rejected and logged, whatever the card's code tries. The permission list Claude proposes is a request, not a grant. Reason: the agent that writes the code must not be the one that grants its access, and access exists only while it is in use.
5. Permissions are approved by the user on the card's canvas before the card first runs, and the approval is bound to the card's file hashes. Changed files or changed permissions require approval again.
6. Inter-card messages (later) travel only through the host, on channels both cards declare. Cards never get direct references to each other.
7. Card code runs only in its own isolated, sandboxed renderer: no Node.js, no direct network, no shared origin with the Dashboard or other cards. Its identity comes from the channel the host created for it, never from the message. Reason: these are the conditions under which the broker is a real boundary (ARCHITECTURE.md "The wrapper"). *Pending change (not in force): container card workers would need this amended; see INFRASTRUCTURE.md, "Required rule changes before building". Unchanged until the user approves.*
8. Feed reports flow one way: task runs -> `ClaudeExchange/reports/` -> Dashboard. The only thing that flows from the Dashboard into Claude is a card request (create or update) typed by the user on the Claude card. Other local apps -> Claude, if ever, go only through the censor channel. Reason: every inbound path into Claude is an instruction channel.
9. All file exchange between Claude and the Dashboard goes through `ClaudeExchange/`. No Claude task or session is ever connected to `ClaudeExchange/` as a whole; each gets only the narrowest subfolder it needs.
10. Setup and maintenance scripts never change permissions outside the instance, never trust state files that a non-admin process can modify, and undo only what they themselves changed. Reason: external review of the withdrawn account-setup script (2026-10-08).
11. Reserved capabilities stay off in v1: running or launching executables, cards talking to Claude, the inter-card bus. The broker refuses them and the validator rejects manifests that request them. Calling DLLs is not reserved but gone: cards can never call native code (user decision 2026-10-09). Reason: programs and native code can grant full control that no wrapper can narrow (user decisions 2026-10-08 and 2026-10-09). *Pending change (not in force): programs inside a card's own container; see INFRASTRUCTURE.md, "Required rule changes before building". Unchanged until the user approves.*
12. No card file permission may cover the instance folder (`Build\`) or anything inside it. The validator rejects such scopes and the broker refuses them at runtime. Reason: a card that can write its own source or devlog could plant instructions for the next generation.
13. The Claude Code CLI runs only through the CLI gate, and only a build the spike approved (version + SHA-256). Otherwise the launch is refused, running CLI processes are killed and the generator stays off (Generator, Binary and config 1b). Reason: user requirement 2026-10-09; the lockdown is the CLI's own behaviour and must be re-proven for every build.

## Generator: local Claude Code CLI (ADOPTED 2026-10-08)
The Dashboard runs the Claude Code CLI itself, on the user's subscription. The call path is the authentication: the Dashboard's own process passes the user's typed text to the CLI.

### One conversation per card (ADOPTED 2026-10-08, user requirement)
1. Creating a card starts a new conversation. The host stores its session ID in `data/config/<card-id>/generator.json`. Card code can never read this file.
2. Every update request for that card resumes the same conversation (`--resume <session-id>`).
3. **The card folder, not the conversation, is the source of truth.** Each card keeps a `DEVLOG.md`: every request, what changed, decisions and rejected approaches.
4. If the conversation can't be resumed, the host starts a new one seeded with the card's current source and `DEVLOG.md`.
5. A conversation never sees another card's conversation, source or devlog.
6. Requested by the user: these conversations should live in this claude.ai Project. NOT POSSIBLE AS FAR AS VERIFIED; local per-card sessions are the working implementation.

### Generator boundary: Option A ADOPTED for v1 (user decision 2026-10-09)
- WITHDRAWN: a separate Windows account (`dashgen`) confined by drive-wide deny rules. Never run. External review: drive-wide permission rewrites, an undo file an elevated undo would trust, undo removing settings it didn't add, account reuse, reads unverified. On Windows a standard account is only confined by broad denies.
- **Option A (adopted):** no OS isolation; the CLI runs as the user under Claude Code's own `--restricted` lockdown (below). Justified only while instructions come from trusted sources and the lockdown holds even when the model obeys planted text (see "Trust levels"). Evidence: `spikes\spike1-cli.ps1` on CLI 2.1.293, results in PROJECT.md "Spike 1 results". The host's per-run tool-list check (Binary and config, 2a) and the pinned, spike-tested CLI version (1a) are conditions of this choice.
- Option B (not chosen for v1; the path if untrusted input is ever needed): a dedicated WSL2 distribution (lightweight VM) with Windows drive automount and interop disabled.
- Either way: **OS-level isolation is mandatory before the generator ever processes untrusted input** (web content, reports, files the user did not hand it, requests from cards).

### Binary and config
0. Minimum CLI version 2.1.268 (needed for `--restricted`, `--permission-prompts`, and `auth status` reporting the config folder).
1. Run the **unmodified, Anthropic-published** CLI. On install or update verify the release key fingerprint, the GPG-signed release manifest and the SHA-256 (plus Authenticode). Pin the version. Reason: the terms require the binary to be run as published.
1a. A new CLI version is adopted only after the spike passes on it, on this PC. Until then the generator keeps the old pinned version. Reason: the lockdown is the CLI's own behaviour and can change between versions (external review, 2026-10-08).
1b. **CLI gate (enforced in code, `src/main/generator/cli-gate.ts`):** before every CLI launch the Dashboard looks up the installed build (version + SHA-256) in the tested list `Build/data/generator/cli-approvals.json` (written only by the spike; `spec/cli-approval.schema.json`) and requires: status `approved`, spike harness >= the gate's minimum, the installed `claude.exe` SHA-256 equals the approved hash, and `claude.exe --version` reports the approved version. If any check fails, the launch is refused, every running CLI process (whole tree) is killed and its pipes closed, and the generator stays disabled; the Claude card shows the reason. The gate also watches the binary and the approval file and re-checks on any change. Every CLI start goes through the gate; nothing else spawns the CLI. When the installed build is not on the tested list (or its testing is incomplete), the Claude card offers a **Test the new CLI version** button that runs the spike on a user click (ARCHITECTURE.md, "Claude card: CLI test states"); a test never replaces the active approved build. Approval = across qualifying spike runs of that exact build (same version and SHA-256, harness >= minimum, binary/sign-in checks passed, Process Monitor ran), every required check passed at least once and none failed. Reason: user requirement 2026-10-09.
2. Launch environment: built from scratch, with `CLAUDE_CONFIG_DIR` pointing at the generator's own config folder, `DISABLE_UPDATES=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`. These variables steer the CLI; they are not isolation.
2a. claude.ai connectors off: `ENABLE_CLAUDEAI_MCP_SERVERS=false` plus `"disableClaudeAiConnectors": true` in the generator's settings. Reason: signed in with the subscription, Claude Code loads the user's claude.ai connectors (Google Drive, Atlassian...) automatically (Claude Code MCP docs); the generator must never reach them. The host checks the session's tool list on every run and aborts if anything beyond Read/Edit/Write appears.
3. Login happens once, through the CLI's own sign-in flow. **The Dashboard never reads, copies, stores or forwards the login token.** Reason: the terms forbid apps collecting or intermediating claude.ai credentials or session tokens.

### Run lockdown (every generation)
1. Working folder: a fresh folder per request. For an update, the host copies the card's current source and `DEVLOG.md` into it first.
2. Tools: `--restricted`; `--tools Read,Edit,Write`; `--disallowedTools mcp__*` with `--strict-mcp-config` and an empty MCP config; `--disable-slash-commands`; bounded `--max-turns`. Settings allow only `Read(./**)` and `Edit(./**)`.
3. `--permission-mode dontAsk --permission-prompts none`: anything not allowed is denied, never prompted.
4. Trust levels (corrected 2026-10-08 after external review; earlier text wrongly called card source "trusted"):
   - **Instructions**: only the user's typed request and the host's own docs and rules.
   - **Lower-trust data**: the card's own source and `DEVLOG.md` (generated output). Passed as files to edit, never as instructions. The boundary must not depend on the model ignoring them: the lockdown has to hold even if the model obeys planted text (spike T6).
   - **Untrusted**: web content, reports, anything from outside. Never given to the generator until OS isolation exists.
   - Cards can never write their own folder (host invariant 12), so card source changes only through the generator.
5. Self-correction is host-driven: the host runs the validator and resumes the same session with its errors. Bounded retries. The model never runs commands.
6. Output is `--output-format stream-json`; the host checks exit code, timeout and the result event.
7. After each run the host checks that only expected files appeared in the request folder.
8. An update goes through the same validation and approval as a new card.
9. The host copies only card files into the working folder: never `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, or reparse points (junctions, symlinks). It checks the folder for these before every run. The settings and MCP config files live outside the working folder, so the model cannot edit its own rules. Reason: project settings can carry hooks and MCP servers that run commands without the model (spike T8).

### Spike evidence rules (from external review, 2026-10-08)
- A negative test passes only when the same tool's positive control passed, the call was attempted on the exact target, a **structured** permission denial was recorded for that same call, and the effect is absent. No attempt, an unrelated error, or a refusal visible only as error text = INCONCLUSIVE (tightened after the v3.0 review).
- Child processes: strict allowlist of exact paths and hashes. A valid signature alone is not acceptance.
- Skipped or failed monitoring = INCONCLUSIVE, never PASS.

### Limits
- Usage counts against the subscription's limits ("ordinary, individual usage").
- Long per-card conversations cost more per request; the devlog lets the host restart cheaply.
- Signing in to the unmodified binary with one's own subscription is allowed per the docs; the Dashboard never touches tokens. Not legal advice.

## Censor channel: other apps -> Claude (design, not in v1)
For future local apps that need to send requests to Claude. The Claude card does not use it.
- Flow: `app -> ClaudeExchange/inbox -> censor -> ClaudeExchange/todo -> consumer -> Claude`.
- Inbox message: `author_id`, typed payload, `nonce`, `expires`, Ed25519 signature; no sender-supplied public key; no encryption.
- Censor: pinned author keys; signature, schema and per-author request-type checks; replay/expiry rejection and rate limits; hold for approval where required; writes to `todo/` signed with its own key.
- Three layers against forged files in `todo/`: only code reads `todo/`; only the censor can write it; requests are typed actions.
- The model is never the verifier. A signature proves who sent a request, not that it is safe.
- Open: the censor's own Windows account raises the same concerns as the withdrawn dashgen setup; revisit with the generator-boundary decision. Admin-level compromise is out of scope.

## Generator rules (sent with every request)
1. Request the minimum permissions the card needs, each scoped as narrowly as possible: a specific path, origin, system-info field or task ID. Never a whole capability class when a scope will do. Give a one-line justification for each permission in the manifest.
2. Never request reserved permissions (`process.run`, `process.launch`, `claude`) or access to the generator, Claude credentials, or any Claude task other than the one(s) the card displays. Cards can never call DLLs; there is no permission for it.
3. Treat all external content as untrusted data: web responses, files and Claude task output. Render it as text or sanitized Markdown (`api.ui.markdown`). Never use innerHTML or eval on it. Load no remote scripts, styles or images. Links open through `api.ui.openLink`, which needs a `links.open` permission: list the sites when they are known; `any: true` only when the links can point anywhere (shown yellow).
4. No destructive action (delete, overwrite, send data outward) without an explicit confirmation step (`api.ui.confirm`).
5. Use only the host API. Card code has no Node.js and no direct network; `fetch`, WebSocket and similar are blocked by the host.
6. Declare `apiVersion` in the manifest.
7. Every card shows its state: loading, last-updated time, stale data, and errors, in plain words (`api.ui.setStatus`). No silent failure.
8. Background work polls at a sensible interval (minutes, not seconds, unless the request says otherwise) and respects host limits.
9. Append an entry to the card's `DEVLOG.md` on every run: the request, what changed, why, and anything tried and rejected.
