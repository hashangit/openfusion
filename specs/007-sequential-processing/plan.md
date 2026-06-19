# Implementation Plan: Sequential Processing Option (Low-VRAM Local Models)

**Branch**: `007-sequential-processing` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-sequential-processing/spec.md`

## Summary

Add a user-controlled **execution mode** so OpenFusion can run candidate fan-out **one model at a time** instead of in parallel — for users on low-VRAM machines running local models (Ollama/llama.cpp) where simultaneous fan-out OOMs. Three changes:

1. **Execution mode toggle** — a `settings.executionMode` value (`parallel` | `sequential`, default `parallel`), exposed as a Candidates-page toggle mirroring the existing **Benchmark Mode** toggle (same plumbing: settings boolean-shaped value → UI switch → behavior change in the fusion engine). Parallel mode is byte-for-byte today's behavior (FR-002).

2. **Serial-aware time budget** — sequential mode computes a total wall-clock budget from the enabled-candidate count and documented per-step latency assumptions (`serialBudgetMs = PER_CANDIDATE_MS × N + JUDGE_STEPS_MS`), instead of reusing the parallel per-worker timeout as the total budget (which would abort early) or running unbounded. The per-worker timeout + 3-retry machinery is **unchanged** per candidate; the serial budget is an outer gate that stops *launching* further candidates when exhausted, then proceeds with whatever survivors it has (≥2 → judge, else the standard error). The budget is surfaced as helper text near the toggle.

3. **Live server-status surface (Dashboard)** — a persistent widget on the Dashboard showing the fusion engine's current state: **idle** / **in-progress** (candidate progress affordance that adapts to mode — "3 of 5 responding" parallel vs "candidate 3 of 5 running" serial) / **queued** (when >1 fusion is active or waiting). Derived from in-process state already shared by both entry paths (the blocking MCP tool + the detached task path's `activeTasks` set); ephemeral, not persisted. This is what makes a 10–15 minute serial run legible instead of looking hung.

The fan-out change is localized: `fusion.ts:182`'s bare `Promise.all` becomes a small dispatcher that picks parallel (`Promise.all`, unchanged) or sequential (a `for…of` loop that `await`s each `runWorker`, checks the budget before each launch, and reports per-candidate progress). Both entry paths (blocking tool + detached task) read `settings` at fusion time and pass `onProgress` through, so the setting + serial progress reach both with no per-path wiring. Full rationale in [`research.md`](./research.md); entities in [`data-model.md`](./data-model.md); the status-surface API contract in [`contracts/dashboard-status.md`](./contracts/dashboard-status.md); validation in [`quickstart.md`](./quickstart.md).

**Endpoint note**: the live-fusion status surface is served at **`GET /api/runtime`**, NOT `/api/status`. The latter already exists (`src/server/api/status.ts`) and returns version/configured-state/health — it is consumed by the dashboard, the agent skill, and CLI health checks, and must not be touched. `/api/runtime` is a distinct, additive route for the ephemeral fusion-engine state only.

## Technical Context

**Language/Version**: TypeScript (ES2022, NodeNext, ESM), Node ≥ 22.19.

**Primary Dependencies**:
- `@modelcontextprotocol/sdk@1.29.0` (exact pin — unchanged; no new MCP capability used).
- `@earendil-works/pi-ai@0.79.4` (exact pin — unchanged).
- `better-sqlite3@12.10.1` (WAL mode — **no migration**: sequential mode adds no persisted column; the status surface is in-memory only).

**Storage**:
- `config.json` v4→v5 migration: inject `settings.executionMode = "parallel"` if absent. Additive, non-breaking.
- **No SQLite migration.** Sequential mode is recorded implicitly (no new column) — the activity row already has candidate count / survivor count / per-candidate latencies, which is enough to infer serial-vs-parallel post-hoc if ever needed. The status surface is runtime state, not persisted (lost on restart is fine — it describes the present moment).

**Testing**: Vitest; pi-ai `registerFauxProvider()` for deterministic fusion tests. New tests T1–T12 in [`quickstart.md`](./quickstart.md). Existing suite (006-era) must stay green.

**Target Platform**: Local Node process (stdio MCP + Express UI on `127.0.0.1:9077`). Same single-process architecture (constitution VII).

**Project Type**: Local MCP server + REST dashboard.

**Performance Goals**:
- Parallel mode zero-overhead vs today (the dispatch branch is a single boolean check before the existing `Promise.all`).
- Sequential mode: only one candidate in-flight at a time by construction (no concurrency primitive — just `await` in a loop).
- Status-surface endpoint sub-millisecond (in-memory read + JSON serialize), polled at a coarse interval (≥2s) by the dashboard.

**Constraints**:
- `executionMode` stored in plaintext `config.json` (not sensitive; constitution IV unaffected).
- No `AbortController` introduced (out of scope — see AGENTS.md known limitations). Budget exhaustion = "stop launching the next candidate", not "abort the current one". A candidate already in flight runs to its per-worker timeout.
- Serial mode does not manage the local model server's VRAM (Ollama keep-alive, llama.cpp offloading). It removes OpenFusion's *own* concurrency only.
- Status surface never exposes per-candidate content (results live in the activity log once a fusion completes).

**Scale/Scope**: Single process; the status surface reads one in-memory registry + the existing `activeTasks` set. No new concurrency primitives, no queue data structure (concurrent fusions already happen via the event loop; the surface *observes* them, it does not *serialize* them — see R-005).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|---|---|---|
| I | Fusion Engine, Not Agent (NON-NEGOTIABLE) | ✅ PASS | Sequential fan-out is a scheduling change, not agentic behavior. Workers still generate once from the prompt; no tools, no loops added to *what* a worker does. The serial `for…of` just changes *when* candidates run, not *whether* they act autonomously. |
| II | Two-Step Judging | ✅ PASS | The judge steps are untouched — analysis then synthesis on the same provider/model, from candidates + analysis only. Sequential mode only affects candidate fan-out, which happens entirely before judging begins. |
| III | Resilient by Default | ✅ PASS (with one wording update) | The constitution says "parallel via `Promise.allSettled`". Sequential mode is an *opt-in alternative* to the default; the default (parallel) is unchanged (FR-002). The survivor gate (≥2) and per-worker timeout/retry are identical in both modes. The serial budget is an *additional* outer constraint that, when exhausted, proceeds with survivors so far — consistent with the "proceed with survivors" spirit. **Action**: update Constitution III's wording to acknowledge sequential as a user-opted alternative to the parallel default. Per speckit-analyze C1, this amendment is a **Foundational task (T003), executed before any implementation** — the governing principle is updated first, not as polish. |
| IV | Secrets Encrypted at Rest | ✅ PASS | `executionMode` is non-sensitive → plaintext `config.json` (alongside `benchmarkMode`, `activePersona`). No secrets touched. Status surface exposes no prompts, no keys, no candidate content — only counts and indices. Dashboard still `127.0.0.1`. |
| V | Observable | ✅ PASS | Activity + N+2 sub_calls invariant **unchanged** (FR-011) — a sequential fusion produces the same row structure as a parallel one; each candidate is recorded individually with its own latency. The status surface is *additional* ephemeral observability for the present moment; the durable record remains the activity log. |
| VI | Configuration Gated | ✅ PASS | The config gate still runs first and is mode-agnostic. Execution mode doesn't change the ≥2-candidate / ≥1-judge / keys requirements. |
| VII | Simple & Local | ✅ PASS | One Node process; one additive config migration (no DB migration); one in-memory status registry; no queue, no worker threads, no new deps. The fan-out change is a 1-branch dispatch. The serial budget is a constant + multiply, not a live-measurement system. |

**Gate result**: PASS. One NON-NEGOTIABLE principle (I) is touched but not violated — sequential is a scheduling choice, not agency. Principle III needs a wording amendment to acknowledge sequential as an opt-in alternative (the default parallel behavior is preserved exactly). No Complexity Tracking entries.

**Post-design re-check**: After data-model + contracts, still PASS. The single fan-out dispatch site in `runFusion` (INV-1 — both entry paths share it), the in-memory-only status registry (INV-3 — never persisted, never blocks), and the unchanged survivor gate (INV-2) jointly guarantee no resilience regression. Constitution III amendment: add a sentence noting sequential mode as a user-opted alternative for low-VRAM local setups, with the survivor gate and per-worker timeout identical to parallel. **Governance ordering (speckit-analyze C1)**: the amendment is task **T003 in Phase 2 Foundational**, executed *before* any sequential implementation lands — the principle is authorized first, code follows. No behavior regression; this is documentation authorizing an explicitly-user-requested option.

## Project Structure

### Documentation (this feature)

```text
specs/007-sequential-processing/
├── plan.md                          # This file
├── research.md                      # Phase 0 — R-001..R-007 (budget semantics, status flow, queue model, budget×retry)
├── data-model.md                    # Phase 1 — ExecutionMode, SerialBudget, FusionRuntimeStatus
├── quickstart.md                    # Phase 1 — T1–T12 + E1–E2 validation guide
├── contracts/
│   └── dashboard-status.md          # GET /api/runtime contract + config schema delta + UI affordance shapes
└── tasks.md                         # Phase 2 (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── fusion/
│   ├── fusion.ts                    # MODIFIED: fan-out dispatch (parallel | serial); serial budget gate; per-candidate progress in serial mode; status registry enter/exit
│   ├── fanout.ts                    # NEW: runParallelFanout() (extracted current behavior) + runSequentialFanout() (for…of + budget check + per-candidate report); computeSerialBudgetMs()
│   └── status.ts                    # NEW: in-memory FusionStatusRegistry (enter/leave/update/getSnapshot) — the live state the dashboard reads
├── server/
│   ├── mcp-server.ts                # UNCHANGED (both entry paths already route through runFusion; settings read at fusion time)
│   ├── ui-server.ts                 # MODIFIED (minimal): mount GET /api/runtime (distinct from existing /api/status)
│   └── api/runtime.ts               # NEW: GET /api/runtime → FusionStatusRegistry snapshot
├── config/
│   ├── schema.ts                    # MODIFIED: ExecutionModeSchema enum + add executionMode to SettingsSchema
│   └── store.ts                     # MODIFIED: v4→v5 migration inject executionMode:"parallel" if absent
└── store/
    └── (db.ts, activity.ts)         # UNCHANGED — no migration, no new columns

