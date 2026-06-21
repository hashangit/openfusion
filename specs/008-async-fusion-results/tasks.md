---

description: "Task list for feature 008-async-fusion-results"
---

# Tasks: Async Fusion Results via Deferred Retrieval

**Input**: Design documents from `/specs/008-async-fusion-results/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/resume-from.md, quickstart.md — all present.

**Tests**: INCLUDED. quickstart.md defines T1–T14 + E1 validation scenarios; project convention is tests written alongside implementation per story (Vitest + pi-ai `registerFauxProvider`).

**Organization**: Tasks grouped by user story (US1–US3) for independent implementation + testing. **MVP = Phase 3 (US1) + Phase 4 (US3)** — delivers the codex/ZCode timeout fix with restart-safe durability. Phase 5 (US2, sequential retrieval) is gated on spec 007's `computeSerialBudgetMs`; tests are written and `it.skip`'d if 007 is absent.

**Branch prerequisite**: create branch `008-async-fusion-results`. Feature 005's detached runner (`src/fusion/task-runner.ts`), the Tasks-capable `fusion` registration (`src/server/mcp-server.ts:189-232`), and `allocateActivity` (`src/store/activity.ts:94`) are the assumed baseline.

**Empirical gate**: research.md R-001 (is codex's ~60s timeout per-call or session-level?) is resolved in Phase 1 (T002). If it fails, only `RESUME_LONG_POLL_MS` (T011) adjusts — see R-001 fallback.

## Format: `[ID] [P?] [Story?] Description (file path)`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks in the same phase)
- **[USx]**: user story label (story phases only)
- Every task carries an exact file path

## Path Conventions

Single project (per plan.md Project Structure): `src/fusion/`, `src/server/`, `src/store/`, `tests/`, plus surgical edits to `src/server/mcp-server.ts`, `src/fusion/task-runner.ts`, `src/store/db.ts`.

---

## Phase 1: Setup

**Purpose**: Confirm the branch + baseline, and close the R-001 empirical gate *before* any retrieval timing is locked.

- [ ] T001 Create + checkout branch `008-async-fusion-results`. Confirm the 005 baseline is present: `src/fusion/task-runner.ts` exports `startDetachedFusion` + `drainTasks` + the `taskActivity` map + `TASK_TTL_MS = 10 * 60_000`; `src/server/mcp-server.ts:189-232` registers `fusion` via `server.experimental.tasks.registerToolTask` with `taskSupport: "optional"`; `src/store/activity.ts:94` `allocateActivity` returns a UUID `activities.id`; `src/store/db.ts` applies migrations at open. Confirm `fusionInputSchema` (`src/server/mcp-server.ts:35-49`) has no `_resume_from` yet.
- [ ] T002 Resolve research.md R-001 (EMPIRICAL GATE) using BOTH a source trace AND a diagnostic harness (the harness proves observed behavior, the trace proves the mechanism — both required before retrieval timing is locked):
  (a) **Source trace**: in codex's `codex-rs/rmcp-client/src/rmcp_client.rs` `call_tool()` and the dispatch in `codex-rs/core/src/mcp_tool_call.rs`, confirm the ~60s `active_time_timeout` wraps `run_service_operation` per-`tools/call` (each call gets a fresh window) and that NO wrapping session/turn-level deadline spans multiple tool calls.
  (b) **Diagnostic harness** (~15 min): register a probe MCP tool that `sleep`s N seconds, call it through codex with escalating durations (5s, 30s, 55s, 65s) — confirm (1) is the timeout per-call? (2) does it reset between calls? (3) is there a cumulative turn/session budget across N calls? (4) what error does the agent see after a timeout, and does the next call work?
  Record findings in `specs/008-async-fusion-results/research.md` with file:line evidence + harness results. **If a session/turn budget exists**: the R-001 fallback becomes THE primary design (fire-and-forget-for-all: retrieval returns `processing` immediately, no long-poll), not a contingency — rebuild T011/T012/T008 against that.

**Checkpoint**: on branch `008-async-fusion-results`, 005 baseline confirmed, R-001 resolved. Retrieval timing can now be locked.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared durable layer every story reads from — the SQLite migration + the resume store (CRUD + bounded-long-poll waiter) + the mode-aware shape builders. **No user-story work can begin until this phase is complete.**

- [ ] T003 Add the `fusion_jobs` migration to `src/store/db.ts` (additive, `CREATE TABLE IF NOT EXISTS`, per data-model.md §"Durable record"): columns `activity_id TEXT PRIMARY KEY`, `status TEXT NOT NULL`, `execution_mode TEXT NOT NULL`, `result TEXT`, `result_is_error INTEGER NOT NULL DEFAULT 0`, `error_kind TEXT`, `created_at TEXT NOT NULL`, `completed_at TEXT`, `expires_at TEXT NOT NULL`, `last_progress_at TEXT`, `eta_ms INTEGER`, `retrieved_at TEXT` (F3 — null until first `_resume_from` returns a terminal result; drives the never-retrieved counter), with `FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE` + indexes on `status`, `expires_at`, and `completed_at`. Apply alongside the existing migrations at DB open. **n15 — confirm the connection has `PRAGMA busy_timeout=5000` set** (WAL is already enabled per AGENTS.md; busy_timeout prevents `SQLITE_BUSY` errors under concurrent retrieval + runner writes). Add a smoke test that opens a fresh temp DB and confirms the table exists with the expected columns.
- [ ] T004 [P] Create `src/fusion/resume-store.ts` (NEW) per data-model.md + research.md R-005/R-006: (a) `kickoffJob({activityId, executionMode, etaMs})` — inserts a row `status='processing'`, `created_at=now`, `expires_at=now+RESUME_TTL_MS`, `last_progress_at=now`, `retrieved_at=null` (`etaMs` is `null` for parallel mode per F7 — see data-model.md); (b) `getJob(activityId)` — reads a row, lazily reclassifying `processing` rows past a restart heuristic or `completed/error/interrupted` rows past TTL to `interrupted`/`expired` on read; (c) `markTerminal(activityId, {ok, result, errorKind})` — sets `status`/`result`/`result_is_error`/`error_kind`/`completed_at`, resolves all in-memory waiters for that id, defends the write-late race (R-006 option b: if still `processing`, extend `expires_at` before storing; if already evicted, drop); (d) `markRetrieved(activityId)` — sets `retrieved_at=now` on first terminal retrieval (idempotent; drives the never-retrieved counter, F3); (e) `awaitTerminal(activityId, waitMs)` — the bounded long-poll: if already terminal, set `retrieved_at` and return immediately; else add a waiter to the in-memory `Map<activityId, resolver[]>`, race vs `setTimeout(waitMs)`, set `retrieved_at` on resolve-or-timeout-if-terminal, return the job; (f) `touchProgress(activityId)` — updates `last_progress_at`; (g) `sweepInterrupted(bootTime)` — `UPDATE … SET status='interrupted' WHERE status='processing' AND created_at < bootTime` (called at startup); (h) `sweepExpired()` — `UPDATE … SET status='expired' WHERE status IN ('completed','error','interrupted') AND expires_at < now`, logging a counter when a `completed` row transitions to `expired` with `retrieved_at IS NULL` (the never-retrieved signal, F3). Module constants `RESUME_TTL_MS = 1_800_000`, `RESUME_LONG_POLL_MS = 40_000` (subject to T002), `RESUME_STALL_MS = 300_000`. Pure DB + Promise logic; no fusion imports.
- [ ] T005 [P] Create `src/fusion/resume-shapes.ts` (NEW) per contracts/resume-from.md — pure functions over `(job, configSnapshot)` returning the `{content, _meta}` pair for each outcome (m10 — `_meta = { reference_id, retry_after_ms }`): `parallelKickoff(activityId, retryAfterMs)`, `sequentialKickoff(activityId, etaMs, retryAfterMs)`, `parallelProcessing(activityId, retryAfterMs)`, `sequentialProcessing(activityId, remainingMs, retryAfterMs)`, `completed(answer)`, `errorJudgeFailed(activityId, message)`, `errorGeneric(activityId, message)`, `interrupted(activityId)`, `expired(activityId)`, `notFound(id)`. Wording matches contracts/resume-from.md verbatim — **transparent pacing** (M4: retrieval mandate + `retry_after_ms` in prose, NO "do not inform the user" directive), terse for parallel, user-facing for sequential. No I/O — trivially unit-testable.

**Checkpoint**: Foundation ready. `fusion_jobs` table migrates cleanly; `resume-store` reads/writes/waits; `resume-shapes` builds every outcome string. User-story implementation can now proceed.

---

## Phase 3: User Story 1 — Parallel retrieval: no timeout for non-Tasks clients (Priority: P1) 🎯 MVP

**Goal**: A non-Tasks client (codex/ZCode) calling `fusion({prompt})` gets an immediate `processing` result with a reference id; `fusion({_resume_from})` bounded-long-polls and returns the answer. Tasks-aware clients are unaffected.

**Independent Test** (quickstart T1–T5): kickoff ≈1s with `processing` + transparent-pacing wording + `retry_after_ms` in prose AND `_meta`; retrieval long-polls and returns `completed` byte-identical to the blocking path; already-completed returns immediately; long-poll timeout returns `processing`; Tasks client still gets `CreateTaskResult`.

### Tests for User Story 1

- [ ] T006 [P] [US1] Test T1 — kickoff immediate (`tests/resume-parallel.test.ts`): non-Tasks `fusion({prompt})` with a slow faux provider returns within ~1s; result text matches `parallelKickoff` (contains `reference_id:`, the retrieval mandate `Call fusion({ "_resume_from"…})`, the `retry after approximately N seconds` pacing line; does NOT contain any "do not inform the user" directive — M4); `_meta.reference_id` equals the text id and `_meta.retry_after_ms ≈ 30000`; a `fusion_jobs` row exists `status='processing'`, `execution_mode='parallel'`; the reference id in the text equals `activities.id` (INV-2).
- [ ] T007 [P] [US1] Test T2 + T3 — retrieval completed + fast-path (`tests/resume-parallel.test.ts`): (a) `_resume_from` while in flight, faux provider finishes ~5s into the wait → returns the synthesized answer, byte-identical to the synchronous path for the same faux inputs (SC-006); row now `status='completed'`. (b) `_resume_from` >10s after completion → returns immediately (no wait) with the same answer (SC-003).
- [ ] T008 [P] [US1] Test T4 — long-poll timeout → processing + SC-002 round-trip budget (`tests/resume-parallel.test.ts`): (a) faux provider slower than `RESUME_LONG_POLL_MS`; `_resume_from` returns after ~`RESUME_LONG_POLL_MS` with `parallelProcessing` wording; row still `processing`; a second retrieval after completion returns `completed` (loop works across calls). (b) **SC-002 count assertion (F1)**: for a ~90s faux fusion (`RESUME_LONG_POLL_MS=40s`), count kickoff + retrieval calls until the answer is returned and assert the total is **≤ 3** (1 kickoff + ≤2 retrievals). This guards against a regression that tightens the long-poll wait and inflates the LLM round-trip count.
- [ ] T009 [P] [US1] Test T5 — Tasks-path coexistence (`tests/resume-parallel.test.ts`): a Tasks-aware call (sends `params.task`) returns a `CreateTaskResult` (not the `_resume_from` kickoff shape); retrieval via `tasks/result` returns the same answer as T007a for identical inputs (FR-013, FR-015, SC-007). Existing 005-era task tests stay green.

### Implementation for User Story 1

- [ ] T010 [US1] Add `_resume_from: z.string().optional()` to `fusionInputSchema` and make `prompt` optional (with a runtime presence check in the kickoff branch) in `src/server/mcp-server.ts:35-49`. Add one line to `FUSION_DESCRIPTION` mentioning the retrieval param. Update the `createTask` handler's `args` type to include `_resume_from`.
- [ ] T011 [US1] Add the kickoff branch for non-Tasks clients in `src/server/mcp-server.ts`: when a `tools/call` arrives WITHOUT `params.task` and WITHOUT `_resume_from`, run a cheap synchronous `isConfigured` pre-check (F4 — see T013b for the mechanism); if unconfigured, open the dashboard (matching the blocking-path UX) and return the error shape immediately. Otherwise allocate the activity (`allocateActivity`), `kickoffJob({activityId, executionMode:'parallel', etaMs:null})` (F7 — parallel stores no ETA), dispatch `startDetachedFusion` (modified per T013 to write the terminal result to `fusion_jobs`), and return immediately with `parallelKickoff(activityId)`. This replaces the SDK's blocking `handleAutomaticTaskPolling` fallback for the fusion tool. If T002 found a session-level timeout, return `processing` with NO long-poll wiring in T012 (R-001 fallback).
- [ ] T012 [US1] Add the retrieval branch in `src/server/mcp-server.ts`: when `_resume_from` is present, call `awaitTerminal(id, RESUME_LONG_POLL_MS)` (or immediate return under the R-001 fallback), read the job, and map status → shape via `resume-shapes` (`completed`/`parallelProcessing`/`error*`/`interrupted`/`expired`/`notFound`). `prompt`/`context`/`persona` are ignored. No new fusion is started. Single retrieval site (INV-1).
- [ ] T013 [US1] Modify `startDetachedFusion` in `src/fusion/task-runner.ts` so the terminal handler also calls `resume-store.markTerminal(activityId, {ok, result, errorKind})` alongside the existing `taskStore.storeTaskResult` (shared substrate, research.md R-008). The `errorKind` comes from `FusionResult.errorKind` (added in T013a) so FR-014's judge-failed vs no-survivors distinction flows through structurally. The `taskActivity` map + `taskStore` path stay for Tasks clients; the `markTerminal` write serves `_resume_from`. Wire the runner's `onProgress` to also call `resume-store.touchProgress(activityId)` (feeds the stalled circuit, T019). **m12 — write ordering**: insert the `fusion_jobs` kickoff row FIRST (in `kickoffJob`, before `taskStore.createTask`); `taskStore` failure is non-fatal (log + continue — the `_resume_from` path is canonical, the Tasks path falls back to SDK blocking if the store write drops). **n13 — optimistic guard**: `markTerminal`'s terminal UPDATE is `UPDATE … SET status=… WHERE activity_id=? AND status='processing'` — if the startup sweep already reclassified a job `interrupted`, the WHERE won't match, the update silently no-ops (check `changes === 0`, log a warning). Defends against a surviving runner writing `completed` over a sweep's `interrupted`.
- [ ] T013a [US1] Extend `FusionResult` in `src/fusion/fusion.ts` with an **additive optional** field `errorKind?: "no-survivors" | "judge-failed" | "internal"` (F5 — required for FR-014; the current `status: "error"` + text `error` collapses both failure modes). Set it at each failure site in `runFusion`: `"no-survivors"` at the `<2 survivors` gate; `"judge-failed"` when `runAnalysis`/`runSynthesis` throws; `"internal"` in the outer catch. Default absent for `ok:true` results. **This is additive only** — existing callers (the blocking MCP path, the 005 Tasks path, the UI path) ignore the field; no caller breaks. Verify 007's `runSequentialFanout` (which returns `WorkerResult[]`, consumed by the unchanged gate) is unaffected. This is the load-bearing change that makes FR-014 implementable.
- [ ] T013b [US1] Define the openBrowserOnNeedsConfig mechanism for the `_resume_from` kickoff (F4): the detached `runFusion` runs *after* kickoff returns, so the kickoff cannot observe its `needsConfig`. The fix is a cheap synchronous pre-check — call `isConfigured(loadConfig(), paths.secrets(), paths.masterKey())` at kickoff (before `allocateActivity`); if unconfigured, call `maybeOpenBrowser()` and return the same error shape the blocking path returns, WITHOUT allocating a `fusion_jobs` row or dispatching the runner. This matches the blocking-path UX (browser opens on first-run misconfig) and avoids the 005 regression (silently dropped on the task path). Document that a config-becomes-invalid mid-flight fusion still surfaces its error via the retrieval path (`errorGeneric`), just without the browser pop.
- [ ] T014 [US1] Run T006–T009 green. Manually verify a real non-Tasks harness call returns ≈1s on kickoff (F6 — honest target, not "sub-second").

**Checkpoint**: User Story 1 functional + independently testable. **MVP part 1** — the codex/ZCode timeout is fixed for parallel fusions. Stop and validate before US3.

---

## Phase 4: User Story 3 — Durability & restart recovery (Priority: P1)

**Goal**: A restart mid-fusion produces a defined `interrupted` outcome (never a hang); a completed-before-restart result is retrievable within TTL; live progress is ephemeral (no stale rows). The write-late guard and stalled circuit bound the failure modes.

**Independent Test** (quickstart T9–T11): `fusion_jobs` row exists from kickoff; post-restart retrieval of a completed job returns it; post-restart retrieval of an in-flight job returns `interrupted`; no stale live progress after restart.

### Tests for User Story 3

- [ ] T015 [P] [US3] Test T9 — row exists from kickoff (`tests/resume-durability.test.ts`): immediately after any kickoff (parallel or sequential), `fusion_jobs` has the row `status='processing'` with timestamps set (INV-3). Assert for both modes (no mode-specific storage branch — R-002).
- [ ] T016 [P] [US3] Test T10 — post-restart completed retrieval (`tests/resume-durability.test.ts`): complete a fusion, then simulate restart (close DB, clear in-memory waiters + progress maps, reopen DB, run `sweepInterrupted`); `_resume_from` returns the `completed` answer from `fusion_jobs.result` (FR-009). Empty waiters map does not matter (job is terminal).
- [ ] T017 [P] [US3] Test T11 — post-restart interrupted (`tests/resume-durability.test.ts`): kick off a fusion, restart mid-flight (same simulation); the startup sweep marks the row `interrupted`; `_resume_from` returns the `interrupted` shape (re-run instruction), never a hang/unhandled error (FR-009, R-007). Assert live candidate-progress is absent after restart (FR-010 — no stale "running" affordance).

### Implementation for User Story 3

- [ ] T018 [US3] Wire the startup sweep in the server boot path (`src/index.ts` or wherever the DB is opened for the MCP server, mirroring how `openDatabase` is called): after `openDatabase`, call `resume-store.sweepInterrupted(new Date().toISOString())` once. Cheap, bounded by in-flight count. This is what makes T011's `interrupted` outcome appear after a real restart. **B3 — startup ordering (BLOCKER)**: the sweep MUST complete as a blocking init step BEFORE the MCP transport accepts connections / before `createMcpServer` resolves its connect promise. Without this, there's a race where a post-restart retrieval hits stale `processing` rows from the previous process before the sweep marks them `interrupted`. Await the sweep, then connect.
- [ ] T019 [US3] Implement the stalled-job circuit (FR-012, R-006) in `src/fusion/resume-store.ts` `getJob`/`awaitTerminal`: if `status='processing'` AND `now - last_progress_at > RESUME_STALL_MS`, reclassify to `status='error', error_kind='stalled'` (and resolve waiters) so the next retrieval returns the `errorGeneric` shape rather than empty long-polls forever. `touchProgress` (wired in T013) keeps `last_progress_at` fresh during healthy runs.
- [ ] T020 [US3] Verify the write-late guard (FR-011, R-006 option b) in `markTerminal` (T004): a job whose `expires_at` is reached near completion must still store its result — `markTerminal` extends `expires_at` for `processing` rows before storing, so a late completion never lands as `expired`. Verify the ephemeral-progress invariant: the live progress map (shared with spec 007's status surface) is in-memory only and is NOT consulted by retrieval nor persisted. Run T015–T017 green.

**Checkpoint**: User Story 3 functional. **MVP complete** — US1 + US3 together deliver a timeout fix that survives restarts. The headline SC-001 is now reachable on a live process; E1 (T029) validates it end-to-end.

---

## Phase 5: User Story 2 — Sequential retrieval shape (Priority: P1, gated on spec 007)

**Goal**: In sequential mode (spec 007), kickoff returns ETA + dashboard link with user-facing wording; retrieval is ETA-guided (immediate, no tight-poll). **Gated on spec 007's `computeSerialBudgetMs` + live-status surface.** If 007 is not yet implemented, write the tests as `it.skip` with a reference and implement the shapes defensively (they compile + are unit-tested, but the dispatch reads `executionMode='sequential'` only when 007 supplies it).

**Independent Test** (quickstart T6–T8): sequential kickoff includes ETA + dashboard URL + user-facing wording; sequential retrieval is immediate with refined ETA; retrieval after completion returns the answer.

### Tests for User Story 2

- [ ] T021 [P] [US2] Test T6 — sequential kickoff ETA + dashboard link (`tests/resume-sequential.test.ts`, `it.skip` if spec 007's `computeSerialBudgetMs` absent): `executionMode='sequential'`, N=4; kickoff text contains `reference_id`, `approximately <ETA_MIN> minutes` (matching `computeSerialBudgetMs(4)`), the dashboard URL, and a `retry_after_ms` = `max(eta/4, 60000)`; wording is user-facing (terse parallel shape would be wrong); `fusion_jobs.execution_mode='sequential'`, `eta_ms` matches the formula.
- [ ] T022 [P] [US2] Test T7 + T8 — sequential retrieval immediate + completed + SC-005 cadence (`tests/resume-sequential.test.ts`, `it.skip` if 007 absent): (a) `_resume_from` while running returns **immediately** (no long-poll — SC-005 cadence) with `sequentialProcessing` (refined remaining ETA + dashboard link); (b) `_resume_from` after completion returns the `completed` answer, byte-identical to the parallel path for the same inputs; (c) **SC-005 count assertion (F2)**: for a simulated ~15-min sequential fusion (staged via a faux provider summing to `computeSerialBudgetMs(4)`), count kickoff + retrieval calls and assert the total is **single-digit (≤ ~5)** — kickoff + one ETA-guided retrieval near completion (+tolerance), not tight-polling. This guards against a regression that makes sequential retrieval tight-loop (the SEP-1686 token-storm cliff).

### Implementation for User Story 2

- [ ] T023 [US2] Implement the sequential kickoff/retrieval shapes in `src/fusion/resume-shapes.ts` (T005 created the signatures; this fills the ETA/dashboard logic): `sequentialKickoff` derives `eta_ms` from `computeSerialBudgetMs(N)` (import from `src/fusion/fanout.ts` — spec 007; guard the import so 008 compiles standalone if 007 is absent, e.g. dynamic import or a feature-detect). `sequentialProcessing` computes remaining ETA from `eta_ms - elapsed`. Dashboard URL = `http://127.0.0.1:9077/?activity=<id>` (contracts/resume-from.md).
- [ ] T024 [US2] Wire mode-aware dispatch in `src/server/mcp-server.ts` kickoff (T011) + retrieval (T012) branches: read `execution_mode` from the config snapshot at kickoff (parallel today; sequential when 007 is active); kickoff calls `parallelKickoff` vs `sequentialKickoff`; retrieval calls `awaitTerminal` for parallel but returns `sequentialProcessing` **immediately** for sequential (no long-poll — FR-005). If 007 is absent, only the parallel branch is reachable and the sequential branch is dead-but-compiling. Run T021–T022 (skipped or green per 007 availability).

