# Quickstart: Sequential Processing Option (Low-VRAM Local Models)

**Feature**: 007-sequential-processing | **Date**: 2026-06-19

Runnable validation scenarios proving the feature works end-to-end. Each scenario is independently testable. References [spec.md](./spec.md) requirements, [data-model.md](./data-model.md) fields, the [/api/runtime contract](./contracts/dashboard-status.md), and the budget semantics in [research.md](./research.md) R-002/R-003.

**Implementation bodies belong in `tasks.md`, not here.** This is a validation/run guide.

---

## Prerequisites

- OpenFusion configured: ≥2 enabled candidates + ≥1 enabled judge + keys for all referenced providers (constitution VI).
- Built with feature 007 changes; dev server running (`pnpm dev` or the built `dist/`).
- A way to drive fusions + read the DB: the Vitest suite with pi-ai `registerFauxProvider()` (deterministic; preferred for T1–T6, T8–T12), or a manual run against real/faux providers. The faux provider lets each candidate have a distinct, controllable latency — essential for asserting serial ordering (T1) and the budget gate (T4).
- For the dashboard widget scenarios (T7–T12): the dashboard running at `http://localhost:9077`, and a way to trigger a long-running fusion while observing `/api/runtime` (curl, the browser devtools network tab, or the widget itself).

---

## T1 — Sequential mode runs candidates one at a time, in slot order (SC-001, SC-005, FR-003, FR-010, FR-011)

**Goal**: the core ask — serial fan-out produces the same result structure as parallel, but candidates don't overlap.

**Steps**:
1. Configure 3 faux candidates with **distinct, staggered latencies** (e.g. c1=400ms, c2=300ms, c3=200ms) and a faux judge. Set `settings.executionMode = "sequential"`.
2. Instrument `runWorker` (or read sub_calls after) to capture each candidate's `[startMs, endMs]` window.
3. Trigger one fusion.
4. Read the activity row + its 3 worker sub_calls.

**Expected**:
- Fusion returns a synthesized answer (success).
- The 3 candidate windows are **non-overlapping** and **in slot order**: c1.end ≤ c2.start, c2.end ≤ c3.start. (In parallel mode the windows would overlap regardless of latency ordering.)
- `activities.candidate_count === 3`, `survivor_count === 3`, `status === "success"`.
- 5 sub_calls exist (3 workers + judge_analysis + judge_synthesis) — **identical row count to a parallel fusion of the same candidates** (SC-005).

---

## T2 — Parallel mode is byte-for-byte unchanged (SC-006, FR-002, INV-4)

**Goal**: the feature introduces zero behavioral drift in the default mode.

**Steps**:
1. Same 3 faux candidates + judge as T1, but `executionMode = "parallel"`.
2. Trigger one fusion; capture candidate windows + the activity/sub_call rows.
3. Repeat with an identical config from the **pre-feature** baseline (git stash / checkout the pre-007 fusion.ts) if available, or assert against the documented current behavior.

**Expected**:
- The 3 candidate windows **overlap** (they raced) — contrast with T1.
- The activity row + sub_calls are structurally identical to T1's (same fields, same counts).
- Identical answer text to what the same faux inputs produced before the feature (the dispatch branch is a pure scheduler; outputs are deterministic from faux inputs).

---

## T3 — Serial budget is computed from candidate count (SC-003, FR-005, FR-007, R-003)

**Goal**: the budget formula is deterministic and surfaced.

**Steps**:
1. With `executionMode = "sequential"`, set enabled candidates to N ∈ {2, 3, 5}.
2. For each N, call `computeSerialBudgetMs(N)` (or the UI helper equivalent) and read the Candidates-page helper text.

**Expected**:
- `computeSerialBudgetMs(N) === 180_000 * N + 360_000` (i.e. `PER_CANDIDATE_MS * N + JUDGE_STEPS_MS`).
- N=2 → 720_000 ms (12 min); N=3 → 900_000 ms (15 min); N=5 → 1_260_000 ms (21 min).
- The UI helper text shows "~Xm" matching the formula (e.g. N=3 → "~15 min").
- The UI-side `serialBudgetMinutes` and the engine-side `computeSerialBudgetMs` agree (assert `serialBudgetMinutes(N) * 60000 === computeSerialBudgetMs(N)` for N ∈ {2,3,5}).

---

## T4 — Budget exhaustion stops launching, proceeds with survivors (SC-001, FR-008, FR-009, R-002)

