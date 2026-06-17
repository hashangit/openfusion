# OpenFusion Constitution

The foundational principles governing OpenFusion's design and implementation. Derived from `AGENTS.md` and `ARCHITECTURE.md`. All features, plans, and changes must comply with these principles.

## Core Principles

### I. Fusion Engine, Not Agent (NON-NEGOTIABLE)

OpenFusion orchestrates single-shot candidate generations and a two-step judge — nothing more. There are **no tool loops, no agentic behavior, no autonomous research** inside the server. Workers generate once from the prompt (and any caller-supplied `context`); they never call tools. If a feature would make OpenFusion act as an agent, it belongs elsewhere.

### II. Two-Step Judging

The judge always runs in two steps on the **same** provider/model:
1. **Analysis** — extract structured analysis only (consensus, contradictions, partial coverage, unique insights, blind spots). It must *not* answer the prompt.
2. **Synthesis** — write the final answer using *only* the candidates + analysis, introducing no new external information.

This split exists because OpenRouter's data shows ~3/4 of the performance lift comes from synthesis, not model diversity. Do not collapse the two steps into one.

### III. Resilient by Default

Fan-out is parallel via `Promise.allSettled` with a per-call timeout (default 5 min) that resets on each of up to 3 retry attempts; the call proceeds with survivors and errors only when fewer than **2** candidates succeed. The slowest worker must not sink the call. Total wall-clock should stay under typical client tool-call ceilings (~4 min on some clients); users on those clients can lower `settings.workerTimeoutMs`. Progress is reported at each stage via `notifications/progress` (best-effort; correctness never depends on it).

### IV. Secrets Are Encrypted at Rest

Provider API keys live **only** in `secrets.enc`, encrypted with AES-256-GCM using a machine-bound `master.key` (`chmod 600`). Keys are **never logged, never returned unmasked** from any API (the secrets endpoint returns masked presence only). The dashboard and UI server bind to `127.0.0.1` only — never `0.0.0.0`.

### V. Observable

Every fusion writes **one `activities` row plus N+2 `sub_calls` rows** (one per candidate + the two judge steps), each recording provider, model, input/output tokens, cost, latency, and status. This is the source of truth for the dashboard's "activity as a dimension." No silent operations — if a worker or judge fails, it is recorded, not swallowed.

### VI. Configuration Gated

The `fusion` tool refuses to run until the system is configured: **≥2 candidates, a judge, and a key for every referenced provider**. On an unconfigured call, return a clear error pointing to `http://localhost:9077` (and open the browser when a display is present). Minimum **2**, maximum **5** candidates.

### VII. Simple & Local

One Node process: stdio MCP transport + Express UI server coexisting; stdio only owns stdin/stdout, the HTTP port is free. **pnpm** (not npm); **TypeScript** → ES2022 NodeNext; no bundler (`tsc` → `dist/`); **Vitest** for tests (pi-ai `registerFauxProvider()` for deterministic fusion tests). `stdout` is the MCP JSON-RPC channel — all logging goes to **stderr**. Start simple, YAGNI.

## Technology Stack

- **Runtime:** Node.js, TypeScript (ES2022, NodeNext), ESM, no bundler.
- **Package manager:** pnpm.
- **Provider layer:** `@earendil-works/pi-ai` (pinned exact — pre-1.0; the deprecated `@mariozechner/pi-ai` must not be used).
- **MCP:** `@modelcontextprotocol/sdk` v1.x stable (v2/main is pre-alpha — do not use).
- **Persistence:** `better-sqlite3` (WAL mode).
- **UI:** React + Vite + Tailwind + recharts.
- **Tests:** Vitest.

## Development Workflow

- **Speckit-gated:** features flow through `speckit-specify` → `speckit-plan` → `speckit-tasks` → `speckit-implement`; plans and tasks are checked against this constitution.
- **Think before coding:** state assumptions, surface tradeoffs, ask when unclear (AGENTS.md §1).
- **Surgical changes:** touch only what a task requires; match existing style (AGENTS.md §3).
- **Goal-driven:** tasks carry verifiable success criteria (AGENTS.md §4).

## Governance

This constitution supersedes all other practices for OpenFusion. Any change violating a NON-NEGOTIABLE principle (I) requires an explicit, documented justification. Amendments require a documented rationale and migration plan. Complexity beyond these principles must be justified; when in doubt, refer to `AGENTS.md` and `ARCHITECTURE.md`.

**Version**: 1.0.0 | **Ratified**: 2026-06-15 | **Last Amended**: 2026-06-15