**Checkpoint**: User Story 2 ready (or skipped-pending-007). All three stories complete; the feature serves both execution modes.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, the end-to-end validation, and docs.

- [ ] T025 [P] Test T12 — unknown/expired id (`tests/resume-edge-cases.test.ts`): `_resume_from` for a never-existed id → `notFound` shape immediately, no throw; `_resume_from` for a TTL-expired id → `expired` shape, row reclassified (FR-003, FR-008).
- [ ] T026 [P] Test T13 — write-late guard under TTL race (`tests/resume-edge-cases.test.ts`): stage a faux provider delay equal to `RESUME_TTL_MS` so completion coincides with eviction; the write-late guard (T020) extends `expires_at` while `processing`, so the late completion stores correctly; retrieval returns `completed`, not `expired` (FR-011).
- [ ] T027 [P] Test T14 — stalled circuit + judge-failure distinction (`tests/resume-edge-cases.test.ts`): (a) faux provider hangs (no progress > `RESUME_STALL_MS`) → next `_resume_from` returns `errorGeneric` with `error_kind='stalled'` (FR-012); (b) ≥2 candidates succeed but judge throws → retrieval returns `errorJudgeFailed` (distinct wording), `fusion_jobs.error_kind='judge-failed'`, `result_is_error=1`; worker `sub_calls.generated_text` rows exist for forensic join (FR-014).
- [ ] T028 [P] Update the fusion tool description in `src/server/mcp-server.ts` (`FUSION_DESCRIPTION`, ~line 64) to mention `_resume_from` in one line so agents discover the retrieval param from the schema. Re-run the 006 `fusion description trims tokens` test to confirm it still passes (the description must stay under `PRE_006_FUSION_DESCRIPTION.length`).
- [ ] T029 E1 — end-to-end against a real non-Tasks client (SC-001, quickstart E1): with real provider keys configured (≥2 candidates + judge) and a stdio traffic capture, drive `fusion({prompt})` through codex (or a faithful no-`params.task` harness) for a genuine ~90s fusion. Verify: kickoff returns ≈1s (capture timestamp); no ~60s client timeout fires; the agent follows the instruction and calls `fusion({_resume_from})`; the user receives the synthesized answer. **This is the headline success criterion.** If it fails and T002 confirmed a per-call timeout, debug the retrieval wiring; if T002 found a session timeout, confirm the R-001 fallback is active.
- [ ] T030 [P] Update `AGENTS.md` "Known limitations" + `specs/008-async-fusion-results/` changelog note: document that the `_resume_from` path is the non-Tasks client fix (codex/ZCode), that 005's Tasks path is preserved for Tasks-aware clients, and that the in-memory→SQLite durability upgrade revises 005's non-durability stance for the retrieval use case. Also document the **never-retrieved counter** (F3): `sweepExpired` (T004h) logs whenever a `completed` row ages out with `retrieved_at IS NULL` — this is the observability signal for abandoned compute (Constitution V) and the leading indicator that codex has shipped native Tasks support (the counter drops to ~0 when clients stop using `_resume_from`). Add a `CHANGELOG.md` entry under the next version. Run the full test suite green (`pnpm test`).

