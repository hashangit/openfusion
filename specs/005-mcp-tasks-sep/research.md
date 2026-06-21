# Phase 0 Research: MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Feature**: 005-mcp-tasks-sep | **Date**: 2026-06-18

This resolves every NEEDS CLARIFICATION from the spec and technical context. Sources are the installed SDK (`@modelcontextprotocol/sdk@1.29.0`), the on-disk OpenFusion DB, and the verified client capabilities (codex Rust binary).

## R-001: Does `@modelcontextprotocol/sdk@1.29.0` (OpenFusion's pinned SDK) support server-side Tasks?

**Decision**: YES — fully supported under the `experimental/` namespace.

**Evidence**: `node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/` ships:
- `mcp-server.js` — `ExperimentalMcpServerTasks` accessed as `server.experimental.tasks.registerToolTask(name, config, handler)`.
- `interfaces.js` — `ToolTaskHandler<Args> = { createTask, getTask, getTaskResult }`.
- `stores/in-memory.js` — `InMemoryTaskStore` + `InMemoryTaskMessageQueue`.
- `server.js` — low-level `ExperimentalServerTasks` (streaming).
- `index.js` — re-exports all of the above.

**The high-level registration API** (from `mcp-server.d.ts`):
```ts
server.experimental.tasks.registerToolTask('fusion', {
  description: "...",
  inputSchema: fusionInputSchema,          // ZodRawShape
  execution: { taskSupport: 'optional' },  // 'optional' | 'required' (never 'forbidden')
}, {
  createTask:    async (args, extra) => { /* return { task } */ },
  getTask:       async (args, extra) => extra.taskStore.getTask(extra.taskId),
  getTaskResult: async (args, extra) => extra.taskStore.getTaskResult(extra.taskId),
});
```

**Caveat (accepted)**: The module is marked `@experimental` and "may change without notice." Acceptable because OpenFusion pins the SDK exactly (`save-exact`, currently 1.29.0) per constitution, so the API is frozen for us until an explicit upgrade. There is no stable alternative.

**Alternatives considered**:
- *Low-level `Server` with manual `tasks/get` request handlers* — rejected: reinvents what `registerToolTask` already provides (lifecycle wiring, store injection, fallback semantics).
- *Bespoke `fusion_result` poll tool* — rejected: duplicates the standard, locks us to LLM-driven polling (which SEP-1686 explicitly discourages), and pollutes the tool list.

---

## R-002: How is `taskSupport: 'optional'` fallback actually realized?

**Decision**: `taskSupport: 'optional'` lets the SDK serve BOTH code paths from one tool registration.

**Mechanism** (from `interfaces.d.ts` — `TaskToolExecution`):
```ts
type TaskToolExecution = Omit<ToolExecution, 'taskSupport'> & {
  taskSupport: T extends 'forbidden' | undefined ? never : T;
};
```
- `'optional'` → client chooses: if it sends a task-augmented request (`tools/call` with a `task` param), the server runs the `createTask` handler and returns a `CreateTaskResult`; if not, the server runs the tool's blocking path and returns a `CallToolResult` directly.
- `'required'` → only task-augmented requests are honored; non-task clients get an error.
- `'forbidden'` is excluded for task-based tools (compile-time `never`).

**Implication for OpenFusion**: We MUST keep the blocking `runFusion` path intact. `registerToolTask` does not abolish it — `optional` means the server must still be able to execute synchronously when the client declines task augmentation. Concretely: the **same** fusion core (`runFusion`) is invoked in two wrappers — (a) blocking handler that awaits it and returns `CallToolResult`; (b) `createTask` handler that fires-and-forgets it into a detached promise and returns `{ task }`, with `getTaskResult` returning the stored result.

**Risk noted → RESOLVED (T002 probe)**: The T002 throwaway probe (`scripts/probe-tasks-api.ts`) verified `optional` falls back to blocking exactly as designed. A non-augmented `tools/call` returned a blocking `CallToolResult` (`async-result`); a task-augmented `tools/call` returned a `CreateTaskResult`, and `tasks/result` fetched the same `async-result`. **FR-008 confirmed at the SDK level.** See R-010 for the three wiring prerequisites the probe uncovered.

---

## R-003: Can the task ID BE the activity ID (single source of truth)?

**Decision**: NO — taskId is store-generated; we CORRELATE them via a module-level map.

**Evidence** (`in-memory.d.ts`):
```ts
// InMemoryTaskStore.generateTaskId()
// "Uses 16 bytes of random data encoded as hex (32 characters)."
private generateTaskId(): string;
```
The store mints its own opaque taskId; `createTask` returns it inside the `Task` object. We cannot force `taskId === activityId`.

**Chosen correlation**: a `Map<taskId, activityId>` in the module that owns the detached runners (e.g. `src/fusion/task-runner.ts`). On `createTask`, we allocate the activity row first (status `running`), then create the task, then record `taskActivity.set(task.taskId, activityId)`. The `getTask`/`getTaskResult` handlers read this map to resolve the activity for progress/status enrichment.

