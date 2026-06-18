# Contract: MCP `fusion` Tool — Task-Augmented (SEP-1686)

**Interface type**: Model Context Protocol tool, exposed over stdio by the OpenFusion MCP server.

This **extends** the existing `fusion` tool contract ([`004/.../mcp-fusion-tool.md`](../../004-fusion-mcp-server/contracts/mcp-fusion-tool.md)). Feature 005 does not add a new tool — it re-registers `fusion` as a **task-capable** tool via `server.experimental.tasks.registerToolTask` with `taskSupport: 'optional'`. The input schema, output `CallToolResult` shape, progress milestones, and error contract are **unchanged**. What changes is *when* `tools/call` returns on a task-augmented request.

---

## Registration (server-side)

```ts
server.experimental.tasks.registerToolTask('fusion', {
  description: "...(existing description)...",
  inputSchema: fusionInputSchema,                 // unchanged: { prompt, context?, persona? }
  execution: { taskSupport: 'optional' },          // graceful fallback to blocking
}, {
  createTask:    ...,   // see "createTask" below
  getTask:       async (_args, extra) => extra.taskStore.getTask(extra.taskId),
  getTaskResult: async (_args, extra) => extra.taskStore.getTaskResult(extra.taskId),
});
```

`taskSupport: 'optional'` means:
- **Tasks-aware client** sends `tools/call` with a `task` param → server runs `createTask`, returns `CreateTaskResult` immediately, fusion runs detached.
- **Non-Tasks client** sends plain `tools/call` → server runs the blocking path, returns `CallToolResult` directly (byte-for-byte today's behavior).

---

## `tools/call` responses — two shapes depending on augmentation

### A. Task-augmented request (Tasks-aware client)

The client includes a `task` field (e.g. `{ task: { ttl } }`) in the `tools/call` params. The server responds synchronously with a **`CreateTaskResult`** (NOT a `CallToolResult`):

```jsonc
{
  "task": {
    "taskId": "<32-char hex>",
    "status": "working",
    "createdAt": 1718700000000,
    "pollInterval": 2000
  }
}
```

The `tools/call` HTTP/JSON-RPC request is now **complete** — the client's tool-call timeout no longer applies to the fusion work. The client then drives the task lifecycle via the methods below.

### B. Non-augmented request (fallback, non-Tasks client)

Identical to today — the single `tools/call` blocks and returns the `CallToolResult`:

```jsonc
{
  "content": [ { "type": "text", "text": "<consolidated answer>" } ]
}
```

...or `{ "isError": true, "content": [...] }` per the existing error contract. No behavior change, no regression (FR-008).

---

## Task lifecycle methods (handled by the SDK + our `getTask`/`getTaskResult` proxies)

### `tasks/get { taskId }`

Returns the current task state (best-effort progress):

```jsonc
{
  "task": {
    "taskId": "<id>",
    "status": "working",                       // working | completed | failed | cancelled
    "statusMessage": "1/3 — 3/4 candidates responded; analyzing…",  // best-effort, may be absent
    "createdAt": 1718700000000
  }
}
```

`statusMessage` is fed from the existing progress milestones (fan-out → analysis → synthesis → done). Progress is **advisory** — correctness never depends on it (constitution Principle III).

### `tasks/result { taskId }`

**Blocks server-side** until the task reaches a terminal state, then returns the final `CallToolResult` — identical shape to the blocking path:

```jsonc
// on success
{
  "content": [ { "type": "text", "text": "<consolidated answer>" } ]
}
// on failure
{
  "isError": true,
  "content": [ { "type": "text", "text": "<code+retryable error, same as blocking path>" } ]
}
```

Bounded wait: the server holds the request only until the fusion's own timeouts resolve (worker timeout × retries + judge). Never an infinite hang (FR-009). Idempotent on terminal tasks (INV-5).

### `tasks/cancel { taskId }` *(optional, v1.1)*

Best-effort cancellation. The task transitions to `cancelled`; an in-flight worker call cannot be hard-aborted (pi-ai has no mid-stream cancel today), so cancel is advisory. The `activities` row is set to `status='cancelled'` (or `error` if cancel isn't tracked) once the in-flight work settles.

---

## What does NOT change (contract stability guarantees)

- **Input schema** — `{ prompt, context?, persona? }`, unchanged.
- **Final `CallToolResult`** — same content block, same `isError` semantics, same error messages (pointing to `http://localhost:9077`).
- **Fusion semantics** — same fan-out (`Promise.allSettled`, per-worker timeout, ≥2 survivors), same two-step judge on one model, same persona resolution, same config gate (constitution Principle VI).
- **Observability** — exactly one `activities` row + N+2 `sub_calls` per fusion, regardless of path. Polling creates no extra rows (FR-007, INV-1).
- **Progress notifications** — `notifications/progress` still emitted at milestones for clients that sent a `progressToken` (task path may or may not surface these depending on client; the `statusMessage` via `tasks/get` is the canonical task-progress channel).
- **The `open_dashboard` tool** — unchanged.

---

## Capability advertisement

The SDK advertises the server's Tasks capability automatically once `registerToolTask` is used; the tool's `tools/list` entry declares its task support (`execution.taskSupport`). OpenFusion does no manual capability negotiation.

## Out-of-band

As with the base tool: no MCP `resources`/`prompts`. Config + stats remain on the REST API. The REST API and dashboard need **no changes** for this feature — the `activities`/`sub_calls` rows are the same; the dashboard already renders them. (Optional, low-priority: a future dashboard badge for in-flight `running` activities — out of scope for 005.)