**Checkpoint**: Feature complete. All quickstart scenarios pass (T1–T14 + E1); edge cases covered; docs current.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 (branch) → T002 (R-001 gate). T002 BLOCKS T011/T012 timing decisions.
- **Foundational (Phase 2)**: T003 (migration) → T004/T005 (parallelizable stores/shapes). BLOCKS all user stories.
- **US1 (Phase 3)**: depends on Phase 2. T010 → T011/T012 (dispatch branches) → T013 (runner wiring) → T006–T009 (tests, parallelizable).
- **US3 (Phase 4)**: depends on Phase 2 + T013 (runner writes terminal to `fusion_jobs`). T018/T019/T020 (parallelizable) → T015–T017 (tests).
- **US2 (Phase 5)**: depends on Phase 2 + spec 007's `computeSerialBudgetMs`. T023 → T024 → T021/T022 (skipped if 007 absent).
- **Polish (Phase 6)**: T025/T026/T027/T028 parallelizable after US1+US3; T029 (E1) after US1+US3 minimum; T030 last.

### User Story Dependencies

- **US1 (P1)**: depends on Foundational only. The core timeout fix.
- **US3 (P1)**: depends on Foundational + T013 (runner terminal write). Makes US1 restart-safe. **US1 + US3 = MVP.**
- **US2 (P1)**: depends on Foundational + spec 007. Independently testable (skipped-pending-007).