**Goal**: the serial budget gates *launching* the next candidate; the in-flight candidate is not aborted; the survivor gate still applies.

**Steps**:
1. Configure 4 faux candidates: c1=500ms (ok), c2=500ms (ok), c3=5000ms (ok, but slow), c4=any. Set `executionMode = "sequential"`.
2. Force a **tiny serial budget** for the test (e.g. inject a budget override of 1200ms, or use the test seam in `fanout.ts` to pass a custom `budgetMs`). This is a test-only seam; production uses `computeSerialBudgetMs`.
3. Trigger a fusion. With a 1200ms budget: c1 (500ms) finishes at ~500ms; c2 (500ms) finishes at ~1000ms; before launching c3, elapsed (~1000ms) < budget (1200ms) so c3 *starts*; c3 would finish at ~6000ms but budget (1200ms) elapses during c3 — **c3 is NOT aborted** (no AbortController), it runs to completion at ~6000ms; c4 is **never launched** (elapsed >> budget).
4. Read the activity row + sub_calls.

**Expected**:
- 3 worker sub_calls (c1, c2, c3) — c4 absent.
- c1, c2, c3 all `status=ok`.
- `survivor_count === 3` (≥2) → fusion proceeds to judging, returns a synthesized answer (status success/partial).
- c3's latency reflects its real run time (~5000ms), **not** the budget — confirming the budget doesn't abort the in-flight candidate.

**Variant (budget exhausted before ≥2 finish)**: set budget to 300ms with all candidates 500ms. c1 starts, budget elapses during c1, c1 finishes at ~500ms, c2/c3/c4 never launched. `survivor_count === 1` (<2) → fusion errors with the standard "only 1 of 4 candidates succeeded (minimum 2 required)" message (no hang, no new error shape).

---

## T5 — Per-worker timeout + 3-retry unchanged in serial mode (FR-008, INV-5)

**Goal**: a flaky/hanging candidate exercises the existing per-worker machinery identically in serial mode.

**Steps**:
1. Configure 3 faux candidates: c1=ok-fast, c2=fails-twice-then-ok (simulate via faux provider rejecting the first 2 calls), c3=ok. `executionMode = "sequential"`, `workerTimeoutMs = 5000`.
2. Trigger a fusion; instrument `withRetryTimeout` attempts for c2.

**Expected**:
- c2 makes 3 attempts (2 failures + 1 success) — the retry/timeout machinery fires identically to parallel mode.
- The serial budget accounts for this only via the outer gate (R-002): if c2's retries push total elapsed past the budget, later candidates may be skipped — but c2 itself is not cut short.
- Fusion succeeds with 3 survivors.

---

## T6 — Sequential × Benchmark both ON (SC-006, FR-016)

**Goal**: the two toggles are independent.

**Steps**:
1. Set `executionMode = "sequential"` AND `benchmarkMode = true`. Configure 6 candidates (Benchmark lifts the 5-cap; all 6 enabled).
2. Trigger a fusion; read candidate windows.

**Expected**:
- All 6 candidates run, **one at a time**, in slot order (serial holds).
- Benchmark's forced 10-min per-candidate timeout applies to each candidate (Benchmark holds).
- `computeSerialBudgetMs(6) === 180_000 * 6 + 360_000 === 1_440_000 ms` (24 min) — the serial budget scales with the Benchmark-permitted count (edge case in spec).
- Fusion completes (6 survivors → judge).

---

## T7 — Idle state when no fusion running (FR-012)

**Goal**: the widget shows idle by default.

**Steps**:
1. Ensure no fusion is in-flight (fresh server start, or wait for any prior fusion to finish).
2. `GET /api/runtime` (or open the Dashboard).

**Expected**:
- Response: `{ "state": "idle", "fusions": [] }`.
- Widget renders the idle affordance ("● Idle").

---

## T8 — Parallel in-progress affordance (FR-012, FR-013)

**Goal**: a parallel fusion shows "X of Y responding".

**Steps**:
1. `executionMode = "parallel"`. Configure faux candidates with a 2–3s latency each so the in-progress window is observable.
2. Trigger a fusion; while it runs, poll `GET /api/runtime` (or watch the widget).

**Expected**:
- `state === "in-progress"`, one fusion entry, `mode === "parallel"`, `candidateCount === N`.
- `candidatesDone` rises from 0 → N as candidates respond (observable across polls).
- `candidateIndex` is **absent** (parallel mode omits it).
- Widget shows "X of N candidates responding" updating live.
- On completion, returns to `idle`.

