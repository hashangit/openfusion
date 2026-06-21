# Feature Specification: MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Feature Branch**: `005-mcp-tasks-sep`

**Created**: 2026-06-18

**Status**: Draft

**Input**: User description: "Add MCP Tasks (SEP-1686) support for async non-blocking fusion: return a task handle immediately, client polls/fetches the result."

## Background & Motivation

Today the `fusion` tool blocks for the full fan-out → two-step judge duration (typically 60–140s, observed 88s in production). The MCP spec defines no standard tool-call timeout, so each client enforces its own: the ZCode/codex client enforces a hard ~30–60s ceiling. When the ceiling is shorter than the fusion, the client kills the `tools/call` request even though the work completes successfully server-side (verified: the activity row lands and the synthesized answer is correct). The agent sees a timeout, never the answer.

**MCP Tasks (SEP-1686, spec version `2025-11-25`, status Final)** is the standardized fix. A task-augmented `tools/call` returns a durable `CreateTaskResult` (a task ID) *immediately*; the client polls `tasks/get` for status or calls `tasks/result` (which blocks server-side until completion) to retrieve the final `CallToolResult`. Polling belongs to the host/client — NOT the LLM. SEP-1686 explicitly rejects agent-driven polling as "unnecessarily expensive and inconsistent."

