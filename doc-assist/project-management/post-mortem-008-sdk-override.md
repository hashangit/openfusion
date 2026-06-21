# Post-mortem — Feature 008: the SDK handler override + stall-threshold bug

**Scope.** Feature 008-async-fusion-results on the `v0.3.0-upgrade` branch. This records the load-bearing architectural decision (the SDK handler override) and the bug class that the three-pass scrutinize cycle caught in the stall circuit.

---

### 1. Summary

Feature 008 gives non-Tasks MCP clients (codex/ZCode, which hardcode `task:None`) a deferred-result protocol so a long fusion no longer trips the client's ~60s tool-call timeout. The protocol required replacing the SDK's installed `CallToolRequest` handler to intercept non-Tasks calls before the SDK's `handleAutomaticTaskPolling` blocking loop runs — that loop was the root cause of the timeout. During scrutiny, a three-pass review cycle found that the stalled-circuit threshold was too aggressive for sequential mode (and for parallel mode under high `workerTimeoutMs`), which would have reclassified healthy fusions as stalled. Fixed with a per-row `stall_threshold_ms` column and a `completed`-overrides-`stalled` rule. 171/171 tests green.

---

### 2. Symptom

A codex/ZCode client calling `fusion({prompt})` for a fusion longer than ~60s would hang until the client's per-call timeout fired, then be killed. The fusion ran fine server-side; the client just never got the answer. The blocking happened inside the SDK's `handleAutomaticTaskPolling` (mcp.js:100-123): for a `taskSupport:'optional'` tool without a `task` param, the SDK calls `createTask`, then poll-loops (`getTaskResult` every 5s) until the task is terminal, THEN returns the final `CallToolResult`. That poll loop is synchronous from the client's perspective — `tools/call` doesn't return until the fusion completes.

Feature 005's Tasks path couldn't help these clients: codex/ZCode hardcode `task:None`, so `isTaskRequest` is always false, so the SDK always takes the blocking auto-poll branch. The `createTask` handler can't distinguish a real Tasks request from an auto-poll invocation (both call `createTask(args, taskExtra)` identically; `params.task` is not forwarded to the handler), so it can't return a deferred `processing` result for one and a working task for the other.

---

### 3. Root cause

The SDK's routing decision for `taskSupport:'optional'` tools lives inside the SDK's own `CallToolRequest` handler, which is installed at `_requestHandlers["tools/call"]`. There is no hook or callback to influence the routing from outside — the handler either blocks (non-Tasks) or returns a `CreateTaskResult` (Tasks), and the choice is made entirely on `!!request.params.task`.

The blocking auto-poll is not a bug in the SDK — it's the correct behavior for a generic `taskSupport:'optional'` tool that has no deferred-result protocol of its own. The problem is that OpenFusion's fusion tool DOES have a deferred-result protocol (`_resume_from`), but the SDK's routing runs before the tool handler can exercise it.

---

### 4. Why it produced the symptom

The symptom (client timeout) is two layers above the cause (SDK routing). A reader who only knows "codex times out on long fusions" would look at the fusion engine, the worker timeouts, or the client config — none of which are wrong. The actual mechanism: `client.callTool()` → SDK server receives `tools/call` → SDK handler checks `!params.task && taskSupport==='optional'` → calls `handleAutomaticTaskPolling` → blocks until terminal → client's per-call timeout fires. The fusion engine and workers are working correctly throughout; they're just running inside a blocked call that the client has already given up on.

---

### 5. Fix

