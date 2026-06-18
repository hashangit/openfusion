# Tasks: MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Input**: Design documents from `/specs/005-mcp-tasks-sep/`

**Prerequisites**: plan.md ✅, spec.md ✅ (4 user stories), research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: Test tasks ARE included — the spec's Success Criteria (SC-004) and `quickstart.md` (T1–T7) make tests a first-class deliverable. TDD-style: write failing test, then implement.

**Organization**: Tasks grouped by user story. US1 (P1) is the MVP — task-path end-to-end. US2 (P1) is the fallback regression guard. US3 (P2) is error parity. US4 (P3) is progress surfacing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story (US1, US2, US3, US4)
- All paths are repository-relative (`src/...`, `tests/...`)

## Critical pre-implementation notes

- **SDK is `@experimental`**: `@modelcontextprotocol/sdk@1.29.0` exposes Tasks under `experimental/tasks/`. The pin is exact (`save-exact`), so the API is frozen for us. Do not upgrade the SDK as part of this feature.
- **One source of truth for the fusion core**: `runFusion` in `src/fusion/fusion.ts` is NOT rewritten — it's refactored minimally to expose activity allocation separately. The blocking path and the task path both call it.
- **No DB migration**: `activities.status` is free-text `TEXT`; adding `running`/`cancelled` is just new values.
- **Strict stderr-only logging**: `console.log` corrupts the stdio MCP protocol. Any new logging in `task-runner.ts` / `mcp-server.ts` MUST use `console.error`.

---

## Phase 1: Setup

**Purpose**: Verify the SDK surface and lock the feature branch.

- [X] T001 Create feature branch `005-mcp-tasks-sep` off `main` and confirm clean working tree
- [X] T002 [P] Verify the SDK Tasks surface in `node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/` matches research.md R-001: `registerToolTask`, `InMemoryTaskStore`, `ToolTaskHandler` (`createTask`/`getTask`/`getTaskResult`), `TaskStore.updateTaskStatus`/`storeTaskResult`. Write a throwaway script `scripts/probe-tasks-api.ts` (deleted in T024) that imports and logs the shapes; confirm against `research.md`. **Additionally (de-risks FR-008 — the load-bearing fallback assumption):** the probe MUST also drive a non-augmented `tools/call` against a `registerToolTask(..., { execution: { taskSupport: 'optional' } }, ...)` tool and assert it returns a **blocking `CallToolResult`** (not a `CreateTaskResult`, not an error). If `optional` does NOT fall back to blocking, STOP and surface the discrepancy before Phase 2 — the whole feature's no-regression guarantee depends on it (research.md R-002).

**Checkpoint**: SDK surface + `optional` fallback confirmed; no surprises before touching production code.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Refactor the activity-row lifecycle so it can be allocated up front (status `running`) — the prerequisite for BOTH the task path (allocate before `CreateTaskResult`) and keeping the blocking path intact.

**⚠️ CRITICAL**: US1–US4 all depend on this. Do not start story phases until Phase 2 is green.