### Parallel Opportunities

- Phase 2: T004 (resume-store) ∥ T005 (resume-shapes) — different files, no cross-deps.
- Phase 3 tests: T006 ∥ T007 ∥ T008 ∥ T009 — all in the same test file but logically independent assertions; can be written together.
- Phase 4: T018 (sweep wiring) ∥ T019 (stalled circuit) ∥ T020 (write-late verify) — different concerns in overlapping files; sequence if same file conflicts.
- Phase 6: T025 ∥ T026 ∥ T027 ∥ T028 — different test files / one description edit.

---

## Implementation Strategy

### MVP First (US1 + US3)

1. Phase 1: confirm baseline + resolve R-001 (T001, T002).
2. Phase 2: migration + resume-store + resume-shapes (T003–T005).
3. Phase 3: US1 — parallel kickoff + retrieval + bounded long-poll (T006–T014).
4. Phase 4: US3 — startup sweep + stalled circuit + write-late guard (T015–T020).
5. **STOP and VALIDATE**: run T029 (E1) against a real non-Tasks client. This is SC-001 — the production-visible win.

### Incremental Delivery

1. Foundation → durable store ready, no behavior change yet.
2. + US1 → parallel fusions no longer time out on codex/ZCode (MVP part 1).
3. + US3 → long fusions survive restarts; failure modes bounded (MVP complete).
4. + US2 → sequential fusions (spec 007) reachable from non-Tasks clients (when 007 lands).
5. + Polish → edge cases + E1 + docs.