**Alternatives considered**:
- *Custom `TaskStore` subclass overriding `generateTaskId`* — rejected: over-engineering; the store is `@experimental` and subclassing it couples us to its internals. A `Map` is simpler and constitution Principle VII (Simple).
- *Storing activityId in the task's `context` field* — viable but `context` is `Record<string, unknown>` passed at creation; the map is easier to read and time-bounded to the task's life. If we later go durable, we'd revisit this.

**Lifecycle of the map**: entries are added on `createTask` and deleted when the task reaches a terminal state (completed/failed/cancelled) or on TTL expiry. Bounded by concurrent-in-flight fusions (single process, low cardinality).

---

## R-004: Does the `activities.status` column accept new values (`running`, `cancelled`) without a migration?

**Decision**: YES — no migration needed.

**Evidence** (`sqlite3 .schema activities`):
```
status TEXT NOT NULL,
CREATE INDEX idx_activities_status ON activities(status);
```
Plain `TEXT`, no CHECK constraint, no enum. Existing distinct values in the DB: `partial`, `success`. Adding `running` (allocated before fan-out completes) and, if we support cancel, `cancelled` is purely a new string value. The index remains valid.

**Note on `running`**: today `runFusion` writes the `activities` row at the END (after the judge). To support tasks we MUST allocate it at the START (status `running`) and flip it to `success`/`partial`/`error` at the end. This is a refactor of the logging path inside `runFusion` (or its caller), not a schema change.

---

## R-005: What does `getTaskResult` return, and how does it map to today's `CallToolResult`?

**Decision**: `getTaskResult` returns a `CallToolResult` — the SAME shape today's blocking `fusion` handler returns.

**Evidence** (`interfaces.d.ts`):
```ts
interface ToolTaskHandler<Args> {
  createTask:  ... <CreateTaskResult, Args>;
  getTask:     ... <GetTaskResult, Args>;
  getTaskResult: ... <CallToolResult, Args>;
}
```
And `TaskStore.storeTaskResult(taskId, status: 'completed'|'failed', result: Result)`. So the detached runner, upon completion, calls:
```ts
await extra.taskStore.storeTaskResult(
  taskId,
  result.ok ? 'completed' : 'failed',
  result.ok
    ? { content: [{ type: "text", text: result.answer }] }
    : { isError: true, content: [{ type: "text", text: result.error }] },
);
```
This is byte-for-byte today's `{ content, isError? }` payload. **FR-008 (no regression for non-Tasks clients) and FR-004 (identical result for task clients) are satisfied by construction** — both paths produce the same `CallToolResult`.

---

## R-006: How is progress surfaced via `tasks/get`?

**Decision**: Use `taskStore.updateTaskStatus(taskId, status, statusMessage)` at the existing progress milestones.

**Evidence**: `TaskStore.updateTaskStatus(taskId, status, statusMessage?)` — the optional `statusMessage` is a free-text diagnostic. The `Task.status` field stays `working` until terminal; the message carries the stage.

**Today's milestones** (from `fusion.ts:97/180/215/237`):
- `0/3 Fanning out to N models…`
- `1/3 N/M candidates responded; analyzing…`
- `2/3 Analysis complete; synthesizing…`
- `3/3 Done`

**Wiring**: the detached runner's `onProgress` callback calls `taskStore.updateTaskStatus(taskId, 'working', message)`. The `getTask` handler (which just proxies `extra.taskStore.getTask`) then returns the latest status+message. This satisfies FR-005 (best-effort; constitution Principle III — correctness never depends on progress).

---

## R-007: Where does the detached fusion runner live, and what runs it?

**Decision**: A fire-and-forget async function on the existing Node event loop, in the same process. No worker threads, no child processes, no queue.

**Rationale** (constitution Principle VII — Simple & Local): fusion is I/O-bound (provider HTTP calls via pi-ai), not CPU-bound. `Promise.allSettled` fan-out already runs concurrently on the event loop. A detached task is simply `void runDetachedFusion(...)` — the returned promise is not awaited by `createTask`, but IS awaited internally so rejections are caught and routed to `storeTaskResult(..., 'failed', ...)`.

**New file**: `src/fusion/task-runner.ts` — owns the `Map<taskId, activityId>`, exposes `startDetachedFusion({ args, task, taskStore, db })`. It calls `runFusion` internally (refactored to allocate the activity row up front).

**Failure handling**: a top-level `try/catch` around the detached `runFusion` ensures ANY error (survival failure, judge error, config gate, unexpected throw) routes to `storeTaskResult(taskId, 'failed', { isError: true, content })`. The task can never hang (FR-009) — bounded by `workerTimeoutMs × retries + judge` time, today's existing bounds.

---

## R-008: Is process-restart durability required?

**Decision**: NO for v1. Documented limitation.