---

## T9 — Sequential in-progress affordance (FR-012, FR-013)

**Goal**: a serial fusion shows "candidate X of Y running".

**Steps**:
1. `executionMode = "sequential"`. Faux candidates with ~1s latency each (so each step is visible).
2. Trigger a fusion; poll `GET /api/runtime` during the run.

**Expected**:
- `state === "in-progress"`, one fusion entry, `mode === "sequential"`.
- `candidateIndex` increments 1 → 2 → … → N as candidates start (serial — only one at a time).
- `candidatesDone` increments as each resolves; `candidateIndex === candidatesDone + 1` mid-run (the next one is running).
- Widget shows "candidate X of N running (Y done)" + elapsed time.
- On completion, returns to `idle`.

---

## T10 — Queued state with >1 concurrent fusion (FR-014, R-005)

**Goal**: two fusions overlapping show as queued (no queue data structure — just observation).

**Steps**:
1. Trigger a **long** faux fusion (candidates with 3–5s latency, either mode). Before it finishes, trigger a **second** fusion (e.g. from a second client, or via the Generations page).
2. Poll `GET /api/runtime` while both are in-flight.

**Expected**:
- `state === "queued"`, `fusions.length === 2` (both entered, neither left).
- Each entry carries its own mode/candidateIndex/candidatesDone (they're independent fusions).
- Widget shows "● Queued — 2 fusions active" + a compact list.
- As each finishes, `fusions` shrinks; when the last leaves, `state` → `in-progress` is impossible with one, so it returns to `idle`.

---

## T11 — Registry enter ⇒ leave on every terminal path (INV-3, FR-012)

**Goal**: a fusion that errors or throws still leaves the registry (no stuck "in-progress").

**Steps**:
1. Configure a fusion that will **fail**: only 1 faux candidate returns ok (the others error) → `<2 survivors` error path.
2. Configure a second fusion that **throws** inside `runFusion` (test seam: inject a config that makes the judge model unresolvable, or throw in a test-only hook).
3. After each, poll `GET /api/runtime`.

**Expected**:
- After the error-path fusion: registry empty, `state === "idle"` (the `finally` ran `leave`).
- After the throw-path fusion: registry empty, `state === "idle"`.
- The activity row for each is recorded with its terminal status (error) — the durable record is correct even though the ephemeral status cleared.

---

## T12 — Focus refresh: no stale progress (FR-015, R-006)

**Goal**: re-focusing the dashboard tab refetches immediately; polling pauses when hidden.

**Steps**:
1. Start a long faux fusion. Open the Dashboard, observe the widget updating.
2. Switch browser tabs (Dashboard blurs/hidden). Wait 10s. Return to the Dashboard.
3. During the hidden period and on return, observe network requests to `/api/runtime`.

**Expected**:
- While hidden: no `/api/runtime` requests (interval paused).
- On `visibilitychange → visible`: an **immediate** `/api/runtime` fetch fires, so the widget shows current (non-stale) progress before the interval resumes.
- The resumed interval then continues at ≥2s.

---

## E1 — End-to-end manual: low-VRAM local scenario

**Goal**: a human-readable walkthrough of the feature's value (issue #2's actual use case).

**Setup**: a machine with Ollama running 2–3 local models that OOM when loaded simultaneously.

**Steps**:
1. Configure OpenFusion with 3 Ollama candidates + an Ollama (or cloud) judge.
2. In the Candidates page, toggle **Sequential Mode** ON. Note the helper text showing the ~total time (e.g. "~15 min").
3. Save. Trigger a fusion from an MCP client (e.g. "fusion: summarize this code").
4. Watch the Dashboard: the widget shows "candidate 1 of 3 running" → "2 of 3" → "3 of 3" → judging → done.
5. Observe (out of band, e.g. `ollama ps` or VRAM monitor) that only one model is resident at a time.

**Expected**: the fusion completes with a synthesized answer where (before the feature) it would have OOM'd or thrashed. The serial run took roughly the helper-text-predicted time.

---

## E2 — End-to-end manual: parallel default unaffected

**Goal**: confirm a cloud-only user sees no change.

**Steps**:
1. Leave `executionMode = "parallel"` (default). Configure 3 cloud candidates + judge.
2. Trigger a fusion.

**Expected**: candidates run concurrently (fast, as before); the widget shows "X of 3 responding" rising quickly to 3; fusion completes in the usual parallel time. No serial behavior, no budget applied.
