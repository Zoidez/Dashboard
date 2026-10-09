# ClaudeExchange

This folder is the only place Claude and the Dashboard exchange files.
It is data only. Nothing in here is ever executed in place.

## Layout
```
ClaudeExchange/
  EXCHANGE.md                     this file
  schemas/report.v0.json          report format (JSON Schema)
  reports/<task-id>/              written by one Claude scheduled task, read by its watch feed card
  staging/<card-id>/<request-id>/ generator working folder (Dashboard creates it; local CLI writes it)
  inbox/  todo/                   reserved for a future channel; unused in v1
```

## Rules
1. Each Claude scheduled task is connected to its own `reports/<task-id>/` folder only. Never connect `ClaudeExchange/` as a whole, or any other folder.
2. A task writes exactly one file per run: `reports/<task-id>/<runFinishedAt as YYYYMMDDTHHMMSSZ, UTC>.json`, following `schemas/report.v0.json`.
3. Tasks never modify or delete files. The Dashboard prunes old reports (keeps the last 30 by default).
4. Report content is untrusted (it summarizes web pages and messages). The Dashboard renders it as text and sanitized Markdown, and never acts on it. `severity` only picks a color.
5. Files in `staging/` run only after the Dashboard validates them, the user approves them, and the Dashboard copies them into `data/cards/`.

## Severity
| Level | Meaning |
|---|---|
| none | nothing new, or nothing that matters |
| low | minor items, worth a glance |
| medium | notable, read today |
| high | significant, look soon |
| critical | needs attention now |

## Connected tasks
| Task | Task ID | Folder |
|---|---|---|
| Weekday morning brief | trig_01ErEFUF3HVkStP55y82wGH1 | reports/trig_01ErEFUF3HVkStP55y82wGH1/ |
| Daily gamedev industry moves watch | trig_01JKJw5sKmS7HACpjCGdDWw8 | reports/trig_01JKJw5sKmS7HACpjCGdDWw8/ |
| Daily Kessler Syndrome watch | trig_01AmX52WU9gtbFB6fHLAW7A6 | reports/trig_01AmX52WU9gtbFB6fHLAW7A6/ |