- [X] T003 [FR-003] Add `allocateActivity(db, { persona, prompt, promptExcerpt, ... }): string` to `src/store/activity.ts` — inserts an `activities` row with `status: 'running'` and returns its id. Reuse the existing `recordActivity` internals; do not duplicate the INSERT SQL. (Terminal updates continue to use the existing `updateActivity` directly — no new finalize API.)
- [X] T004 [FR-006] Refactor `runFusion` in `src/fusion/fusion.ts` so it accepts an already-allocated `activityId` (new optional `FusionInput.activityId?: string`): if provided, skip the current `recordActivity` call at line ~101 and use the passed id; if absent, allocate internally (preserving today's exact behavior for existing blocking callers). All `recordSubCall`/`updateActivity` calls at lines 137/163/197/219/241/284 continue to reference the same id. Calls that allocate up front then call `updateActivity(db, activityId, { ...terminalFields })` at the end.
- [X] T005 Run the existing fusion test suite and confirm all 57 tests still pass after the Phase 2 refactor. This is the regression gate — the blocking path must be byte-for-byte unchanged in behavior.

**Checkpoint**: `runFusion` can now run against a pre-allocated `running` activity row. Blocking callers unaffected. Green tests = safe to build the task path.

---

## Phase 3: User Story 1 — Tasks-aware client gets the fusion answer without timing out (Priority: P1) 🎯 MVP

**Goal**: A task-augmented `tools/call` returns a `CreateTaskResult` synchronously; the fusion runs detached; `tasks/get` and `tasks/result` return the answer.

**Independent Test**: `quickstart.md` T1 (deterministic, faux providers) + E1 (real client, real providers). Verify synchronous `CreateTaskResult` in < 50ms (test) / < ~2s (SC-002); `tasks/result` returns the synthesized `CallToolResult`; exactly one `activities` row.

### Tests for User Story 1 (write first, watch them fail)

- [ ] T006 [P] [US1] [FR-002] [SC-002] Write `tests/fusion-tasks.test.ts` T1: register faux providers (via pi-ai `registerFauxProvider`), drive the `fusion` tool's task path (task-augmented `tools/call`), assert the synchronous response is a `CreateTaskResult` (`task.taskId`, `status==='working'`) returned in < 50ms. **Test-harness note (from T002 probe / research.md R-010):** the in-process test `Client` MUST be constructed with `capabilities: { tasks: { requests: { tools: { call: {} } } } }`, else the server rejects task-augmented calls with "Client does not support task creation". The InMemoryTransport-linked server already declares its own capability in T010.
- [ ] T007 [US1] [FR-007] Extend `tests/fusion-tasks.test.ts` T1 (same file — sequenced after T006, not parallel): after the task returns, call `tasks/result { taskId }`, assert it resolves with a `CallToolResult` whose `content[0].text` is the synthesized faux answer. Assert exactly ONE `activities` row (status `success`) and candidate-count+2 `sub_calls` (FR-007, INV-1).

### Implementation for User Story 1

- [ ] T008 [P] [US1] [FR-002] [FR-003] Create `src/fusion/task-runner.ts`: export an in-module `const taskActivity = new Map<string, string>()` (taskId → activityId) and `startDetachedFusion({ args, task, taskStore, db, options })`. The function: (a) calls `allocateActivity(db, {...})` with status `running`, (b) sets `taskActivity.set(task.taskId, activityId)`, (c) fire-and-forgets an async IIFE that awaits `runFusion({ ...args, db, activityId, onProgress })`, (d) in the IIFE's `finally`, calls `taskStore.storeTaskResult(task.taskId, ok ? 'completed' : 'failed', callToolResult)` and `taskActivity.delete(task.taskId)`. Top-level try/catch ensures any throw routes to `'failed'` with `isError: true` (FR-009). Use `console.error` for any diagnostic logging.
- [ ] T009 [US1] [FR-005] Wire `onProgress` in `src/fusion/task-runner.ts` to call `taskStore.updateTaskStatus(task.taskId, 'working', message)` at the existing milestone messages (fan-out / analyzing / synthesizing / done). Progress is best-effort; never throws into the fusion path.
- [ ] T010 [US1] [FR-001] [FR-004] Modify `src/server/mcp-server.ts`: replace the current `server.tool('fusion', ...)` registration (line ~87) with `server.experimental.tasks.registerToolTask('fusion', { description, inputSchema: fusionInputSchema, execution: { taskSupport: 'optional' } }, { createTask, getTask, getTaskResult })`. The `createTask` handler calls `startDetachedFusion` and returns `{ task }`. `getTask` and `getTaskResult` proxy to `extra.taskStore.getTask(extra.taskId)` / `extra.taskStore.getTaskResult(extra.taskId)` per `contracts/mcp-fusion-tool-tasks.md`. **CRITICAL wiring (verified by T002 probe — see research.md R-010):** the existing `new McpServer({ name, version })` constructor MUST be updated to `new McpServer({ name, version }, { taskStore: new InMemoryTaskStore(), capabilities: { tasks: { requests: { tools: { call: {} } } } } })`. Without `capabilities.tasks.requests.tools.call`, task-augmented calls fail with "Server does not support task creation"; the value MUST be `{}` (object), not `true` (boolean). Keep the `open_dashboard` tool registration unchanged.
- [ ] T011 [US1] [FR-008] Preserve the blocking fallback: confirm `taskSupport: 'optional'` routes non-augmented `tools/call` to a blocking handler that awaits `runFusion` and returns the `CallToolResult` directly. T002's probe should have already proven this at the SDK level; here we confirm it for the real `fusion` tool. If an explicit blocking handler is required alongside `registerToolTask`, add it reusing `fusionToolHandler` from `src/server/mcp-server.ts:49`.

**Checkpoint**: T1 passes end-to-end with faux providers. The MVP works — a Tasks-aware client can fetch a fusion result without timing out.

---

## Phase 4: User Story 2 — Non-Tasks client still works via graceful fallback (Priority: P1)

**Goal**: Zero behavior change for clients that don't speak Tasks (FR-008, SC-005).

**Independent Test**: `quickstart.md` T2 — non-augmented call returns the same `CallToolResult` as before, blocking.

### Tests for User Story 2

- [ ] T012 [P] [US2] [FR-008] [SC-005] Write `tests/fusion-tasks.test.ts` T2: call `fusion` WITHOUT a `task` param against the faux setup; assert the call blocks and returns a `CallToolResult` directly (not a `CreateTaskResult`), with content matching the T006/T007 result for the same inputs.

### Implementation for User Story 2

- [ ] T013 [US2] Verify the existing `tests/mcp-server.test.ts` fusion handler tests still pass unchanged against the `registerToolTask` registration (they exercise the non-augmented path). If any test breaks due to the registration change, update the test setup to drive the tool via the same non-augmented call shape — but DO NOT weaken assertions. This task is validation + minimal test-harness adjustment only.

**Checkpoint**: US1 and US2 both green. Tasks-aware AND non-Tasks clients work; no regression.

---

## Phase 5: User Story 3 — Task failure surfaces as an error result, not a hung task (Priority: P2)

**Goal**: Errors in the task path produce `isError: true` `CallToolResult` via `tasks/result`, with a terminal `failed` task status. Bounded lifetime, no hangs.

**Independent Test**: `quickstart.md` T3 (survival failure) + T4 (config-gate failure) + T7 (idempotency).

### Tests for User Story 3

- [ ] T014 [P] [US3] [FR-009] Write `tests/fusion-tasks.test.ts` T3: configure faux providers so all but one fail (< 2 survivors); task-augmented call → `tasks/result`. Assert `isError: true` with the survival message, task `status==='failed'`, activity `status==='error'`.
- [ ] T015 [P] [US3] [FR-009] Write `tests/fusion-tasks.test.ts` T4: with OpenFusion unconfigured, task-augmented call. Assert the task transitions to `failed` WITHOUT spawning background fan-out (fast), and `tasks/result` returns the needs-config error pointing to `http://localhost:9077`.
- [ ] T016 [P] [US3] Write `tests/fusion-tasks.test.ts` T7: after T3/T4 reach terminal state, call `tasks/result` twice more; assert identical results each time and no new `sub_calls` (INV-5 idempotency).

### Implementation for User Story 3

- [ ] T017 [US3] [FR-004] [FR-009] In `src/fusion/task-runner.ts`, ensure the detached IIFE's catch block maps every `runFusion` rejection (survival failure, judge error, unexpected throw) to `taskStore.storeTaskResult(taskId, 'failed', { isError: true, content: [{ type: 'text', text: errorMessage }] })`. The `errorMessage` MUST carry `code` + `retryable` per the existing error contract — reuse `runFusion`'s error shape, do not invent a new one.
- [ ] T018 [US3] [FR-006] [FR-009] Handle the config-gate failure in the task path: if `runFusion`'s pre-flight config check fails (unconfigured), the task should reach `failed` without doing fan-out work. Verify this falls out naturally from `runFusion` rejecting early — if not, short-circuit in `startDetachedFusion` before calling `runFusion`. Decide at impl time; keep it minimal.

**Checkpoint**: Errors are first-class. No task can hang; every failure mode reaches a terminal state.

---

## Phase 6: User Story 4 — Task progress observable mid-flight (Priority: P3)

**Goal**: `tasks/get` reflects the existing progress milestones during a `working` task.

**Independent Test**: `quickstart.md` T6 — `tasks/get` advances through fan-out/analysis/synthesis.

### Tests for User Story 4

- [ ] T019 [P] [US4] [FR-005] Write `tests/fusion-tasks.test.ts` T6: with faux providers slowed (e.g. artificial delay) so stages are observable, repeatedly call `tasks/get { taskId }` during the run; assert `status==='working'` and `statusMessage` advances through the milestone strings, ending at `completed`.

### Implementation for User Story 4

- [ ] T020 [US4] [FR-005] Confirm T009's `onProgress → updateTaskStatus('working', msg)` wiring surfaces via `tasks/get`. If T019 reveals timing races (the task completes before any `tasks/get` lands), that's acceptable — progress is best-effort (constitution Principle III). Do not add artificial delays to production code to make the test pass; instead slow the faux providers in the test only.

**Checkpoint**: Best-effort progress works when observable; correctness never depends on it.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Docs, end-to-end validation, cleanup.

- [ ] T021 [P] [FR-010] Update `.zcode/skills/openfusion/SKILL.md`: document that fusion is now non-blocking on Tasks-aware clients (returns a task handle; client/host fetches the result via standard Tasks methods — the LLM does nothing different), and that non-Tasks clients fall back to blocking. No change to when-to-use guidance.
- [ ] T022 [P] Run the full `quickstart.md` validation suite: T1–T7 (deterministic) must all pass; E1 (real client ~90s fusion, no timeout — SC-001) and E2 (dashboard parity — SC-003) verified manually.
- [ ] T023 [SC-004] Run `pnpm test` and confirm the full suite (existing 57 + new T006–T019) is green. Fix any regressions.
- [ ] T024 Delete the throwaway `scripts/probe-tasks-api.ts` from T002. Ensure no stray `console.log` calls were introduced in `src/` (grep `console.log src/` — must be empty; stderr only).
- [ ] T025 [P] Update `AGENTS.md` architecture notes if the fusion tool's contract changed materially (the `fusion` tool section under "## The `fusion` Tool" — add a note that it's task-capable with `optional` fallback). Keep it surgical; do not rewrite the section.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies.
- **Phase 2 (Foundational)**: Depends on T002 (SDK + `optional` fallback verified). **BLOCKS all user stories.**
- **Phase 3 (US1 — MVP)**: Depends on Phase 2. The core task path.
- **Phase 4 (US2)**: Depends on Phase 3 (T010/T011 — the `registerToolTask` wiring must exist to test fallback against).
- **Phase 5 (US3)**: Depends on Phase 3 (error handling layers on the task runner).
- **Phase 6 (US4)**: Depends on Phase 3 (progress layers on `onProgress` wiring from T009).
- **Phase 7 (Polish)**: Depends on Phase 3 minimum; ideally all stories.