ui/
└── src/
    ├── api.ts                       # MODIFIED: ExecutionMode on settings; getStatus() client
    ├── pages/Candidates.tsx         # MODIFIED: Sequential Mode toggle (mirrors Benchmark) + dynamic budget helper text
    └── pages/Dashboard.tsx          # MODIFIED: ServerStatus widget (idle/in-progress/queued, mode-aware affordance, coarse polling)

tests/
├── fanout-sequential.test.ts        # NEW: T1–T4 (serial ordering, budget gate, budget×retry, parallel unchanged)
├── serial-budget.test.ts            # NEW: T5–T6 (budget formula, helper-text value)
└── status-surface.test.ts           # NEW: T7–T12 (idle, parallel affordance, serial affordance, queue, focus-refresh, enter/leave)

docs/  (CONSTITUTION amendment)
└── .specify/memory/constitution.md  # MODIFIED: Principle III wording — sequential as opt-in alternative (documented amendment, no behavior change)
```

**Structure Decision**: Single-project layout (existing). Two new source files: `fanout.ts` (the parallel/sequential dispatch + budget math, extracted from `fusion.ts` to keep the orchestrator readable) and `status.ts` (the in-memory registry the dashboard reads). `fusion.ts` becomes a thin caller of the dispatch and the registry's enter/leave bookkeeping. Everything else is surgical modification. No new runtime dependencies, no DB migration, no new MCP capability. The constitution amendment is a wording update to Principle III (sequential acknowledged as opt-in; parallel default preserved).

## Complexity Tracking

> None. Constitution Check passes with one documentation amendment (Principle III wording), no NON-NEGOTIABLE violations. The feature is the minimal, directly-user-requested answer: one config enum, one fan-out dispatch branch, one budget formula, one in-memory status registry. Each piece traces to a decision from the dialogue (boolean-vs-enum → enum for the single future-proofing win that's free; budget formula from the user's own "3min × N + 6min").
