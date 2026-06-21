# Implementation Plan: Async Fusion Results via Deferred Retrieval

**Branch**: `008-async-fusion-results` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-async-fusion-results/spec.md`

## Summary

Add a **client-driven deferred-result protocol** so long fusions stop timing out in clients that don't support MCP Tasks (codex, ZCode) — the gap feature 005 provably cannot close (codex hardcodes `task: None`, handles only `CallToolResult`, and exposes no `tasks/get`/`tasks/result`). Three changes, layered on 005's existing detached runner:

1. **`_resume_from` retrieval on the `fusion` tool** — when a non-Tasks client calls `fusion` and the work would exceed the client's per-call ceiling, the kickoff returns **immediately** with `{ status: "processing", reference_id, instruction }`; the work runs detached (same `startDetachedFusion` runner 005 built). The agent retrieves via `fusion({ _resume_from: "<id>" })`, which **bounded-long-polls** (~40 s, parallel mode) and returns either the synthesized answer or another `processing` result. One kickoff + ~1–3 retrievals for a 90 s parallel fusion — no timeout.

2. **Mode-aware shapes** — parallel uses tight bounded long-polling with terse **transparent-pacing** wording (retrieval mandate + `retry_after_ms` in prose and `_meta`; NO "do not inform the user" directive — that risks tripping safety-training refusals); sequential (spec 007) uses ETA-guided fire-and-forget + user-facing "this is long, here's the dashboard" wording. Both carry `retry_after_ms` so the agent doesn't tight-loop. One cadence breaks both ways; the constants force the split.

3. **Durable (SQLite) storage for both modes** — revises 005's non-durability stance for the retrieval use case. A 21-minute serial job has a high probability of overlapping a restart; in-memory storage (005's choice) orphans the ticket and wastes provider compute. The reference id **is** the activity id (collapse the three-way map 005 needed); job-state + result persist from kickoff; live candidate-progress stays ephemeral for both modes (on restart it describes nothing).

The 005 Tasks path is **preserved unchanged** for Tasks-aware clients (they keep getting `CreateTaskResult` + `tasks/result`). Tasks and `_resume_from` are two egress branches over one detached runner + one durable result store. Fusion semantics are identical across paths.

Full rationale: [`research.md`](./research.md) (R-001..R-009 — the empirical client-timeout gate, storage decision, identity collapse, retrieval-shape design, durability, and the failure modes). Entities in [`data-model.md`](./data-model.md); the `fusion` tool's `_resume_from` wire contract in [`contracts/resume-from.md`](./contracts/resume-from.md); validation in [`quickstart.md`](./quickstart.md).

**One empirical gate before retrieval timing is locked** (R-001): verify in codex source that the ~60 s timeout is per-`tools/call` and resets between calls, not a session/turn-level wall-clock across all tool calls. If false, FR-004's ~40 s bounded long-poll premise shifts.

## Technical Context

**Language/Version**: TypeScript (ES2022, NodeNext, ESM), Node ≥ 22.19.

**Primary Dependencies**:
- `@modelcontextprotocol/sdk@1.29.0` (exact pin — unchanged; no new MCP capability used. `_resume_from` is a plain tool argument, not a protocol primitive).
- `@earendil-works/pi-ai@0.79.4` (exact pin — unchanged).
- `better-sqlite3@12.10.1` (WAL mode — **one additive migration**: a `fusion_jobs` table for durable job-state + result).

**Storage**:
- **SQLite migration (additive, non-breaking)**: new `fusion_jobs` table keyed by the activity id (FK → `activities.id`), holding status (`processing` | `completed` | `interrupted` | `expired` | `error`), the synthesized result on completion, execution mode, timestamps (`created_at`, `completed_at`, `expires_at`), and error detail. One row per deferred fusion. Live candidate-progress is **not** stored here (ephemeral; spec FR-010).
- **No config migration**: this feature adds no user-facing setting. The retrieval shape is chosen at runtime from the in-progress fusion's execution mode (read from the config snapshot the detached runner already captures).

**Testing**: Vitest; pi-ai `registerFauxProvider()` for deterministic fusion tests. New tests T1–T14 in [`quickstart.md`](./quickstart.md) cover parallel retrieval, sequential retrieval, durability/restart, TTL/eviction, and the Tasks-path coexistence invariant. Existing suite (006/007-era) must stay green. The never-run end-to-end test from spec 005 (E1) is re-scoped and runs here against a real non-Tasks client (synthetic harness that sends no `params.task`).

**Target Platform**: Local Node process (stdio MCP + Express UI on `127.0.0.1:9077`). Same single-process architecture (Constitution VII).

**Project Type**: Local MCP server + REST dashboard.

**Performance Goals**:
- Kickoff returns ≈1s (allocate row + dispatch detached runner; no provider work in the call path).
- Retrieval bounded-long-poll returns within the configured wait (~40 s parallel) or immediately if already complete.
- SQLite write per kickoff + one on completion — negligible vs the N+2 `sub_calls` rows a fusion already writes.

**Constraints**:
- No new MCP capability/protocol primitive (constitution VII — `_resume_from` is a tool argument, keeps the server on the stable SDK path).
- No `AbortController` (unchanged from 005/007 — out of scope). A stalled-job circuit (FR-012) bounds the retrieval loop without aborting the detached work.
- Result payload is the synthesized answer text only (strictly less sensitive than the prompts + per-candidate responses already in `sub_calls`). No new secret handling.
- Live progress is never persisted (on restart it would be stale — spec FR-010).

**Scale/Scope**: Single process; one new SQLite table; one new tool argument + retrieval branch; the `_resume_from` registry is a thin read layer over the durable table + an in-memory progress map shared with spec 007's status surface.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | Fusion Engine, Not Agent (NON-NEGOTIABLE) | ✅ PASS | `_resume_from` is a **retrieval** mechanism, not agency. The server still does single-shot candidate generation + two-step judge — it does not loop, call tools, or act autonomously. The LLM-mediated polling happens **in the client's agent**, not in OpenFusion; OpenFusion only stores a result and hands it back when asked. The "instruction" text in the kickoff result is a hint to the *client's* agent, not a behavior OpenFusion performs. |
| II | Two-Step Judging | ✅ PASS | The judge steps are untouched. Retrieval returns whatever `runFusion` already synthesizes; no new judging path. |
| III | Resilient by Default | ✅ PASS | Fan-out, the ≥2-survivor gate, and the per-worker timeout/retry are unchanged. The deferred runner is 005's existing `startDetachedFusion`. The stalled-job circuit (FR-012) is an *additional* safety bound on the retrieval loop, not a change to fusion resilience. |
| IV | Secrets Encrypted at Rest | ✅ PASS | No secrets touched. The result payload is synthesized answer text (less sensitive than prompts already stored in `sub_calls.generated_text`). Dashboard stays `127.0.0.1`. |
| V | Observable | ✅ PASS | The `activities` + N+2 `sub_calls` invariant is unchanged. The new `fusion_jobs` table is **additional** durable state for retrieval, not a replacement for the activity log; it references the activity id. Retrieval outcomes (`processing`/`completed`/`interrupted`/`expired`) are themselves observable. A never-retrieved counter (panel blind-spot) is logged. |
| VI | Configuration Gated | ✅ PASS | The config gate still runs first inside `runFusion` (both kickoff and the legacy blocking path). A `_resume_from` call for an unknown id returns `not_found` without running the gate. |
| VII | Simple & Local | ✅ PASS | One Node process; one additive SQLite table; one new tool argument; no new deps, no new MCP capability, no worker threads. The `_resume_from` branch is a read over a table + an in-memory map. Choosing durable-for-both (vs the panel's hybrid) is the *simpler* total system — one storage path, one TTL story, one identity. |

**Gate result**: PASS. No NON-NEGOTIABLE principle is touched (I is respected: this is retrieval, not agency). No Complexity Tracking entries. The one design decision that adds machinery (SQLite durability vs 005's in-memory) is justified by the failure mode it prevents (orphan tickets on restart for long jobs) and is simpler-in-total than the hybrid alternative — see R-004.

**Post-design re-check**: After data-model + contracts, still PASS. The single retrieval site (INV-1), the identity collapse (INV-2 — `reference_id = activity_id`), and the durable-from-kickoff invariant (INV-3) jointly guarantee no resilience or observability regression. The 005 Tasks path is untouched (INV-4 — `_resume_from` is a sibling branch, not a modification).

## Project Structure

### Documentation (this feature)

```text
specs/008-async-fusion-results/
├── plan.md                  # This file
├── research.md              # Phase 0 — R-001..R-009 (client-timeout gate, storage, identity, shapes, durability, failure modes)
├── data-model.md            # Phase 1 — FusionJob record, status state machine, identity invariants
├── quickstart.md            # Phase 1 — T1–T14 + E1 (real non-Tasks client) validation guide
├── contracts/
│   └── resume-from.md       # fusion tool _resume_from wire contract + kickoff/retrieval result shapes
└── tasks.md                 # Phase 2 (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── index.ts                    # MODIFIED: call resume-store.sweepInterrupted() once at boot after openDatabase (the startup sweep — makes post-restart in-flight fusions return 'interrupted' instead of hanging a retrieval)
├── fusion/
│   ├── task-runner.ts          # MODIFIED: startDetachedFusion writes FusionJob durable row at kickoff + terminal; drains on completion. Reference id = activity id (no taskId map for _resume_from path)
│   ├── resume-store.ts         # NEW: durable FusionJob store (get/upsert/markTerminal/markRetrieved/expire/sweepInterrupted/sweepExpired) over the fusion_jobs table; bounded-long-poll waiter that resolves on terminal or timeout
│   ├── resume-shapes.ts        # NEW: mode-aware kickoff + retrieval result builders (parallel: tight-poll + transparent-pacing wording + retry_after_ms; sequential: ETA-guided + dashboard link + retry_after_ms). Returns {content, _meta}. Pure functions over FusionJob + config snapshot
│   └── fusion.ts               # MODIFIED: FusionResult gains additive optional errorKind ('no-survivors'|'judge-failed'|'internal') set at each failure site (FR-014). Additive only — no caller breaks
├── server/
│   └── mcp-server.ts           # MODIFIED: fusion tool gains optional _resume_from arg + retrieval branch; kickoff returns processing result for non-Tasks clients instead of blocking. Tasks path (createTask handler) UNCHANGED
├── store/
│   ├── db.ts                   # MODIFIED: additive migration creating fusion_jobs table (FK → activities.id)
│   └── (activity.ts)           # UNCHANGED — allocateActivity/getActivity already give us the identity + row
└── config/
    └── (schema.ts, store.ts)   # UNCHANGED — no new setting