### R-001 Fallback (if T002 finds a session-level timeout)

Only T011/T012 change: the kickoff still returns `processing` immediately (safe under any timeout model), but retrieval returns `processing` **immediately** (no `awaitTerminal` long-poll) and relies on `eta_ms` for the agent to pace itself. `resume-store.awaitTerminal` stays implemented (used by US3 tests + future Tasks clients) but is not called on the non-Tasks retrieval path. Everything else — durability, restart recovery, shapes, edge cases — is unaffected.

---

## Notes

- **Identity**: `reference_id = activity_id` (INV-2). No new id space. The 005 `taskActivity` map stays for the Tasks path only.
- **005 preservation**: the `createTask`/`getTask`/`getTaskResult` handlers (mcp-server.ts:227-230) are NOT modified. `_resume_from` is a sibling branch. Shared substrate = `startDetachedFusion` + the new `fusion_jobs` terminal write (T013).
- **No new deps / no config migration / no new MCP capability** (constitution VII). `_resume_from` is a plain tool argument.
- **`prompt` becomes optional** in the schema (T010) — the kickoff branch enforces presence at runtime. This is the one schema weakening; it's required so the agent doesn't resend the full prompt on every poll (FR-002).
- **Live progress is never persisted** (FR-010). Only `last_progress_at` (a timestamp) is durable, and only for the stalled circuit.
- Commit after each task or logical group. Stop at any checkpoint to validate.
