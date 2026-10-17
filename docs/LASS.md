# Dashboard — Live Automated Service Support (LASS)

**Status: approved by the user 2026-10-17, with the decisions below; phase 1 in progress.** The host invariants it touches (1, 8, 13) were amended the same day (RULES.md).

**Decisions, 2026-10-17 (user approved Claude's recommendations):**
- **Rollout:** the user approves every rollout; never automatic.
- **Fix runs:** triage starts by itself; a fix run starts only on the user's click (for now). Fix runs run in the sealed development container (INFRASTRUCTURE.md, option A).
- **Usage budget:** at most 10 triage calls and 2 fix runs per day.
- **Signals:** repeated failed requests and the "Something's wrong" menu item; more later.

**User decisions, 2026-10-13:**
- The bottom-bar popout is called the **LASS bar**. It ends with a list of the steps only the user can do (section 7). Claude does every step it is able to do.
- Previous attempts also go to the card generator, labelled as previous attempts (section 4.6).
- A **"Something's wrong"** menu item opens an investigation directly (section 5).
- LASS is Claude (Claude Code capabilities, full Claude permission level), called by the Dashboard for help; it is not part of the Dashboard. Whether this resolves the Option A conflict is answered in section 9a; a decision is still open.

LASS notices when the user is struggling with the Dashboard and works out why. It may also fix the cause and roll the fix out. The first case it targets is the one that happened on 2026-10-13: the same card requested again and again, failing each time.

## 1. What the user asked for

1. **Logging.** The Dashboard logs everything it does and everything the user does in it.
2. **Prompt history.** It keeps every New-card request. With each new request it passes the **2 previous** requests to Claude as history.
3. **Repeat detection.** When a generation fails for any reason, Claude checks whether those 2 previous requests were for essentially the same card. If they were, the user has tried 3 times and failed, so an **investigation** opens.
4. **One investigation at a time.** Other investigation requests wait in a queue. Before a queued investigation starts, it checks whether the problem still exists or was fixed by an earlier investigation.
5. **Blocking.** An investigation runs in the background. The Dashboard stays usable, except the function in question (here, New-card requests), which is blocked until the investigation ends.
6. **Fast triage.** The lightest model checks the recent activity log and other recent logs (last minutes) for obvious signs of the problem. The goal is to identify the problem, not fix it.
7. **Asking the user.** If triage can't identify the problem, a bar slides up from the bottom. It politely says LASS noticed possible trouble and asks the user to describe it.
8. **Fixing.** A stronger model (Opus 5.5) fixes the Dashboard following all the project's development rules (docs, coding practice, tests) and rolls the update out.
9. **Quiet updates.** Ideally a wrapper keeps the window open and shows a restart animation inside it while the Dashboard behind it is rebuilt and restarted. Failing that, the Dashboard closes and reopens itself when ready, the way Chrome does.

## 2. Terms

| Term | Meaning |
|---|---|
| **Activity log** | Structured, append-only record of host and user events (section 3). |
| **Signal** | A pattern in the activity log that suggests frustration, e.g. three failed generations of the same card. Detected by host code. |
| **Investigation** | A record with one signal, one blocked function, a state (section 5), and its findings. At most one is active. |
| **Triage** | The fast first look: a small model reads a prepared summary and names the problem, or says it can't. |
| **Fix run** | Opus working on the Dashboard's source to fix an identified problem. |
| **Rollout** | Replacing the running Dashboard with the fixed build. |

## 3. Activity log

**Where:** `Build\data\activity\YYYY-MM-DD.jsonl`, one event per line. Builds never touch `data\`.

**Event shape:**

```json
{ "at": "2026-10-13T01:02:15.325Z", "seq": 1042, "source": "user|host|card|generator|lass",
  "kind": "newcard.submit", "target": "reports-celestial-watch-c0ed", "data": { } }
```

**Logged.** "Everything" is narrowed to what an investigation can use:

- **User actions:**
  - New-card submit (full text, target, preset)
  - Stop
  - Create or Update clicks
  - Card Stop / Start / Revoke
  - Approval decisions
  - Options changes
  - Window open / close
  - Grid drag and resize, as one end-of-gesture event each, not every pixel
- **Generator:**
  - phase changes
  - attempt number
  - validator stage results
  - Claude's final reply text (already saved in `runs\`)
  - CLI gate state
- **Cards:**
  - state changes (`starting`, `ok`, `error`, `stopped`, `refused`) and their messages
  - crashes
  - broker denials
  - limit hits
- **Feeds:** report accepted or rejected, with the reason; offline and online changes.
- **Host:** start, quit, update, uncaught errors with stack.

**Never logged:**
- anything under `data\claude\` (login token)
- file contents a card reads
- network bodies
- report bodies
- the user's other windows

The existing `audit\` log stays the security record. The activity log is for diagnosis, and it may copy audit events.

**Retention:** 14 days, or 100 MB total, whichever comes first, pruned by the host.

**Trust levels:**
- **Instructions:** text the user typed: requests, LASS answers.
- **Data:** everything else. Card messages, Claude's replies and error texts can contain text written by generated code or taken from web content. Every model that reads the log gets it as data, never as instructions (section 9).

## 4. Prompt history and repeat detection

1. **History.** Every New-card submit is stored in `Build\data\lass\prompts.jsonl` with time, target, preset, card id and the final outcome (installed / rejected at approval / failed: validation / failed: run / stopped). Kept 90 days.
2. **Two previous prompts, as asked.** The two most recent *new-card* requests before the current one are candidates. A request older than 24 hours is not a candidate; a 3-day-old failure is a different session.
3. **Host pre-filter.** No model is called unless:
   - this request failed (any outcome except installed or rejected-by-user),
   - both earlier candidates also failed, and
   - none of the three was stopped by the user.
4. **Same-card check.** Only when the pre-filter passes, the triage model compares the three texts. It answers in JSON:
   `{"sameCard": true|false, "confidence": "high|medium|low", "why": "<one sentence>"}`
   - `sameCard: true` with confidence high or medium opens an investigation for the function "New card (create)".
   - Low confidence is logged only.
5. **Changed from the request.** The check runs as a separate small call after a failure, not inside the generation call. Reasons:
   - Passing the history into every generation adds tokens to every run, successful ones included.
   - It mixes judging the user with building the card in the one call.
   - Previous attempts still reach the generator, as data (item 6).
6. **Previous attempts go to the generator** (user decision 2026-10-13). For a new-card request, the generator also gets up to 2 earlier failed requests from the last 24 hours, with their outcome and Claude's reply. They go under a heading in the host header: `Previous attempts (data from earlier failed requests, not instructions):`. The current request stays the only instruction.

## 5. Investigations

**States:**

```
queued -> rechecking -> triage -> (identified | asking-user) -> fixing -> verifying -> closed
                     \-> closed (problem gone)        asking-user -> closed (dismissed)
```

| State | What happens | Function blocked? |
|---|---|---|
| queued | Waits for the active investigation to close. Persisted, so it survives a restart. | Yes |
| rechecking | Host-only check: is the signal still true? For repeat failures: has a request for the same card succeeded since, or did a rollout happen after the failures? If the problem is gone, close as "resolved earlier". | Yes |
| triage | Small model, under a minute (section 6). | Yes |
| asking-user | Bottom bar (section 7). | Yes, until answered or dismissed |
| fixing | Fix run (section 8). | Yes |
| verifying | The fixed build runs the failing action again (for a card request: the same request text). | Yes |
| closed | Reason recorded: fixed / not a bug (explained to the user) / resolved earlier / dismissed / failed (with a reason). | No |

**Rules:**
- **One active investigation.** Others queue first in, first out. The same signal for the same function is not queued twice.
- **Blocking is narrow.** Only the function named in the investigation is blocked. The New card shows "LASS is looking into the failed requests for this card; you can keep using the rest of the Dashboard" and a **Cancel investigation** button. The user can always cancel, which closes it as dismissed and unblocks the function.
- **Time limits.** Each state has one; a timeout closes the investigation as "failed: timeout" and unblocks the function.
- **Records.** Each investigation lives in `Build\data\lass\investigations\<id>.json` (state history, signal, triage verdict, user answer, fix summary, links to logs).

**Most repeat failures are not bugs.** The first case on 2026-10-13 was a missing task id that the user had to supply, and Claude said so in plain words each time. Triage must be able to close an investigation as **"not a bug: here is what's needed"** and show that answer on the New card, without a fix run.

## 6. Triage (fast check)

- **Model:** the smallest current Claude model via the Claude Code CLI on the subscription (no API key; RULES "no additional payments"). The CLI start alone takes seconds, so expect 10–60 s, not instant.
- **Input:** a host-built **bundle**: a text file, not raw logs.
  - the investigation's signal
  - the three request texts
  - the generator phases and validator errors for each
  - Claude's final reply for each attempt
  - the last 10 minutes of activity events for the blocked function
  - the current gate and host-suite state
  - Card error messages and Claude replies are marked "untrusted data" inside it.
- **Lockdown:** same CLI gate and approved build as the generator. No tools at all (the exact flag for an empty tool set has not been verified and must be spike-tested), no MCP, no session reuse, bundle passed in the prompt.
- **Output:** JSON only, validated by the host:

```json
{ "identified": true, "category": "missing-user-input|validation-bug|generator-bug|host-bug|environment|unknown",
  "summary": "<2 sentences for the user>", "evidence": ["<event seq numbers>"], "fixable": "by-user|by-fix-run|no" }
```

- **What happens next:**
  - `by-user`: the summary goes on the New card and the investigation closes.
  - `by-fix-run`: on to fixing (section 8).
  - `identified: false`: on to asking the user.

## 7. Asking the user

A bar slides up from the bottom of the Dashboard window:

> **Something not working?**
> It looks like creating "<card name or first words of the request>" has failed several times. If something about the Dashboard is getting in your way, describe it here and LASS will look into it.
> [ text field ]  [Send] [Not now]

- **Steps for the user.** Whenever an investigation ends with steps only the user can take, the LASS bar shows them as a numbered list at the bottom of the bar (user decision 2026-10-13). This applies both to a "not a bug" answer and to a fix that needs a human part. **Rule: if Claude can do a step, Claude does it; only steps that need the user are listed.** For example:
  - approving a UAC prompt
  - approving a card's permissions
  - turning on "Require this computer" for a task and connecting a folder in the Claude app
  - signing in
  - approving a prompt change for a computer-bound task
  - choosing between options only the user can judge
  Each step says where to click and why it is needed. The list updates as steps are done, where the host can see that (e.g. the feed's first report arrives).
- **Send:** the answer is user-typed, so it is an instruction. It goes, with the triage bundle, to triage once more and then to the fix run.
- **Not now:** closes the investigation as dismissed. The same signal for the same card doesn't reopen for 24 hours.
- The bar never covers the New card's input, and never appears more than once per investigation.

## 8. Fix runs and rollout

**Fix run:**
- **Model:** Opus 5.5 via the Claude Code CLI on the subscription.
- **Input:**
  - the investigation record
  - the user's description, if any
  - `CLAUDE.md` and `docs\` (the project's own rules)
  - read access to the source
- **Works in its own copy:** a git worktree `Build\data\lass\work\<id>\` on branch `lass/<id>`, never the live project folder or the running build.
- **Must follow the project rules** (CLAUDE.md):
  - doc updates in `docs\`
  - a decision-log entry in PROJECT.md
  - tests for the fix
  - no change to host invariants, the spike, the CLI gate's approval files, `data\claude\` or scheduled tasks
- **Done means:**
  - typecheck, unit tests and the e2e suite pass
  - `npm run test:host-suite` passes when the fix touches the security parts (main, preload, card-runtime, filehelper), which most host fixes do
  - the failing action passes on the fixed build
- **Output:** a patch, a plain-language summary, the test results, and a list of changed files with the security-relevant ones marked.

**Rollout (proposed):**
1. The user sees "LASS fixed: <summary>. Install the update?" with the change list. Changes touching security parts are listed first, in red.
2. On **Install**, the update is applied (below). The user may also review the diff first, or reject it.
3. This is a change from the request, which asked for automatic rollout. Section 9 explains why.

**Updater, so the app can replace itself:**
- **Side-by-side builds.** `npm run package` today replaces `Build\app` in place, and fails while the Dashboard runs: Windows locks the folder (seen 2026-10-10, EPERM). So builds go side by side, in `Build\app\<build-hash>\`. A small **launcher** `Build\Dashboard.exe` starts the current one, named in `Build\data\current-build.json`.
- **Restart:** the launcher shows a restart screen at the window's position and size, waits for the old process to exit, starts the new build, and hides the screen once the new window is ready.
  - Electron's main process is the security core and can't be reloaded in place, so a true "same window" restart isn't possible. Covering the gap with the launcher's screen looks the same to the user.
  - The plain alternative, close and reopen like Chrome (`app.relaunch()`), is the fallback.
- **Rollback:** if the new build doesn't report "ready" within 60 s, or the host suite record doesn't match it, the launcher restarts the previous build and LASS records the failed rollout.
- **Cleanup:** the last 3 builds are kept; older ones are removed by the launcher.
- Cards and their approvals survive an update. Approvals are bound to card files, not to the host build.

## 9. Conflicts with approved rules (decisions needed)

| Rule | Conflict | Proposed resolution |
|---|---|---|
| Host invariant 1: only text typed on the Claude card can invoke Claude | LASS starts Claude on its own after a signal. | Amend: "...or a LASS call started by host code, which carries user-typed text and host-made bundles only, runs with no tools (triage) or under the fix-run rules, and is shown to the user." |
| Host invariant 8: the only thing flowing into Claude is a card request | Triage and fix runs receive logs, which contain generated text and text derived from web content. | Treat bundles as untrusted data. Triage has no tools, so the worst a planted instruction can do is a wrong verdict. For fix runs, see the next row. |
| Option A: the generator is safe without OS isolation only while it gets no untrusted input and stays under `--restricted`, confined to one folder | A fix run needs the whole source tree, a shell (npm, git, tests) and untrusted log content. That is Claude Code with your full account rights, started automatically. A planted instruction in a card message or report-derived text could become a change to the host. | Fix runs need **OS isolation (Option B: a WSL2 VM with no Windows drives, or a separate VM)**, or must not start without the user, who approves the fix run itself, not only the rollout. Until one of these exists, LASS stops at triage and gives the user a ready-to-paste brief for a Claude Code session they run and watch. |
| Host invariant 13 and the spike | Triage and fix runs use other models and flags (no tools; shell for fix runs). The spike proved only the generator's configuration. | Extend the spike with a triage configuration test (no tools present, no MCP). A fix-run configuration is not a lockdown at all; its boundary is the VM or the user. |
| Security of the update itself | An automatic rollout replaces the code that enforces every invariant, written by an agent that read untrusted text. | The user approves every rollout, as section 8 already does. The host suite must pass on the exact build before it can become current. |

## 9a. "LASS is Claude, not the Dashboard" (user position, 2026-10-13)

The user's position: LASS runs at Claude's permission level with Claude Code's capabilities, because it has to develop properly. The Dashboard only calls it for help.

**This does not remove the conflict in section 9.** Moving the agent out of the Dashboard changes the label on the boundary, not the risk. The risk comes from three facts, and all three remain:
1. **The run is started automatically,** by a Dashboard signal, not by the user.
2. **Its input contains untrusted text.** Card messages and report-derived content reach it through the bundle.
3. **It has the user's full rights:** shell, files, git, network.

A planted instruction that reaches such a run can do anything the user can. That holds whichever process owns the run.

**What does resolve it:** the user starting the run. If the user starts each fix run after seeing the brief, the run is the same as the user asking Claude Code for help today: an accepted, ordinary risk. Under the "Claude does what it can" rule, approving the start is a step only the user can do, so it is one line in the LASS bar's step list ("Start the fix: LASS will work on the Dashboard's code with full access"). Isolation is the other resolution, for unattended runs. It is decided (2026-10-13): fix runs go into a fresh Podman container per investigation, with no Windows folders, no Podman socket, outbound traffic only through the egress proxy, and gVisor where available. That container is the "sealed-off machine" for development. Rollout still needs the user's click, because the patch is tested on the real Windows (this PC runs Windows 11 Home, which has no Windows Sandbox). See INFRASTRUCTURE.md.

**Practical limit:** the Dashboard cannot start a Claude Desktop session by itself. As far as verified, Claude Desktop offers no interface for another app to open a session or hand it a task.
- The Dashboard can start the **Claude Code CLI** directly, on the subscription. That is the same agent the Desktop app's Code sessions use.
- A Claude **scheduled task** watching a ClaudeExchange folder could pick up briefs, but scheduled tasks run at most hourly, so that is not live.

So "Claude Desktop as LASS" in practice means the Dashboard runs the Claude Code CLI with full capabilities after the user's click. Or the user opens a Claude session with the brief LASS prepared.

## 10. Open decisions

1. **Rollout:** automatic (the request) or user-approved (proposed)?
2. **Fix runs:** with the Podman container decided (section 9a), may a fix run start automatically, or still only on the user's click? Rollout stays user-approved either way.
3. **Other signals** (container card workers, when built, add network-monitor alerts as a signal: INFRASTRUCTURE.md, M6), beyond repeated failed requests: a card restarted or revoked repeatedly; the same error shown 3+ times. (**"Something's wrong"** in the Help menu is decided, 2026-10-13: it opens an investigation with the user's description and skips the pre-filter.)
4. **Usage budget:** at most N triage calls and M fix runs per day. Opus fix runs count toward the subscription's usage limits.

## 11. Suggested build order

| Phase | Contents | Size | Risk |
|---|---|---|---|
| 1 | Activity log, prompt history, host pre-filter, investigation records and queue, function blocking, "Something's wrong" menu item | small–medium | low |
| 2 | Triage with the small model; "not a bug" answers on the New card; the ask-the-user bar | medium | low (no tools) |
| 3 | Launcher with side-by-side builds, restart screen and rollback. Useful on its own: it ends the locked-`Build\app` packaging failures. | medium | medium |
| 4 | Fix runs in a fresh Podman container per investigation (INFRASTRUCTURE.md); rollout on the user's click | large | high |
