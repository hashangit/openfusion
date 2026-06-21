# Quickstart: Validate MCP Tasks (SEP-1686) — Async Non-Blocking Fusion

**Feature**: 005-mcp-tasks-sep | **Date**: 2026-06-18

Runnable validation for the four user stories in [`spec.md`](./spec.md). References the [task-augmented tool contract](./contracts/mcp-fusion-tool-tasks.md) and [data model](./data-model.md). Implementation detail belongs in `tasks.md`, not here.

## Prerequisites

- OpenFusion built and runnable: `pnpm install && pnpm build` (or `pnpm dev` via tsx).
- OpenFusion **configured**: ≥2 enabled candidates + ≥1 enabled judge + a key for every referenced provider. Verify via `curl -s http://localhost:9077/api/status | jq '.configured'` → `true`. If false, open the dashboard (`openfusion-setup` or the `open_dashboard` tool) and configure it.
- The `@modelcontextprotocol/sdk@1.29.0` pin unchanged (Tasks lives under `experimental/`).
- For end-to-end client tests (Story 1): a Tasks-aware MCP client. The ZCode/codex harness qualifies (verified: its binary references `tasks/get|result|list|cancel`, `CreateTaskResult`, `taskSupport`). For deterministic tests, use the in-repo Vitest harness with pi-ai `registerFauxProvider()`.

## Unit / deterministic tests (Vitest, no network)

These are the primary success gate (SC-004) and live under `tests/`.

### T1 — Task-augmented call returns a task immediately, result fetched later (Story 1)

1. Register faux providers so fan-out + judge resolve deterministically and fast.
2. Drive the `fusion` tool's task path via the SDK: send a task-augmented `tools/call`.
3. **Verify**: the synchronous response is a `CreateTaskResult` (`task.taskId`, `status==='working'`) returned in **< 50ms** (no fusion work awaited).
4. Call `tasks/result { taskId }`; it resolves within the faux fusion's bounded time.
5. **Verify**: the returned `CallToolResult.content[0].text` is the synthesized faux answer.

### T2 — Non-augmented call falls back to blocking (Story 2)

1. Same faux setup as T1.
2. Call `fusion` WITHOUT a `task` param.
3. **Verify**: the call blocks and returns a `CallToolResult` directly (same shape as T1's result), identical to pre-feature behavior. No `CreateTaskResult`.

### T3 — Failure surfaces as `isError` (Story 3)

1. Configure faux providers so all but one candidate fail (survivor count < 2).
2. Task-augmented `fusion` call → `tasks/result`.
3. **Verify**: `tasks/result` returns `{ isError: true, content: [{ type:'text', text }] }` with the survival message; the task's terminal `status==='failed'`; the `activities` row `status==='error'`.

### T4 — Config gate fails fast (Story 3, acceptance 2)

1. With OpenFusion unconfigured, task-augmented `fusion` call.
2. **Verify**: the task transitions to `failed` without spawning background fan-out; `tasks/result` returns the needs-config error pointing to `http://localhost:9077`.

### T5 — One activity row, N+2 sub_calls, no duplicates (FR-007, INV-1)

1. Run T1; query the test DB.
2. **Verify**: exactly ONE `activities` row (final status `success`/`partial`), and `sub_calls` count == candidate count + 2 (judge analysis + synthesis). Polling `tasks/get` N times between create and result does NOT add rows.

### T6 — Progress milestones reach `tasks/get` (Story 4)

1. Run T1 with faux providers slowed enough to observe stages.
2. Repeatedly call `tasks/get { taskId }` during the run.
3. **Verify**: `status` stays `working` and `statusMessage` advances through the fan-out/analysis/synthesis milestones; ends at `completed`.

### T7 — Idempotent terminal result (INV-5)

1. Run T1 to completion; call `tasks/result { taskId }` twice more.
2. **Verify**: identical `CallToolResult` each time; no re-execution (no new `sub_calls`).

## End-to-end (real client, real providers) — manual

These prove SC-001 (the actual user-visible win) and can't be fully automated deterministically.

### E1 — No client-side timeout on a long fusion (SC-001, SC-002)

1. From the ZCode/codex harness, invoke the `fusion` tool with a prompt known to take ~60–140s (e.g. a multi-paragraph synthesis question against the real configured candidates).
2. **Verify**: the harness does NOT report a tool timeout (the pre-feature symptom). Instead the call returns promptly with a task handle and the final answer is delivered via the Tasks fetch.
3. Cross-check the DB: one `activities` row with the correct prompt excerpt and a terminal status; `total_latency_ms` reflecting the real ~60–140s.

### E2 — Dashboard parity (SC-003)

1. After E1, open `http://localhost:9077`.
2. **Verify**: the fusion appears in the activity log with the usual per-candidate + two-judge-step breakdown — indistinguishable from a blocking-path fusion.

## Existing-suite regression gate

- **`pnpm test`** must remain green (57 tests as of writing). The blocking-path tests (the existing `tests/mcp-server.test.ts` fusion handler tests) must pass unchanged — they exercise the non-augmented fallback and prove FR-008.

## Expected outcomes (success = feature done)

- T1–T7 pass deterministically; existing 57 tests pass (SC-004).
- E1 shows no client timeout on a ~90s fusion (SC-001) and synchronous task creation < ~2s (SC-002).
- E2 shows dashboard parity (SC-003).
- Non-Tasks fallback (T2) returns the same `CallToolResult` as before (SC-005).