**The SDK handler override** (`src/fusion/resume-dispatch.ts`). After the fusion tool is registered (so the SDK's handler is installed at `_requestHandlers["tools/call"]`), `installResumeDispatch` captures the SDK's handler, then replaces it via `setRequestHandler(CallToolRequestSchema, wrapper)`. The wrapper:

1. Peeks at `request.params` before the SDK's routing runs.
2. For a NON-Tasks call (`!params.task`) to the fusion tool: routes to kickoff (`_resume_from` absent) or retrieval (`_resume_from` present), returns the shape directly.
3. For everything else (Tasks clients, other tools, malformed requests): delegates to the captured SDK handler unchanged.

This preserves FR-013 (Tasks clients still get `CreateTaskResult` + `tasks/result`) by delegation, not reimplementation. The override reaches into `server.server._requestHandlers.get("tools/call")` — a deliberate, documented SDK coupling. A dispatch canary test (`tests/resume-parallel.test.ts`) asserts the captured handler exists and is a function after install, catching SDK shape changes at test time.

**Options considered and rejected:**
- *A. Drop the Tasks path entirely (plain `registerTool`).* Simplest, but loses FR-013 — Tasks-aware clients would have to LLM-poll like everyone else.
- *B. Unify via terminal tasks (createTask always returns terminal).* Same FR-013 violation; subverts the task machinery to carry a non-task result.
- *C (chosen). Low-level handler override.* Preserves both paths. Fragile (couples to SDK internals), but the coupling is documented in three places and guarded by a canary.

---

### 6. How it was found

- **Repro:** a faux-provider fusion with a 5s worker delay, driven through `client.callTool()` over `InMemoryTransport`. The call hung for exactly the worker delay (5s), confirming the blocking path.
- **The DIAG cascade:** added `console.error` markers inside the wrapper + `handleKickoff` to trace where the 5s went. All markers printed within milliseconds, proving the wrapper returned fast — the hang was in `drainTasks()` (the test teardown), not the call path. The "bug" was a test-timeout misconfiguration, not a runtime block. The real override worked correctly on the first run after the identity-collapse fix (below).
- **The duplicate-id bug (found during integration testing):** `handleKickoff` originally called `allocateActivity` to mint the reference id, then passed `args` to `startDetachedFusion`, which ALSO called `allocateActivity` internally. Two activity ids, two `fusion_jobs` rows — retrieval on the kickoff's id never found the runner's row. Fixed by having `startDetachedFusion` return `{ task, activityId }` and using that id in the kickoff shape (identity collapse — the runner owns the id).

---

### 7. Why it slipped through (the stall-threshold bug)

The stalled circuit shipped in the first implementation pass with a bare 5-minute threshold (`RESUME_STALL_MS = 300_000`). The assumption: "if no progress callback fires for 5 minutes, the fusion is hung." This assumption is wrong for two cases that the first pass didn't consider:

1. **Sequential mode.** `runSequentialFanout` (fanout.ts:94-96) calls `report()` before each candidate, then `await runWorker()` blocks for the full candidate duration (3–9 min). No progress callback fires during the candidate run. A 2-candidate sequential fusion with 9-min candidates has a 9-minute gap between callbacks — exceeding the 5-min threshold. A healthy sequential fusion would be reclassified as `error/stalled` mid-candidate.

2. **Parallel mode under high `workerTimeoutMs`.** A worker that times out and retries (3 attempts) against a 10-min timeout produces a ~30-min gap. The default 5-min threshold false-positives.

The test suite didn't catch either case because the integration tests used sub-threshold worker delays (5s for sequential, 0–48s for parallel). The bug was latent — it would have surfaced in production on the first real sequential run.

**Why the first pass missed it:** the stall circuit was added as a defensive measure (don't let a hung fusion empty-long-poll forever), and the threshold was sized for the parallel-default case. The sequential interaction wasn't traced because the progress-callback cadence of `runSequentialFanout` wasn't examined against the threshold. The scrutinize skill's "trace the untested paths" mandate caught it on the second look.

---

### 8. Validation

- **171/171 tests green** (163 fast + 8 slow integration).
- **Regression tests added:**
  - `resume-store.test.ts`: sequential job with stale progress under `stall_threshold_ms` stays processing; beyond threshold reclassifies; parallel job with high `workerTimeoutMs` uses the per-row threshold.
  - `resume-store.test.ts`: `markTerminal` completed write overrides speculative stalled; error write does not override; completed write does not override interrupted.
  - `resume-parallel.test.ts`: SC-002 (90s fusion in ≤3 round-trips), dispatch canary (SDK handler exists post-install).
  - `resume-sequential.test.ts`: sequential kickoff shape (ETA + dashboard), retrieval is ETA-guided (immediate, no long-poll).
  - `resume-durability.test.ts`: startup sweep reclassifies orphans; stalled circuit fires on read; write-late guard stores late completion.
- **NOT validated:** end-to-end against a real non-Tasks client (codex with real provider keys). This is T029 (E1), deferred as manual validation. All automated coverage of the SC-001 scenario exists via `resume-parallel.test.ts`.

---

### 9. Action items / follow-ups

- **T029 (E1):** end-to-end validation against real codex with real provider keys. (Owner: Hashan. Manual.)
- **SDK upgrade checklist:** on `@modelcontextprotocol/sdk` upgrade, verify (1) CallToolRequest handler install timing, (2) handler key is still `"tools/call"`, (3) `params.task` still discriminates and the SDK still blocks non-Tasks. Documented in `resume-dispatch.ts` header + AGENTS.md. (Owner: whoever upgrades.)
- **Durable task store:** the Tasks-path non-durability (InMemoryTaskStore) is the known limitation most likely to bite next. Scoped for v0.3.1. (Owner: TBD. Ticket: TBD.)
- **Cancellation wiring:** `tasks/cancel` + `AbortController` in `runFusion`. Scoped for v0.3.1. (Owner: TBD.)
