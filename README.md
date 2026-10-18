# Dashboard

**A sandboxed card platform where AI writes the code.**

Dashboard is a portable Windows desktop app that shows a grid of small *cards*: daily news digests, a used-GPU price tracker, system panels, small tools. Users don't install cards; they describe what they want. A permanent **New** card sends the request to Claude Code running locally on a Claude subscription. Claude writes the card, the app validates it, the user approves its permissions, and the card goes live.

> **Design principle:** the agent that writes the code must never be the one that grants it access.

---

## Contents

- [The problem](#the-problem)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Testing](#testing)
- [Status](#status)
- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Credits](#credits)

---

## The problem

The goal is to run code an AI wrote, from requests that may involve untrusted web content, on your own PC, and to stay safe if the AI is wrong or manipulated. Dashboard treats every generated card as untrusted. Its safety comes from boundaries enforced in code and proven by tests, not from the model behaving well.

## How it works

```
 You ──► New card ──► Claude Code (locked down) ──► Validator ──► Your approval ──► Sandboxed card
                                                                                      │
                     Claude scheduled tasks ──► report files ──► Feed service ───────┘
```

1. **Request.** You describe a card in the New card.
2. **Generation.** A restricted Claude Code session writes the card's files in a sealed working folder.
3. **Validation.** The app checks the card: structure, permissions, a TypeScript type check, static security checks, and a sandboxed smoke run. Failures go back to Claude, a bounded number of times.
4. **Approval.** You see exactly what the card asks to do (each permission with its reason; risky combinations marked) and decide.
5. **Run.** The card runs in its own sandbox. Every capability it uses passes through the broker.

**Data feeds** come from Claude scheduled tasks that run in the cloud and write validated reports into the app's exchange folder. Feed cards display them, with severity colouring and an offline banner when a feed goes quiet.

## Security model

| Layer | What it enforces |
|---|---|
| **Isolation** | Each card runs in its own sandboxed Electron view and process, at Windows' lowest integrity level ("Untrusted") with a restricted token. Cards get no Node.js, no direct network and no native code. |
| **Capability broker** | Every request a card makes goes through one broker, which checks it against your approval. Approvals are bound to the card's file hashes, so changed code needs approval again. Access is granted only when first used and withdrawn the moment the card stops. |
| **Network** | Cards reach only the sites they were approved for, with DNS pinning and redirect checks. |
| **Files** | A separate helper process with race-resistant path checks. Card folders and the app's own instance can never be granted. |
| **Locked-down generator** | Claude Code runs restricted to read, edit and write in one folder: no shell, no extensions, no account connectors, a bounded number of turns. Files that appear outside the request folder abort the run. |
| **Pinned, tested AI tooling** | The app runs only a Claude Code build whose version and SHA-256 passed the security harness. A new CLI version is refused until it passes. |
| **Self-checking builds** | Card generation is disabled unless the exact running build has passed the app's own security suite. |

The full set of rules, each with its reason, is in [`docs/RULES.md`](docs/RULES.md).

## Testing

| Suite | Covers |
|---|---|
| **Unit tests** | Broker, permissions, network rules, file checks, validator rules, CLI gate, report validation, layout |
| **End-to-end tests** (Playwright on Electron) | Isolation, network blocking, identity, file access, grants, stop and revoke, feeds, workers, the generator pipeline (with a fake CLI) |
| **Race tests** | Two five-minute junction-swap attacks against the file layer |
| **Security harness** (`spikes/spike1-cli.ps1`) | 50 checks per Claude Code build: release signature and hash, sign-in isolation, sandbox escapes by path, traversal and junction, prompt injection through planted files, hostile project settings, tool-list checks, and Process Monitor analysis of every file, process and network action |
| **Host suite** (`npm run test:host-suite`) | Runs the security-relevant suites on the current build and records its hash. The app refuses to approve new cards from any other build. |

## Status

| Area | State |
|---|---|
| Card runtime, broker, network and file layers | Built and tested |
| Watch feeds from Claude scheduled tasks | Built |
| Generator pipeline: New card, validator, approval canvas, CLI gate | Built |
| Grid with drag, fine-grained resize and clipping; Options; tray | Built |
| Portable packaging | Built |
| Card background workers in per-card Podman containers (internal network, message bus, egress gateway, monitoring) | Designed, not built ([`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md)) |
| Live Automated Service Support: diagnoses repeated failures, prepares fixes for approved rollout | Proposal ([`docs/LASS.md`](docs/LASS.md)) |

## Getting started

**Requirements:** Windows 10/11, a Claude subscription, and the project-local Node.js 24 in `tools/node`. The system Node may be too old; see [`CLAUDE.md`](CLAUDE.md).

```powershell
npm run build            # bundle into dist/
npm start                # run the app on the Build/ instance
npm test                 # typecheck, unit tests, end-to-end tests
npm run test:race        # the two 5-minute junction-swap races
npm run test:host-suite  # security suite + record for this build
npm run package          # portable build in Build/app/<build-id>/ + launcher Build/Dashboard.exe (--pending: try it on the next start)
npm run setup:shortcut   # once: Build/Dashboard.lnk
```

Before the generator runs a new Claude Code version, run the security harness on it (it needs administrator approval and your Claude sign-in):

```powershell
powershell -ExecutionPolicy Bypass -File .\spikes\spike1-cli.ps1 -Version <x.y.z>
```

## Repository layout

```
src/        main process (broker, card host, generator, validator), preloads, card runtime, UI
test/       unit, end-to-end and race tests
spec/       manifest schema, host API, report schema, CLI approval schema
docs/       design documents (the source of truth)
spikes/     security harness for Claude Code builds
scripts/    build, package, test and host-suite scripts
setup/      setup scripts (portable Podman install)
cards/      reference cards shipped with the app
Build/      the portable instance: app, data and the Claude exchange folder (state is never committed)
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/PROJECT.md`](docs/PROJECT.md) | Goals, constraints, checklist, decision log, status |
| [`docs/RULES.md`](docs/RULES.md) | Host invariants, generator rules, CLI rules |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The capability broker, process model, storage, pipeline |
| [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) | Permission types and how they are shown for approval |
| [`docs/VALIDATOR.md`](docs/VALIDATOR.md) | Validation stages |
| [`docs/PRESETS.md`](docs/PRESETS.md) | Card presets and the report format |
| [`docs/NEW-FEED-CARD.md`](docs/NEW-FEED-CARD.md) | Procedure for adding a feed card |
| [`docs/INFRASTRUCTURE.md`](docs/INFRASTRUCTURE.md) | Container infrastructure (Podman now, Kubernetes-ready) |
| [`docs/TESTPLAN.md`](docs/TESTPLAN.md) | Test plan |

## Credits

**Dima Buchka:** product owner, architect and QA. Defined the requirements, threat model and security rules, made the architecture decisions (several after external security reviews), specified the attack tests, and verified the system on real hardware.

The implementation was written with **Claude Code** (Anthropic), directed and verified as above.

**Stack:** Electron 44 · TypeScript · React · Node.js · Playwright · PowerShell · Claude Code CLI. Planned: Podman · NATS.
