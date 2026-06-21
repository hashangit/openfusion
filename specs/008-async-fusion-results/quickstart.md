# Quickstart: Async Fusion Results via Deferred Retrieval

**Feature**: 008-async-fusion-results | **Phase**: 1 | **Date**: 2026-06-19

Runnable validation scenarios that prove the feature works end-to-end. Each scenario lists prerequisites, the action, and the expected outcome — cross-referencing the contract shapes in [`contracts/resume-from.md`](./contracts/resume-from.md) and the data model in [`data-model.md`](./data-model.md). Implementation code lives in `tasks.md` (Phase 2), not here.

**Test stack**: Vitest; pi-ai `registerFauxProvider()` for deterministic fusion timing. The synthetic non-Tasks client is a harness that calls the fusion tool handler directly with no `params.task` and no `_resume_from` (kickoff) or with `_resume_from` set (retrieval) — it never touches the SDK's task machinery, faithfully reproducing codex/ZCode behavior.

---

## Prerequisites (all scenarios)

- A temp DB with the `fusion_jobs` migration applied (the additive `CREATE TABLE` from `data-model.md`).
- A faux provider registered with a configurable delay (so tests can stage `processing` vs `completed` deterministically).
- ≥2 enabled candidates + 1 enabled judge configured (so the config gate passes).
- The fusion tool handler wired to the detached runner + the new `resume-store`.

---

## Parallel mode (US1) — T1–T5

### T1 — Kickoff returns immediately with a `processing` result

**Prerequisites**: parallel mode (default); faux provider delay set high enough that the fusion will not finish within the kickoff call.

**Action**: call `fusion({ prompt: "…" })` from the synthetic non-Tasks client (no `params.task`, no `_resume_from`).

