# Dashboard — Reference cards (v0)

Hand-written cards that ship with the Dashboard. They are the generator's examples to copy (GENERATOR-PROMPT.md), the validator's test cases (VALIDATOR.md), and the first cards on the grid. Written by Claude, reviewed by the user, approved like any other card. Code to follow; this file fixes what each card is and asks for.

## 1. New (permanent card)
The card for making and changing cards. Called "the Claude card" in older docs; its title on the grid is **New**. It is part of the host, not a sandboxed card: it is the only place that can start the generator (RULES.md, host invariant 1). It cannot be removed.
- **Input:** a multi-line text area (user requirement 2026-10-09) sized for long prompts: at least 6 lines visible, grows with the text up to the card's height, then scrolls. Enter adds a new line; **Ctrl+Enter** or the **Create** button sends. Spell check on. The text is kept if a generation fails, so the user can edit and resend.
- **Target:** a selector above the input: "New card" (default) or one of the installed cards (update). For an update, the selected card's name is shown on the button ("Update <name>").
- **Preset:** optional selector ("No preset", "Watch feed"...).
- **Progress:** while the generator works, the input is locked and the card shows the stage: writing, validating (retry n of 3), ready for approval. A **Stop** button kills the run (through the CLI gate).
- **Result:** "ready for approval" opens the approval canvas (PERMISSIONS.md). Errors are shown in plain words with the stage that failed.
- **CLI states:** when the CLI gate refuses, the card shows the state and button from ARCHITECTURE.md, "Claude card: CLI test states", instead of the input.
- **Permissions:** none (host card).

## 2. Watch feed: "Daily Kessler Syndrome watch" (preset `watch-feed`)
The reference for the watch-feed preset; the other two feed cards are the same card with a different task.
- **Shows:** severity label and colour, bottom line, digest body (sanitized Markdown), run time, sources as links; "Feed offline" banner per PRESETS.md.
- **Permissions:** `reports.read` for `trig_01AmX52WU9gtbFB6fHLAW7A6`. Nothing else.
- **Uses:** `api.reports.state/history/onChange`, `api.ui.markdown`, `api.ui.setAccent`, `api.ui.setStatus`, `api.ui.openLink`.
- **Danger marking:** none.

## 3. System info
- **Shows:** CPU load, memory used/total, and each disk's used/total, refreshed every minute; a small history line for CPU over the last hour (kept in `api.storage`).
- **Permissions:** `sysinfo` with fields `cpu`, `memory`, `disk`.
- **Uses:** `api.sysinfo.cpu/memory/disks`, `api.storage`, `api.ui.setStatus`; a worker with `schedule.intervalSeconds: 60`.
- **Danger marking:** none.

## 4. File watcher
- **Shows:** the newest files in one folder the user picks in the card's settings (default `%USERPROFILE%\Downloads` resolved to a real path at approval), with name, size and time; highlights files added since the user last looked.
- **Permissions:** `fs.read` on that one folder, not recursive. Changing the folder in settings is a permission change and goes back through approval.
- **Uses:** `api.fs.list/stat/watch`, `api.storage`, `api.ui.setStatus`.
- **Danger marking:** none. It is the example of a card that needs no network and must not ask for it.

## Open
- Whether the File watcher may open a file (that would be launching a program, which is reserved; for now it only lists).