tests/
├── resume-parallel.test.ts     # NEW: T1–T5 (kickoff immediate, bounded long-poll, completed fast-path, mode-aware wording, Tasks-path coexistence)
├── resume-sequential.test.ts   # NEW: T6–T8 (ETA in kickoff, ETA-guided cadence, dashboard link) — gated on spec 007's serial budget helper
├── resume-durability.test.ts   # NEW: T9–T11 (row exists at kickoff, post-restart retrieval of completed result, post-restart interrupted outcome, no stale live progress)
└── resume-edge-cases.test.ts   # NEW: T12–T14 (unknown/expired id, TTL-vs-late-completion guard, stalled-job circuit, judge-failure distinction)
```

**Structure Decision**: Single-project layout (existing). Three new source files, all in `src/fusion/` (the deferred-result concern lives with the runner): `resume-store.ts` (the durable store + bounded-long-poll waiter), `resume-shapes.ts` (pure mode-aware result builders — extracted so they're trivially unit-testable and so the sequential shape can reuse spec 007's `computeSerialBudgetMs` without coupling), and the storage migration in `db.ts`. `task-runner.ts` and `mcp-server.ts` are surgical modifications. The 005 Tasks path (`createTask`/`getTask`/`getTaskResult`) is deliberately untouched — `_resume_from` is a sibling branch that shares the runner and the new durable store. No new runtime dependencies, no config migration, no new MCP capability. The reference id is the activity id (no new id space).

## Complexity Tracking

> None. Constitution Check passes with no NON-NEGOTIABLE violations and no amendments. The one machinery addition (durable SQLite storage where 005 used in-memory) is justified in R-004 and is simpler-in-total than the hybrid alternative (one storage path vs two). Every changed line traces to a spec FR: kickoff-immediate (FR-001), `_resume_from` retrieval (FR-002/003), bounded long-poll (FR-004), mode-aware shapes (FR-005), identity collapse (FR-006), durability (FR-007), TTL (FR-008), restart recovery (FR-009), ephemeral progress (FR-010), eviction guard (FR-011), stalled circuit (FR-012), Tasks coexistence (FR-013), judge-failure distinction (FR-014), unchanged semantics (FR-015).