**Expected**:
- The call returns within a small constant (well under 1 s).
- The result text matches the parallel kickoff shape ([`contracts/resume-from.md`](./contracts/resume-from.md#parallel-mode)): contains `reference_id: <ID>`, the retrieval mandate `Call fusion({ "_resume_from": "<ID>" })`, and a `retry after approximately N seconds` pacing line. Does **not** contain any "do not inform the user" directive (M4). The structured `_meta` carries `{ reference_id, retry_after_ms ≈ 30000 }`.
- A `fusion_jobs` row exists for `<ID>` with `status='processing'`, `execution_mode='parallel'`, `created_at` set, `expires_at` = `created_at + RESUME_TTL_MS`.
- The `activities.id` equals the reference id in the text (INV-2).
- The detached fusion is running (observable via the in-memory waiters map or the active-tasks set).

### T2 — Retrieval bounded-long-polls and returns `completed`

**Prerequisites**: T1's fusion is in flight; faux provider delay set so the fusion finishes ~5 s into the long-poll window.

**Action**: call `fusion({ _resume_from: "<ID>" })`.

**Expected**:
- The call does not return immediately; it waits up to `RESUME_LONG_POLL_MS`.
- When the fusion finishes (within the wait), the call returns the `completed` shape — the synthesized answer text alone, byte-identical to what the legacy blocking path returns for the same inputs (SC-006).
- The `fusion_jobs` row is now `status='completed'`, `result` set, `completed_at` set.
- The waiter is resolved and removed from the in-memory map.

### T3 — Retrieval of an already-completed job returns immediately (fast-path)

**Prerequisites**: a fusion that completed >10 s ago (well past `completed_at`); within TTL.

**Action**: call `fusion({ _resume_from: "<ID>" })`.

**Expected**:
- The call returns immediately (no long-poll wait — SC-003).
- Returns the `completed` shape with the same answer.

### T4 — Retrieval times out the long-poll and returns `processing`

**Prerequisites**: fusion still in flight; faux provider delay longer than `RESUME_LONG_POLL_MS`.

**Action**: call `fusion({ _resume_from: "<ID>" })`.

**Expected**:
- The call returns after ~`RESUME_LONG_POLL_MS` with the parallel `processing` shape (transparent-pacing wording + `retry_after_ms`).
- The `fusion_jobs` row is still `processing`.
- A second retrieval (after the fusion finishes) returns `completed` — confirms the loop works across multiple calls.

### T5 — Tasks-aware client is unaffected (coexistence, FR-013/SC-007)

**Prerequisites**: a Tasks-aware synthetic client (sends `params.task`).

**Action**: call `fusion({ prompt: "…" })` with `params.task` set.

**Expected**:
- The call returns a `CreateTaskResult` immediately (005 behavior) — **not** the `_resume_from` kickoff shape.
- Retrieval is via the SDK's `tasks/get` + `tasks/result`, not via `_resume_from`.
- The synthesized answer matches T2's answer for the same inputs (FR-015).
- No regression: existing 005-era tests stay green.

---

## Sequential mode (US2) — T6–T8

> Gated on spec 007's `computeSerialBudgetMs` and live-status surface. If 007 is not yet implemented, these tests are written and skipped (`it.skip` with a reference to 007), not omitted.

### T6 — Sequential kickoff includes ETA + dashboard link

**Prerequisites**: sequential mode enabled; N=4 candidates (so `computeSerialBudgetMs(4)` yields a known ETA).

**Action**: call `fusion({ prompt: "…" })` from the synthetic non-Tasks client.

**Expected**:
- Returns immediately with the sequential kickoff shape: contains `reference_id`, `approximately <ETA_MIN> minutes` (matching the formula's output for N=4), the dashboard URL, and a `retry_after_ms` = `max(eta/4, 60000)`.
- The wording is user-facing and verbose (tells the user about the long duration + dashboard) — distinct from the terse parallel shape. Neither mode uses a "do not inform the user" directive (M4).
- `fusion_jobs.execution_mode='sequential'`, `eta_ms` matches the formula.

### T7 — Sequential retrieval is immediate + ETA-guided (not tight-poll)

**Prerequisites**: T6's fusion in flight.

**Action**: call `fusion({ _resume_from: "<ID>" })` while the fusion is still running.

**Expected**:
- Returns **immediately** (no long-poll wait — the sequential cadence is ETA-guided, FR-005).
- Returns the sequential `processing` shape with a refined `approximately <REMAINING_MIN> minutes remaining` and the dashboard link.
- A single retrieval well before the ETA does not tight-loop (verify call count stays low across the job — SC-005).

### T8 — Sequential retrieval after completion returns the answer

**Prerequisites**: T6's fusion has completed.

**Action**: call `fusion({ _resume_from: "<ID>" })`.

**Expected**: returns the `completed` shape (synthesized answer), byte-identical to the parallel path for the same inputs.

---

## Durability & restart (US3) — T9–T11

### T9 — `fusion_jobs` row exists from kickoff (INV-3)

**Prerequisites**: any kickoff (parallel or sequential).

**Action**: query `fusion_jobs` immediately after kickoff returns.

**Expected**: row exists with `status='processing'`, timestamps set. Same for both modes (no mode-specific storage branch — R-002).

### T10 — Post-restart retrieval of a completed result returns it (FR-009)

**Prerequisites**: a fusion completed before the restart; within TTL.

**Action**: restart the process (close + reopen the DB, clear in-memory maps); call `fusion({ _resume_from: "<ID>" })`.

**Expected**:
- Returns the `completed` shape with the same answer (read from `fusion_jobs.result`).
- The in-memory waiters map being empty does not matter (the job is already terminal).

### T11 — Post-restart retrieval of an in-flight job returns `interrupted` (FR-009, R-007)

**Prerequisites**: a fusion kicked off, then the process restarted mid-flight.

**Action**: restart; call `fusion({ _resume_from: "<ID>" })`.

**Expected**:
- The startup sweep has marked the row `interrupted`.
- The retrieval returns the `interrupted` shape (re-run instruction) — never a hang or unhandled error.
- Live candidate-progress is absent (no stale "running" affordance — FR-010).

---

## Edge cases — T12–T14

### T12 — Unknown / expired reference id (FR-003, FR-008)

**Prerequisites**: (a) an id that never existed; (b) an id whose TTL has expired.

**Action**: call `fusion({ _resume_from: "<ID>" })` for each.

**Expected**:
- (a) Returns the `not_found` shape immediately; no error thrown.
- (b) Returns the `expired` shape (re-run instruction); the row has been reclassified `expired`.

### T13 — TTL-vs-late-completion write-late guard (FR-011)

**Prerequisites**: a job whose `expires_at` is reached at the same moment as its completion (staged via a faux provider delay equal to the TTL).

**Action**: let the fusion complete; retrieve.

**Expected**:
- The result is stored correctly (not orphan-written, not discarded) — the write-late guard extended `expires_at` while status was `processing` (R-006 option b), so the late completion lands before eviction.
- Retrieval returns `completed`, not `expired`.

### T14 — Stalled-job circuit + judge-failure distinction (FR-012, FR-014)

**Prerequisites**: (a) a parallel fusion whose faux provider hangs (no progress > `RESUME_STALL_MS`); (b) a fusion where ≥2 candidates succeed but the judge throws.

**Action**: retrieve for each.

**Expected**:
- (a) The next `_resume_from` returns the `error` shape with `error_kind='stalled'` (not an empty long-poll forever) — the stalled circuit fired.
- (b) The retrieval returns the `error (judge-failed)` shape (distinct wording from a no-survivors error); `fusion_jobs.error_kind='judge-failed'`, `result_is_error=1`. Candidate `sub_calls.generated_text` rows exist for forensic join.

---

## E1 — End-to-end against a real non-Tasks client (SC-001)

> This is spec 005's never-run E1, re-scoped: it now validates the `_resume_from` path (the thing that actually fixes the codex timeout), not the Tasks path (which cannot help codex).

**Prerequisites**: OpenFusion configured with real provider keys (≥2 candidates + judge); a real fusion that takes ~90 s wall-clock (e.g. 3-5 cloud candidates). A stdio traffic capture between the client and the MCP server.

**Action**: drive `fusion({ prompt: "…" })` through a real non-Tasks client (codex or a faithful harness that sends no `params.task`).

**Expected**:
- The first `tools/call` returns ≈1s (capture shows the response timestamp).
- No client-side timeout fires (the ~60 s ceiling is never approached).
- The client's agent follows the instruction and calls `fusion({ _resume_from: "<ID>" })` — observable in the traffic capture.
- The user receives the synthesized answer.

**This is the headline success criterion** (SC-001). If it passes, the feature delivers the production-visible win feature 005 promised but could not. If R-001 (the per-call-timeout gate) is wrong, this test fails and the design falls back to fire-and-forget-for-all (R-001 fallback).

---

## R-001 verification (prerequisite to locking T2/T4 timing)

Before T2 and T4's `RESUME_LONG_POLL_MS` assertions are locked, complete R-001: trace codex's `run_service_operation` and the tool-call loop in `core/src/mcp_tool_call.rs` and confirm there is no wrapping session/turn-level deadline across tool calls. Record the finding in [`research.md`](./research.md) (append "R-001 verified"). Only then is the ~40 s default confirmed; otherwise switch to the R-001 fallback (fire-and-forget-for-all) and adjust T2/T4 accordingly.
