# Implementation Plan: Fusion MCP Server

**Branch**: `004-fusion-mcp-server` | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-fusion-mcp-server/spec.md`

## Summary

OpenFusion is a local MCP server implementing OpenRouter's Fusion panel architecture. An MCP client calls a single `fusion` tool with a prompt (plus optional context); OpenFusion fans the prompt out to 2–5 configured candidate models in parallel (single-shot, no tools), collects survivors, then runs a two-step judge on the same provider/model — step 1 extracts a structured analysis (consensus / contradictions / partial coverage / unique insights / blind spots) via a forced tool call, step 2 synthesizes the final answer from candidates + analysis only. The consolidated answer is returned to the client. OpenFusion refuses to run until configured; a glass-morphic React dashboard on `127.0.0.1:9077` handles configuration (candidates, judge, per-provider API keys with live test pings) and usage statistics (activity-as-a-dimension). Provider management is delegated to `@earendil-works/pi-ai`; keys are encrypted at rest with AES-256-GCM; usage is persisted in SQLite. A shipped `SKILL.md` tells client agents when (and when not) to use Fusion.

## Technical Context

All design decisions were locked with the user before this plan (see `research.md`). No NEEDS CLARIFICATION markers remain.

**Language/Version**: TypeScript on Node.js (ES2022, NodeNext module resolution, ESM, `"type": "module"`). Runtime: Node 20 LTS+.

**Primary Dependencies**:
- `@modelcontextprotocol/sdk` v1.x stable (pinned — v2/main is pre-alpha; do not use). McpServer + StdioServerTransport + Zod.
- `@earendil-works/pi-ai` (pinned exact — pre-1.0). Provider abstraction, typed model registry, tool-calling, per-call `apiKey`, `registerFauxProvider()` for tests. **Not** the deprecated `@mariozechner/pi-ai`.
- `better-sqlite3` — synchronous SQLite (activities + sub_calls).
- `express` — local config/stats HTTP server.
- `zod` — `fusion` tool input schema (and shared config schema).
- `open` — cross-platform browser launch for first-run.
- `env-paths` — OS-conventional `~/.openfusion` paths.
- UI: React + Vite + Tailwind + recharts (separate `ui/` package).

**Storage**: SQLite (`~/.openfusion/openfusion.db`, WAL mode) for activity/stats. Encrypted JSON file (`~/.openfusion/secrets.enc`) for API keys. Plaintext JSON (`~/.openfusion/config.json`) for model choices/settings. Machine-bound `~/.openfusion/master.key` (chmod 600) for AES-256-GCM.

**Testing**: Vitest. Deterministic fusion tests via pi-ai `registerFauxProvider()`. Unit tests for crypto round-trip, config completeness, SQLite aggregations, MCP tool handler (mocked extra/progress).

**Target Platform**: Local developer machine (macOS, Linux, Windows). Single Node process launched as a stdio child process by the MCP client.

**Project Type**: CLI/library hybrid — an MCP server distributed as an `npx`-runnable package with two bin entries (`openfusion-mcp`, `openfusion-ui`) and a static-served React dashboard.

**Performance Goals**: Typical fusion wall-clock under common client tool-call windows (~4 min ceiling on Claude Desktop). Fan-out is parallel (wall-clock ≈ slowest candidate + 2 judge calls). Per-candidate timeout default 120s.

**Constraints**: Dashboard binds `127.0.0.1` only. `stdout` reserved for MCP JSON-RPC — all logs to `stderr`. Keys never logged / never returned unmasked. Min 2 / max 5 candidates. <2 survivors → error. Single-user, local-only.

**Scale/Scope**: Single-user local tool. Low volume (handfuls of fusions per session). Dashboard aggregates against SQLite, not in-memory logs.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) (7 principles). Evaluation:

| Principle | Status | Evidence in plan |
|-----------|--------|------------------|
| I. Fusion Engine, Not Agent (NON-NEGOTIABLE) | ✅ Pass | Workers are single-shot `complete()` calls with no tools; `context` is caller-supplied. No agent loop anywhere. |
| II. Two-Step Judging | ✅ Pass | Judge step 1 = analysis via forced `record_analysis` tool call; step 2 = synthesis; same provider/model for both. |
| III. Resilient by Default | ✅ Pass | `Promise.allSettled` fan-out, per-candidate timeout, ≥2-survivor threshold, progress notifications best-effort. |
| IV. Secrets Are Encrypted at Rest | ✅ Pass | AES-256-GCM `secrets.enc` + chmod-600 `master.key`; secrets endpoint returns masked presence; dashboard 127.0.0.1-only. |
| V. Observable | ✅ Pass | One `activities` row + N+2 `sub_calls` rows per fusion; SQLite aggregations drive the dashboard. |
| VI. Configuration Gated | ✅ Pass | `isConfigured()` gate (≥2 candidates + judge + all keys) refuses the `fusion` tool; first-run opens/returns the dashboard URL. |
| VII. Simple & Local | ✅ Pass | One Node process (stdio MCP + Express coexist); pnpm; TS ES2022 NodeNext; no bundler; Vitest + faux providers; YAGNI. |

**Gate result**: PASS — no violations. No Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/004-fusion-mcp-server/
├── plan.md              # This file
├── spec.md              # Feature specification (/speckit.specify output)
├── research.md          # Phase 0 output — locked decisions + pattern research
├── data-model.md        # Phase 1 output — config + SQLite schema + entities
├── quickstart.md        # Phase 1 output — end-to-end validation guide
├── contracts/           # Phase 1 output
│   ├── mcp-fusion-tool.md     # fusion tool input/output contract
│   ├── rest-api.md            # dashboard REST API contract
│   └── config-schema.md       # config.json + secrets.enc shapes
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks — not created by this command)
```