**Both ends support it** (verified):
- Server: `@modelcontextprotocol/sdk@1.29.0` (OpenFusion's pinned version) ships `experimental/tasks/` with `server.experimental.tasks.registerToolTask()`, `InMemoryTaskStore`, and `taskSupport: 'optional'|'required'`.
- Client: the codex Rust binary (`/Applications/Codex.app/Contents/Resources/codex`, the ZCode harness) contains literal occurrences of `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, `CreateTaskResult`, `taskStatus`, and `taskSupport` in its compiled strings — it implements the Tasks client.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tasks-aware client gets the fusion answer without timing out (Priority: P1)

A Tasks-aware MCP client (e.g. the ZCode/codex harness) calls the `fusion` tool. OpenFusion allocates a task and returns a `CreateTaskResult` synchronously (sub-second), so the `tools/call` request completes well under any client timeout. OpenFusion continues running the fan-out + two-step judge in the background of the same Node process. The client polls `tasks/get` (receiving progress: stage transitions, survivor counts) and/or calls `tasks/result`, which blocks server-side until the judge finishes and then returns the consolidated `CallToolResult` — the synthesized answer, exactly as today. The agent receives the full fusion answer with no timeout ever firing.

**Why this priority**: This is the entire point of the feature — eliminating the client-side timeout that currently swallows fusion results. Without it, nothing else matters.

**Independent Test**: Configure OpenFusion (≥2 candidates + judge + keys). From a Tasks-aware client, call `fusion` with a smoke prompt. Verify (a) the `tools/call` returns within ~1s carrying a task ID, (b) a subsequent `tasks/result` call returns the synthesized answer after ~60–140s, (c) the `activities` table has exactly one row (status `ok`) with the usual N+2 `sub_calls`, and (d) no client-side timeout fires.

**Acceptance Scenarios**:

1. **Given** OpenFusion is fully configured and the client advertises Tasks support, **When** the client calls `fusion` task-augmented, **Then** `tools/call` returns a `CreateTaskResult` with a `taskId` in under ~2s, and the fusion work is observably in progress (activity row status `running`).
2. **Given** a task-augmented fusion is in flight, **When** the client calls `tasks/get { taskId }`, **Then** it receives a status reflecting the current stage (`working`) and, on completion, `completed`.
3. **Given** a task-augmented fusion has completed, **When** the client calls `tasks/result { taskId }`, **Then** it receives the final `CallToolResult` whose `content[0].text` is the synthesized answer identical to what a blocking call would have produced.
4. **Given** a task-augmented fusion completes, **When** inspecting the DB, **Then** there is exactly ONE `activities` row (not one per poll) with the full N+2 `sub_calls` breakdown — observability is unchanged from the blocking path.

---

### User Story 2 - Non-Tasks client still works via graceful fallback (Priority: P1)

A client that does NOT implement Tasks (older MCP clients, minimal clients) calls `fusion`. Because the tool is registered with `taskSupport: 'optional'`, OpenFusion falls back to the legacy blocking behavior: the single `tools/call` blocks until the fusion completes and returns the `CallToolResult` directly. The contract for such clients is identical to today.

**Why this priority**: OpenFusion must remain usable by every MCP client it works with today. A Tasks-only cutover would break non-Tasks clients and violate constitution Principle VII (Simple & Local) and the "no regressions" expectation.

**Independent Test**: From a non-Tasks client (e.g. a plain MCP probe or the existing test harness that does not send task augmentation), call `fusion`. Verify the single call blocks and returns the synthesized `CallToolResult`, identical to pre-feature behavior.

**Acceptance Scenarios**:

1. **Given** the client does NOT send a task-augmented request (no `task` param), **When** it calls `fusion`, **Then** OpenFusion executes the full blocking path and returns the final `CallToolResult` with the synthesized answer.
2. **Given** a non-Tasks blocking call, **When** it completes, **Then** the activity row is recorded identically to the task path (one row, N+2 sub_calls) — no observability divergence between the two paths.

---

### User Story 3 - Task failure surfaces as an error result, not a hung task (Priority: P2)

A task-augmented fusion fails: fewer than 2 candidates survive the fan-out, or the judge errors, or a config gate fails. The task transitions to a terminal state (`failed`/`error`), and `tasks/result` returns the error as a `CallToolResult` with `isError: true` carrying the same `code` + `retryable` error text the blocking path produces. The task never hangs indefinitely.

**Why this priority**: Error parity with the blocking path. A hung `working` task would be worse than a clean timeout.

**Independent Test**: Call `fusion` task-augmented with a configuration where all but one candidate's provider key is invalid (or use faux providers that all fail). Verify the task reaches a terminal failed state and `tasks/result` returns `isError: true` with the survival/config error.

**Acceptance Scenarios**:

1. **Given** a task-augmented fusion where <2 candidates survive, **When** the client calls `tasks/result`, **Then** it receives `isError: true` with the survival error message, and the activity row status is `error`.
2. **Given** a task-augmented fusion hits the config gate (unconfigured), **When** the task is created, **Then** it transitions to `failed` fast (no background work) and `tasks/result` returns the needs-config error pointing to `http://localhost:9077`.
3. **Given** a task reaches a terminal state (completed or failed), **When** the client polls it again later, **Then** it consistently returns the same terminal result (idempotent, no re-execution).

---

### User Story 4 - Task progress is observable mid-flight (Priority: P3)

While a task is in the `working` state, `tasks/get` reflects coarse stage progress ("Fanning out to N models", "Analyzing", "Synthesizing") derived from the existing `onProgress` milestones. This gives the client (and, transitively, the user) a heartbeat during long fusions.

**Why this priority**: A "still working" signal is valuable but not essential; the SEP sanctions best-effort progress that correctness never depends on (constitution Principle III).

**Independent Test**: During a task-augmented fusion, call `tasks/get` at intervals and verify the returned status/progress field advances through fan-out → analysis → synthesis → done.

**Acceptance Scenarios**:

1. **Given** a task-augmented fusion mid-flight, **When** the client calls `tasks/get`, **Then** the response reflects a `working` status with a progress indicator that advances through the known stages.

---

### Edge Cases

- **Process restart during a task**: OpenFusion runs as one Node process. If the process exits while a background task is in flight, the in-memory task is lost (no durability). The `activities` row will retain whatever status was last flushed (likely `running`/`error`). This is acceptable for v1 (constitution Principle VII — start simple); durable tasks (e.g. via Temporal) are explicitly out of scope. Documented as a known limitation.
- **`tasks/result` called before completion**: must block server-side until completion (long-poll), not return an empty/error result. Bounded by the fusion's own timeouts (worker timeout × retries + judge), not an infinite hang.
- **`tasks/result` called on an unknown/expired taskId**: return a clear error (`Unknown task` / `Task expired`), HTTP-agnostic over stdio.
- **Task TTL expiry**: if the client never fetches and the task TTL elapses after completion, the task store may evict it. The `activities` row (persisted in SQLite) remains the durable source of truth regardless of task-store eviction.
- **Concurrent `fusion` calls**: each gets its own task + activity; no shared mutable state. Fan-out already uses `Promise.allSettled`; tasks simply add detached wrappers.
- **Client cancels** (`tasks/cancel`): best-effort — stop awaiting the background work where possible; record activity status as `cancelled` if supported by the schema, else `error`. Cancellation is advisory, not guaranteed (a worker call in flight cannot be aborted mid-stream via pi-ai today).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `fusion` tool MUST be registered as a task-capable tool via `server.experimental.tasks.registerToolTask` with `taskSupport: 'optional'`, so Tasks-aware clients get async behavior and non-Tasks clients get legacy blocking behavior.
- **FR-002**: On a task-augmented `fusion` call, OpenFusion MUST return a `CreateTaskResult` (task ID + `working` status) synchronously and start the fusion work detached in the background of the same Node process.
- **FR-003**: The activity ID MUST be allocated up front (status `running`) before the `CreateTaskResult` is returned, so the task and the activity share an identity and the DB row exists from the start of work.
- **FR-004**: OpenFusion MUST expose the task's terminal result via the SDK's `getTaskResult` handler, returning the final `CallToolResult` (synthesized answer, or `isError: true` with `code`+`retryable` on failure) — identical payload to the blocking path.
- **FR-005**: `tasks/get` MUST reflect the task lifecycle (`working` → `completed`/`failed`) and, best-effort, the existing progress milestones.
- **FR-006**: The fusion semantics MUST NOT change: same fan-out (`Promise.allSettled`, per-worker timeout, ≥2 survivors), same two-step judge on the same model, same persona resolution, same config gate. The ONLY change is *when* the `tools/call` returns.
- **FR-007**: Observability MUST be unchanged: exactly one `activities` row + N+2 `sub_calls` rows per fusion regardless of blocking-vs-task path. Polling MUST NOT create duplicate rows.
- **FR-008**: A non-Tasks client calling `fusion` MUST receive byte-for-byte the same `CallToolResult` it does today (no regression).
- **FR-009**: Tasks MUST reach a terminal state (`completed` or `failed`) in bounded time — bounded by the fusion's own timeouts, never an infinite hang.
- **FR-010**: The `openfusion` skill MUST be updated to reflect that fusion is now non-blocking on Tasks-aware clients and to document the fallback behavior.

### Key Entities *(include if feature involves data)*

- **Task**: a durable handle to an in-flight fusion, carrying `taskId`, lifecycle status (`working`/`completed`/`failed`), and a reference to the eventual `CallToolResult`. Lives in the SDK's `InMemoryTaskStore` (process-scoped, non-durable).
- **Activity** *(existing)*: the SQLite row that remains the durable source of truth. Its `status` column gains/uses a `running` state for in-flight fusions (already nullable/string-typed — verify no enum constraint). The task's `taskId` and the activity's `id` SHOULD be correlated (recommended: reuse the activity ID as the task ID, or store a mapping).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A Tasks-aware client (ZCode/codex harness) calling `fusion` with a prompt that takes ~90s to fuse receives the full synthesized answer with NO client-side timeout, where today it times out at the client ceiling.
- **SC-002**: The synchronous `tools/call` response on a task-augmented call returns in under ~2s (task creation overhead only).
- **SC-003**: Observability is identical pre/post feature: one `activities` row + N+2 `sub_calls` per fusion, queryable in the dashboard's activity log, regardless of blocking vs task path.
- **SC-004**: All existing tests (57 as of this writing) continue to pass; new tests cover the task path (create, get, result, fallback, failure) using pi-ai `registerFauxProvider()` for determinism.
- **SC-005**: A non-Tasks client experiences zero behavior change (same blocking `CallToolResult`).

## Assumptions

- **SDK API stability**: `@modelcontextprotocol/sdk` exposes Tasks under the `experimental/` namespace marked "may change without notice." We accept this risk because (a) OpenFusion pins the SDK exactly (1.29.0) so the API won't shift under us, and (b) no stable alternative exists. Upgrading the SDK pin is a separate decision.
- **Same-process background work**: detached fusion runs on the Node event loop in the existing single process (constitution Principle VII). No worker threads, no separate process, no queue infra. Acceptable because fusion is CPU-light (it's I/O-bound on provider calls).
- **Non-durable tasks**: if the process restarts mid-task, the in-flight task is lost. The SQLite activity row is the durable record. Durable tasks are out of scope for v1.
- **Client Tasks support is advertised via the standard mechanism**: OpenFusion does not need to detect client capabilities manually — `registerToolTask` with `taskSupport: 'optional'` handles fallback automatically per the SDK contract.
- **taskId ↔ activityId correlation**: reuse the activity ID as the task ID where the SDK permits, to avoid a separate mapping table and keep one source of truth.
- **`openfusion` skill update is in scope**: the skill currently assumes blocking semantics; it must document the new non-blocking contract.
