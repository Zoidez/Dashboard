# Dashboard

Portable Windows dashboard of modular cards, with a Claude card that writes new cards.
Design docs live in the claude.ai Project "Dashboard" (PROJECT.md, RULES.md, PRESETS.md, ARCHITECTURE.md).

- `spec/` — manifest schema, host API, report schema (apiVersion 0)
- `spikes/` — throwaway tests run before building on assumptions
- `Build/` — the instance; run the app from here. Builds write only `Build/app/`.
  `Build/data/` and `Build/ClaudeExchange/` hold state and are never touched by builds.