### Source Code (repository root)

```text
openfusion/
├── package.json            # type: module; bin: openfusion-mcp, openfusion-ui
├── tsconfig.json           # ES2022, NodeNext, strict
├── pnpm-workspace.yaml     # includes ui/
├── AGENTS.md               # coding guidelines + architecture pointer
├── ARCHITECTURE.md         # full architecture
├── README.md
├── src/
│   ├── index.ts            # shebang; bin entry — boots McpServer + UI server
│   ├── server/
│   │   ├── mcp-server.ts   # McpServer; fusion + open_dashboard tools; progress
│   │   ├── ui-server.ts    # Express on 127.0.0.1:9077; static + REST
│   │   └── api/
│   │       ├── config.ts       # GET/PUT /api/config
│   │       ├── secrets.ts      # GET (masked) / PUT /api/secrets
│   │       ├── providers.ts    # GET /api/providers, /api/providers/:p/models
│   │       ├── test.ts         # POST /api/test (pi-ai ping)
│   │       ├── stats.ts        # GET /api/stats (aggregated)
│   │       └── activity.ts     # GET /api/activity (paginated, expandable)
│   ├── fusion/
│   │   ├── fusion.ts       # orchestrate: gate → fan-out → judge → log → return
│   │   ├── worker.ts       # single-shot candidate via pi-ai complete()
│   │   ├── judge.ts        # 2-step: analysis tool-call + synthesis
│   │   └── prompts.ts      # WORKER / ANALYSIS / SYNTHESIS system prompts
│   ├── config/
│   │   ├── schema.ts       # zod: AppConfig, CandidateSlot, JudgeConfig, Settings
│   │   ├── store.ts        # load/save config.json; atomic write
│   │   ├── crypto.ts       # AES-256-GCM; master.key gen; mask()
│   │   ├── secrets.ts      # secrets.enc load/save via crypto.ts
│   │   └── completeness.ts # isConfigured(): ≥2 candidates + judge + keys
│   ├── providers/
│   │   └── pi-ai-bridge.ts # getModel(); complete(model, ctx, {apiKey}); test ping
│   ├── store/
│   │   ├── db.ts           # better-sqlite3; WAL; migrations
│   │   ├── activity.ts     # recordActivity() + recordSubCall()
│   │   └── stats.ts        # KPI + by-model + by-day aggregation queries
│   └── util/
│       ├── paths.ts        # env-paths wrapper (~/.openfusion)
│       └── timeout.ts      # withTimeout(promise, ms)
├── ui/                     # React (Vite) — own package.json
│   ├── index.html
│   ├── package.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts          # fetch wrappers for /api/*
│       ├── pages/
│       │   ├── Setup.tsx
│       │   ├── Candidates.tsx
│       │   ├── Judge.tsx
│       │   ├── ApiKeys.tsx
│       │   └── Dashboard.tsx
│       └── components/      # glass-morphic cards, charts, activity table
├── ui-dist/                # built UI (gitignored), served by Express
├── skill/
│   └── SKILL.md            # OpenFusion usage skill for client agents
└── tests/
    ├── fusion.test.ts      # faux-provider end-to-end fusion flow
    ├── judge.test.ts       # 2-step analysis + synthesis
    ├── worker.test.ts      # single-shot + timeout
    ├── completeness.test.ts
    ├── crypto.test.ts
    ├── activity.test.ts    # SQLite logging + aggregations
    └── mcp-server.test.ts  # tool handler, progress, config gate
```

**Structure Decision**: Single-package project with a nested `ui/` workspace (Vite React app built to `ui-dist/` and served by the Express server). No monorepo tooling beyond a pnpm workspace file — keeps it simple per Constitution VII. The server is one ESM TypeScript tree compiled by `tsc` to `dist/`; the UI is the only sub-package.

## Complexity Tracking

> Not applicable — Constitution Check passed with no violations.
