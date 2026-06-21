# Implementation Plan: MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Branch**: `005-mcp-tasks-sep` | **Date**: 2026-06-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-mcp-tasks-sep/spec.md`

## Summary

Eliminate client-side tool-call timeouts for long fusions by re-registering the existing `fusion` tool as **task-capable** via MCP Tasks (SEP-1686, spec `2025-11-25`, Final). A Tasks-aware client (verified: the ZCode/codex harness) gets a `CreateTaskResult` synchronously and fetches the result later via `tasks/get` + `tasks/result`; non-Tasks clients fall back transparently to today's blocking `CallToolResult`. The fusion engine itself — fan-out, two-step judge, persona resolution, config gate, observability — is **unchanged**. The only behavioral change is *when* `tools/call` returns.

Both ends already support the protocol: `@modelcontextprotocol/sdk@1.29.0` (OpenFusion's exact-pinned SDK) ships `experimental/tasks/` with `server.experimental.tasks.registerToolTask`; the codex client binary contains `tasks/get|result|list|cancel`, `CreateTaskResult`, and `taskSupport`. No SDK upgrade, no client change, no infra. One new file (`src/fusion/task-runner.ts`) plus a refactor of the activity-row allocation inside `runFusion`. Full design rationale in [`research.md`](./research.md).

## Technical Context

**Language/Version**: TypeScript (ES2022, NodeNext, ESM), Node ≥ 22.19.

**Primary Dependencies**:
- `@modelcontextprotocol/sdk@1.29.0` (exact pin — Tasks under `experimental/` namespace; `@experimental` label accepted because the pin freezes the API).
- `@earendil-works/pi-ai@0.79.4` (exact pin — provider layer; no mid-stream cancel API).
- `better-sqlite3@12.10.1` (WAL mode).

**Storage**: SQLite (`activities`, `sub_calls`) — **schema unchanged**; the free-text `status` column gains `running` (and optionally `cancelled`) values. Plus an in-memory `InMemoryTaskStore` + a module-level `Map<taskId, activityId>` (non-durable; accepted per spec Edge Cases).

**Testing**: Vitest; pi-ai `registerFauxProvider()` for deterministic fusion tests. New tests T1–T7 in [`quickstart.md`](./quickstart.md). Existing 57 tests must stay green.

**Target Platform**: Local Node process (stdio MCP + Express UI on `127.0.0.1:9077`). Same single-process architecture (constitution VII).

**Project Type**: Local MCP server + REST dashboard.

**Performance Goals**:
- Synchronous `CreateTaskResult` return: **< ~2s** (task-creation overhead only; SC-002).
- No client-side timeout for a ~90s fusion on a Tasks-aware client (SC-001).
- Detached runner adds negligible overhead vs blocking path (same fan-out + judge).

**Constraints**:
- Bounded task lifetime: a task reaches a terminal state within `workerTimeoutMs × retries + judge` time — never an infinite hang (FR-009).
- Non-durable: process restart loses in-flight tasks (accepted; SQLite `activities` row is the durable record).
- No secrets logged; secrets stay in `secrets.enc` (constitution IV).

**Scale/Scope**: Single process; in-flight tasks bounded (0–5 typical). No concurrency primitives beyond what `Promise.allSettled` already provides.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|---|---|---|
| I | Fusion Engine, Not Agent (NON-NEGOTIABLE) | ✅ PASS | Tasks change only *when* the tool returns — fan-out + two-step judge are untouched. No tool loops, no agentic behavior added. The detached runner is still a single-shot generation pipeline. |
| II | Two-Step Judging | ✅ PASS | Judge still runs analysis→synthesis on the same model. Tasks wraps the pipeline; it does not collapse or reorder steps. |
| III | Resilient by Default | ✅ PASS | Same `Promise.allSettled`, per-worker timeout, ≥2 survivors, progress milestones. `tasks/get` surfaces the existing milestones best-effort. |
| IV | Secrets Encrypted at Rest | ✅ PASS | No change to key handling; task result never includes secrets; dashboard still `127.0.0.1`. |
| V | Observable | ✅ PASS | One `activities` row + N+2 `sub_calls` per fusion — **unchanged** (FR-007, INV-1). New `running` status value adds in-flight visibility. |
| VI | Configuration Gated | ✅ PASS | Config gate still runs; on failure the task transitions to `failed` fast and returns the same needs-config error (T4). |
| VII | Simple & Local | ✅ PASS | One Node process; detached promise on the event loop; `InMemoryTaskStore`; no worker threads/queues/Temporal. New code is one file + a refactor. |

**Gate result**: PASS — no NON-NEGOTIABLE violations, no Complexity Tracking entries needed. The design adds the minimum necessary to make `tools/call` non-blocking, and defers durability (documented limitation).

**Post-design re-check**: After data-model + contracts, still PASS. The `CallToolResult` parity (INV-4) and single-activity-row invariant (INV-1) guarantee no observability regression. No constitution amendment required.

## Project Structure

### Documentation (this feature)

```text
specs/005-mcp-tasks-sep/
├── plan.md              # This file
├── research.md          # Phase 0 — SDK API, correlation, status values
├── data-model.md        # Phase 1 — Task entity, taskId↔activityId, status lifecycle
├── quickstart.md        # Phase 1 — T1–T7 + E1–E2 validation guide
├── contracts/
│   └── mcp-fusion-tool-tasks.md   # Task-augmented tool contract (extends 004's)
└── tasks.md             # Phase 2 (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── fusion/
│   ├── fusion.ts          # MODIFIED: hoist activity allocation (allocateActivity); keep runFusion core intact
│   ├── worker.ts          # unchanged
│   ├── judge.ts           # unchanged
│   └── task-runner.ts     # NEW: Map<taskId,activityId> + startDetachedFusion(); bridges runFusion ↔ TaskStore
├── server/
│   ├── mcp-server.ts      # MODIFIED: registerToolTask('fusion', taskSupport:'optional') replacing plain server.tool; keep open_dashboard tool
│   └── ui-server.ts       # unchanged (REST/dashboard need no changes)
├── store/
│   ├── activity.ts        # MODIFIED: add allocateActivity(status='running') + updateActivityTerminal(...); keep existing loggers
│   ├── db.ts              # unchanged (no migration — status is free-text)
│   └── stats.ts           # unchanged
├── config/                # unchanged
└── providers/             # unchanged

tests/
├── fusion-tasks.test.ts   # NEW: T1–T7 (create/get/result/fallback/failure/progress/idempotency) with faux providers
└── mcp-server.test.ts     # MODIFIED (minimal): ensure blocking fallback still passes; possibly extend with a task smoke test

# Out of code scope (doc only):
.zcode/skills/openfusion/SKILL.md   # MODIFIED (doc): note non-blocking on Tasks-aware clients, unchanged behavior otherwise (FR-010)
```

**Structure Decision**: Single-project layout (existing). One new source file (`task-runner.ts`) isolates the detached-runner + correlation concerns; `fusion.ts` gets a surgical refactor to expose activity allocation separately from its epilogue. No new directories, no new dependencies. The skill update is documentation only.

## Complexity Tracking

> None. Constitution Check passes with no violations to justify. The feature is the standard, minimal answer to a real problem (long tool calls vs. client timeouts), implemented against the ratified MCP spec on a stack that already supports both ends.
