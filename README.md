# Dashboard

Portable Windows dashboard of modular cards, with a Claude card that writes new cards.
Design docs live in the claude.ai Project "Dashboard" (PROJECT.md, RULES.md, PRESETS.md, ARCHITECTURE.md).

- `spec/` — manifest schema, host API, report schema (apiVersion 0)
- `spikes/` — throwaway tests run before building on assumptions
- `Build/` — the instance; run the app from here. Builds write only `Build/app/`.
  `Build/data/` and `Build/ClaudeExchange/` hold state and are never touched by builds.

## Development
Use the project-local Node (`tools/node`, Node 24; see `CLAUDE.md`), then:
- `npm run build` — bundle into `dist/`
- `npm start` — run the app on the `Build/` instance
- `npm test` — typecheck, unit tests, end-to-end tests
- `npm run package` — portable `Build/app/Dashboard.exe` (`npm run setup:shortcut` once for `Build/Dashboard.lnk`)
- `npm run test:race` — the two 5-minute junction-swap races; `npm run test:host-suite` — security suite + record for this build

- Dima
