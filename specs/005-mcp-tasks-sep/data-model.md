# Data Model: MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Feature**: 005-mcp-tasks-sep | **Date**: 2026-06-18

This feature adds one in-memory entity (Task) and one in-memory association (taskId↔activityId). The SQLite schema is **unchanged** — `activities` and `sub_calls` gain only new values for the existing free-text `status` column.

## Entities

### 1. Task (in-memory, non-durable)

A handle to an in-flight fusion, owned by the SDK's `TaskStore`. Not persisted to SQLite.

| Field | Type | Notes |
|---|---|---|
| `taskId` | `string` | 32-char hex, store-generated (`InMemoryTaskStore.generateTaskId`). Opaque to OpenFusion. |
| `status` | `'working' \| 'completed' \| 'failed' \| 'cancelled'` | SDK lifecycle. `working` until fusion settles. |
| `statusMessage?` | `string` | Best-effort stage text from the existing milestones (e.g. `"1/3 N/M candidates responded; analyzing…"`). |
| `createdAt` | `number` (ms) | Store-set. |
| `_meta` / `context` | `Record<string, unknown>` | Unused by OpenFusion (see correlation below). |
| (terminal) `result` | `CallToolResult` | Stored via `storeTaskResult` on completion/failure. Identical shape to the blocking path's return. |

**Lifecycle**:
```
[createTask]  → working
                 ├─ onProgress milestones → updateTaskStatus(working, msg)
[runFusion]      ├─ ok     → storeTaskResult('completed', { content })     → completed
                 └─ !ok    → storeTaskResult('failed', { isError:true })   → failed
[cancel]      → cancelled (if supported; best-effort)
[TTL expiry]  → evicted from store (SQLite activity row persists)
```

### 2. taskId ↔ activityId association (in-memory)

| Field | Type | Notes |
|---|---|---|
| key | `taskId` | |
| value | `activityId` | The SQLite `activities.id` allocated at task creation. |

**Storage**: `Map<taskId, activityId>` in `src/fusion/task-runner.ts`.
**Cardinality**: bounded by in-flight fusions (single process; typically 0–5).
**Lifecycle**: inserted in `createTask`; deleted when the task reaches a terminal state or errors during setup. Never blocks process exit.

## SQLite changes (schema unchanged)

### `activities` table — `status` column gains values

The column is `TEXT NOT NULL` with no CHECK constraint (verified via `.schema`). No migration. New values added by this feature:

| `status` value | Meaning | Set by | Pre-existing? |
|---|---|---|---|
| `running` | Fusion in flight (task path); row allocated before fan-out completes | `startDetachedFusion` at allocation | **NEW** |
| `success` | Fusion completed, ≥2 survivors, judge ok | end of `runFusion` | yes |
| `partial` | Completed but some candidates failed | end of `runFusion` | yes |
| `error` | <2 survivors, judge error, or config gate fail | end of `runFusion` | yes |
| `cancelled` | *(Optional, v1.1)* client cancelled via `tasks/cancel` | cancel handler | **NEW (optional)** |

**Allocation shift**: today `runFusion` writes the `activities` row at the *end*. The task path requires it at the *start* (status `running`) so the DB has a record before `CreateTaskResult` returns. This is implemented by hoisting the activity-insert out of `runFusion`'s epilogue into a callable `allocateActivity(...)` used by BOTH paths — the blocking path still works (it just inserts-then-updates rather than insert-at-end). The final UPDATE at the end sets the terminal status + token/cost/latency totals.

### `sub_calls` table — no change

Still N+2 rows per fusion (one per candidate + two judge steps), written by the existing logging. Polling/`tasks/get` does **not** create sub_call rows (FR-007) — only the single fusion does, exactly once.

## Validation rules / invariants

- **INV-1**: For every task that reaches `completed`/`failed`, there is exactly ONE `activities` row whose final `status` is terminal (`success`/`partial`/`error`/`cancelled`). Polling never inserts a second row.
- **INV-2**: `taskId` is globally unique (store guarantee); `activityId` is unique (PK). The association map has no collisions.
- **INV-3**: A task in `working` has a corresponding `activities` row with `status='running'` (barring process crash between insert and map-write — acceptable non-durability, see spec Edge Cases).
- **INV-4**: The `CallToolResult` stored for a task is byte-for-byte identical to what the blocking path returns for the same inputs (same persona, same candidates, same prompt) — modulo the non-determinism of LLM generation itself.
- **INV-5**: A terminal task's `getTaskResult` is idempotent — repeated calls return the same stored result, never re-execute the fusion.

## Relationships

```
tools/call (task-augmented)
   │
   ├─ createTask handler
   │     ├─ activity = allocateActivity(status='running')   ──► activities (SQLite)
   │     ├─ task = extra.taskStore.createTask(...)           ──► TaskStore (in-memory)
   │     ├─ taskActivity.set(task.taskId, activity.id)       ──► Map (in-memory)
   │     └─ void startDetachedFusion(activity, task, store)  ──► event loop (fire-and-forget)
   │            ├─ runFusion(...) → writes N+2 sub_calls, updates activities
   │            ├─ onProgress → taskStore.updateTaskStatus(working, msg)
   │            └─ finally → taskStore.storeTaskResult(completed|failed, result); map.delete()
   │
   ├─ tasks/get {taskId}   → getTask handler → taskStore.getTask(taskId)   → { status, statusMessage }
   └─ tasks/result {taskId}→ getTaskResult handler → taskStore.getTaskResult(taskId) → CallToolResult
```

```
tools/call (non-augmented, fallback)
   │
   └─ blocking handler → allocateActivity(running) → await runFusion → updateActivity(terminal)
                          → return CallToolResult directly (identical to today)
```