### User Story Dependencies

- **US1 (P1)**: Foundational only. No other-story dependency. **This is the MVP.**
- **US2 (P1)**: US1 must exist (fallback is defined relative to the task registration). Independently testable.
- **US3 (P2)**: US1 must exist (errors flow through `startDetachedFusion`). Independently testable.
- **US4 (P3)**: US1 must exist (progress uses `onProgress` from T009). Independently testable.

### Within Each User Story

- Tests (T006/T007, T012, T014–T016, T019) written FIRST and FAILING.
- Then implementation tasks.
- Checkpoint = independent test passes.

### Parallel Opportunities

- T001 ∥ T002 (Setup).
- Within Phase 2: T003 then T004 (same concern, `activity.ts` ↔ `fusion.ts`); T005 depends on both.
- Within US1: T006 then T007 (same file, sequenced). T008 is foundational impl; T009/T010/T011 build on it sequentially (T009 same file as T008; T010/T011 same file as each other).
- US3/US4 tests (T014 ∥ T015 ∥ T016 ∥ T019) are all in `tests/fusion-tasks.test.ts` — write them together in one pass.
- Polish: T021 ∥ T022 ∥ T024 ∥ T025 (different files).

---

## Parallel Example: User Story 3 Tests

```bash
# All US3 tests land in the same file — write them in one editing pass:
Task: "T014 [US3] survival-failure test in tests/fusion-tasks.test.ts"
Task: "T015 [US3] config-gate failure test in tests/fusion-tasks.test.ts"
Task: "T016 [US3] idempotency test in tests/fusion-tasks.test.ts"
# Then implement:
Task: "T017 [US3] error mapping in src/fusion/task-runner.ts"
Task: "T018 [US3] config-gate short-circuit in src/fusion/task-runner.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup (T001, T002 — including the `optional` fallback probe).
2. Phase 2: Foundational refactor (T003–T005). **CRITICAL — gates everything.**
3. Phase 3: US1 (T006–T011). Write tests first, implement, watch T1 pass.
4. **STOP and VALIDATE**: Run T1 + E1 (real client, ~90s fusion, no timeout). This alone delivers SC-001 — the actual user-visible win.

### Incremental Delivery

1. Setup + Foundational → refactor safe, blocking path unchanged.
2. + US1 → MVP: Tasks-aware clients no longer time out. **Ship-able.**
3. + US2 → fallback verified for non-Tasks clients (regression confidence).
4. + US3 → error parity (no hung tasks on failure).
5. + US4 → progress surfacing (nice-to-have).
6. Polish → docs, full validation, cleanup.

### Notes

- Commit after each task or logical group; the foundational refactor (Phase 2) deserves its own commit before any task-path code lands.
- The blocking path is the safety net throughout — if the task path misbehaves, `taskSupport: 'optional'` + a non-augmented call still works.
- If `registerToolTask`'s `optional` fallback does not behave as T002's probe predicts, STOP and re-evaluate before forcing it — surface the discrepancy rather than papering over it.