**Evidence/Reasoning**: `InMemoryTaskStore` is explicitly non-durable ("all data is lost on restart"). Constitution Principle VII (start simple, YAGNI) and the spec's Edge Cases both scope durability out. The SQLite `activities` row (with `status` possibly stuck at `running`) remains the durable record; on restart we leave such orphaned rows as-is (a future cleanup task could sweep `running` rows older than N minutes).

**Alternatives considered (rejected for v1)**: a SQLite-backed `TaskStore` implementation; Temporal workflows (overkill for a ~90s operation).

---

## R-009: Does the `openfusion` skill need changes?

**Decision**: YES — a documentation update, in scope (spec FR-010).

**Current skill** (`/Users/hashanw/Developer/OpenFusion/.zcode/skills/openfusion/SKILL.md` per the available-skills list) describes fusion as a single blocking call. Changes needed:
- Note that on Tasks-aware clients the call returns immediately with a task handle and the result is fetched via the standard Tasks mechanism (the client/host handles polling transparently — the LLM does nothing different).
- Note that on non-Tasks clients behavior is unchanged (blocking).
- No change to the *decision* of when to use fusion (still for high-stakes/verification/research, not trivial lookups).

This is a doc-only change; no code in the skill.

---

## R-010: Tasks capability wiring — three prerequisites the probe uncovered

**Decision**: Three concrete wiring requirements for `mcp-server.ts`, all verified by the T002 probe (`scripts/probe-tasks-api.ts`, run 2026-06-18). These are NOT optional — omit any one and task-augmented calls fail.

**Evidence**: Each was discovered as a probe failure, then fixed, until the probe passed end-to-end (CASE A blocking fallback ✓, CASE B task creation + `tasks/result` fetch ✓).

1. **`registerToolTask` does NOT auto-declare the server's Tasks capability.** The server must pass `capabilities` in its constructor options:
   ```ts
   new McpServer(
     { name: "openfusion", version: VERSION },
     { taskStore: new InMemoryTaskStore(), capabilities: { tasks: { requests: { tools: { call: {} } } } } }
   );
   ```
   Without `capabilities.tasks`, a task-augmented `tools/call` fails with `"Server does not support task creation (required for tools/call)"` — thrown by `Server.assertTaskHandlerCapability` (`server/index.js:267`) → `assertToolsCallTaskCapability` (`experimental/tasks/helpers.js:20`). The capability gate checks `this._capabilities.tasks?.requests?.tools?.call`.

2. **The capability value is an object `{}`, NOT a boolean `true`.** `ServerTasksCapabilitySchema.requests.tools.call` is `z.ZodOptional<z.ZodCustom<object, object>>`. Passing `call: true` fails client-side response validation with a `$ZodError` at `path: ["capabilities","tasks","requests","tools","call"]`. Use `call: {}`.

3. **The client must ALSO advertise the capability** — but that's the ZCode/codex client's responsibility, not OpenFusion's. For OpenFusion's own tests (T006+), the in-process probe/test `Client` must be constructed with the same `capabilities: { tasks: { requests: { tools: { call: {} } } } }` shape, else the server's `assertTaskCapability` (`server/index.js:261`) rejects with the same "does not support task creation" error (this time entityName='Client', checking `_clientCapabilities.tasks.requests`).

**Probe result** (both cases passing):
```
[probe] CASE A (no task param): isCallToolResult= true  hasTaskField= false
[probe] CASE A content: [{"type":"text","text":"async-result"}]
[probe] CASE B (task param): hasTaskField= true  taskId= e232ceb1…  status= working
[probe] CASE B tasks/result content: [{"type":"text","text":"async-result"}]
[probe] PASS — optional falls back to blocking AND supports tasks
```

**Implication for tasks.md T010**: The `registerToolTask` change in `src/server/mcp-server.ts` MUST also add the `capabilities` + `taskStore` to the `new McpServer(...)` options. The existing constructor call (which passes only `{ name, version }`) needs both fields. This is a small but load-bearing addition — without it the task path is dead on arrival.

---

## Summary table

| Item | Decision | Risk |
|---|---|---|
| SDK Tasks support | Use `experimental/tasks`, pinned SDK | `@experimental` label (mitigated by exact pin) |
| Fallback mode | `taskSupport: 'optional'` | Verify true blocking fallback at impl time (test) |
| taskId ↔ activityId | Module-level `Map`, store can't be forced | Low cardinality, simple |
| `activities.status` | Add `running` (+`cancelled` if supported) | No migration — free-text column |
| Result shape | Identical `CallToolResult` both paths | None — by construction |
| Progress | `updateTaskStatus(..., 'working', msg)` at milestones | Best-effort only |
| Runner | Detached promise, same process | Non-durable (accepted) |
| Durability | Out of scope v1 | Orphaned `running` rows (documented) |
| Skill | Doc update | None |
| Capability wiring (R-010) | Server declares tasks capability + taskStore in McpServer options; capability value is an object, not boolean `true` | Load-bearing — verified by probe |
