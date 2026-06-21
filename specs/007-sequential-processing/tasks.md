---

description: "Task list for feature 007-sequential-processing"
---

# Tasks: Sequential Processing Option (Low-VRAM Local Models)

**Input**: Design documents from `/specs/007-sequential-processing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/dashboard-status.md, quickstart.md — all present.

**Tests**: INCLUDED. quickstart.md defines T1–T12 + E1–E2 validation scenarios; the project convention is tests written alongside implementation per story (Vitest + pi-ai `registerFauxProvider`).

**Organization**: Tasks grouped by user story (US1–US3) for independent implementation + testing. **MVP = Phase 3 (US1) only** — delivers issue #2's core ask. US2 (serial budget) makes US1 reliable; US3 (status widget) makes long serial runs legible.

**Branch prerequisite**: branch `007-sequential-processing` already created (from 006's committed state). Feature 006's config plumbing (`personaPolicy`, `CONFIG_VERSION=4`, `migrateConfig` v3→v4) is assumed present as the migration precedent.

## Format: `[ID] [P?] [Story?] Description (file path)`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks in the same phase)
- **[USx]**: user story label (story phases only)
- Every task carries an exact file path

## Path Conventions

Single project (per plan.md Project Structure): `src/`, `src/fusion/`, `src/server/`, `src/server/api/`, `src/config/`, `ui/src/`, `ui/src/pages/`, `tests/`, `.specify/memory/`.

---

## Phase 1: Setup

**Purpose**: Confirm the branch + baseline. No new dependencies (constitution: no new SDK capability, no DB migration, no new runtime dep).

- [X] T001 Confirm branch `007-sequential-processing` is current; confirm the 006 baseline is present (`src/config/schema.ts` has `personaPolicy` + `CONFIG_VERSION === 4`; `src/fusion/fusion.ts:182` is the bare `Promise.all` fan-out; `src/server/api/status.ts` exists and returns version/configured-state/health — the route this feature must NOT touch)
- [X] T002 [P] Confirm the existing `GET /api/status` route (`src/server/api/status.ts`) and its three consumers (dashboard, agent skill, CLI health) — establish that the live-fusion surface MUST use a distinct endpoint (`/api/runtime`) to avoid clobbering it (research.md R-004)

**Checkpoint**: on branch `007-sequential-processing`, baseline + the `/api/status` collision risk documented.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared layer every story depends on — governance, config schema/migration, the fan-out dispatch extraction, and the status registry skeleton. **No user-story work can begin until this phase is complete.** The Constitution III amendment is FIRST (governance before implementation).

- [X] T003 Constitution III wording amendment in `.specify/memory/constitution.md` (**before any implementation** — C1 governance ordering): add a sentence acknowledging sequential mode as a **user-opted alternative** to the parallel default for low-VRAM local setups, with the survivor gate (≥2) and per-worker timeout/retry identical to parallel. The parallel default behavior is preserved exactly (INV-4) — this is documentation authorizing an explicitly-requested option, not a behavior regression. Add a dated "Last Amended" note. (See plan.md Constitution Check + Post-design re-check.)
- [X] T004 [P] Add `ExecutionModeSchema = z.enum(["parallel", "sequential"]).default("parallel")` to `src/config/schema.ts` (R-001); add `executionMode: ExecutionModeSchema` to `SettingsSchema` and to BOTH `.default({...})` literals (the SettingsSchema default AND the RawConfigSchema default). Bump `CONFIG_VERSION` from `4` to `5`. See data-model.md §1 + Config migration.
- [X] T005 [P] Config migration v4→v5 in `migrateConfig()` (`src/config/store.ts`, mirroring the v3→v4 `personaPolicy` injection at lines ~75–90): if `settings.executionMode` is absent, inject `"parallel"`; bump the version + log message ("config upgraded (executionMode added)"). The Zod `.default("parallel")` makes this belt-and-suspenders (R-007).
- [X] T006 [P] Create `src/fusion/fanout.ts` (NEW) with: (a) `runParallelFanout(candidates, runWorkerArgs)` — **extracted verbatim** from the current `fusion.ts:182-196` `Promise.all` (INV-4 — byte-for-byte unchanged behavior); (b) module constants `PER_CANDIDATE_MS = 180_000`, `JUDGE_STEPS_MS = 360_000` + `computeSerialBudgetMs(enabledCount)` returning `PER_CANDIDATE_MS * enabledCount + JUDGE_STEPS_MS` (R-003); (c) a stub `runSequentialFanout(...)` exported but throwing `new Error("not implemented")` (implemented in Phase 3). No `AbortController` (R-002). **NOTE**: shipped the full `runSequentialFanout` (ordering loop + budget gate in one pass) rather than a throw-stub — the budget is gated behind the optional `overrideBudgetMs` seam, so US1 (no override) gets ordering-only behavior with the large computed budget never triggering. Simpler than stub-then-replace; still independently testable.
- [X] T007 Wire `runFusion` (`src/fusion/fusion.ts`) to dispatch via fanout.ts: replace the inline `Promise.all` at line 182 with `executionMode === "sequential" ? runSequentialFanout(...) : runParallelFanout(...)`; read `const executionMode = input.config.settings.executionMode ?? "parallel"` near the existing `benchmark` read (line 88). `runParallelFanout` must produce identical results to the old inline code (asserted by T011). Leave `runSequentialFanout` as the throwing stub for now.
- [X] T008 [P] Create `src/fusion/status.ts` (NEW) with the `FusionStatusRegistry` skeleton (research.md R-004, data-model.md §3): a process-singleton with `enter(activityId, mode, candidateCount)`, `update(activityId, patch)`, `leave(activityId)`, and `getSnapshot(): FusionRuntimeStatus`. `getSnapshot` derives `state` ("idle" if empty; "queued" if `length > 1`; else "in-progress"). `leave` is idempotent (safe to call twice). No persistence, no content fields (only counts/indices/ids/startedAt).
- [X] T009 [P] Create `src/server/api/runtime.ts` (NEW) mirroring `src/server/api/status.ts`'s pattern: `runtimeRouter()` with `r.get("/", (_req, res) => res.json(fusionStatusRegistry.getSnapshot()))`. Mount it in `src/server/ui-server.ts` as `app.use("/api/runtime", runtimeRouter());` alongside (NOT replacing) the existing `/api/status` mount.

**Checkpoint**: Foundation ready — governance amended (III), config v5 parses + migrates, fan-out dispatches through `fanout.ts` (parallel = unchanged, sequential = throwing stub), status registry + `/api/runtime` endpoint exist and return `{state:"idle", fusions:[]}` at rest. User-story implementation can now proceed.

---

## Phase 3: User Story 1 — Sequential fan-out: candidates one at a time, in slot order (Priority: P1) 🎯 MVP

**Goal**: With `executionMode = "sequential"`, a fusion runs enabled candidates one at a time in slot order, non-overlapping, producing the same activity + N+2 sub-call structure as parallel mode. Parallel mode is unchanged.

**Independent Test** (quickstart T1 + T2): serial run → 3 candidate windows non-overlapping + in slot order, activity row + 5 sub_calls structurally identical to parallel. Parallel run → windows overlap, identical row structure, identical answer text.

### Tests for User Story 1

- [X] T010 [P] [US1] Test T2 — parallel unchanged (FR-002, FR-016, INV-4) (`tests/fanout-sequential.test.ts`): with `executionMode = "parallel"` and 3 faux candidates of staggered latency, assert candidate windows **overlap**; activity row + sub_calls structurally identical to a pre-feature baseline snapshot; identical answer text for deterministic faux inputs. This guards against behavioral drift from the T007 dispatch extraction.
- [X] T011 [P] [US1] Test T1 — serial ordering (FR-003, FR-010, FR-011, SC-001, SC-005) (`tests/fanout-sequential.test.ts`): `executionMode = "sequential"`, 3 faux candidates c1=400ms/c2=300ms/c3=200ms; assert c1.end ≤ c2.start AND c2.end ≤ c3.start (non-overlapping, slot order); `candidate_count === 3`, `survivor_count === 3`, `status === "success"`; **5 sub_calls** (3 workers + analysis + synthesis) — identical count to parallel (SC-005). (FR-011: assert fields + row count, NOT row order — parallel is inherently unordered.)

### Implementation for User Story 1

- [X] T012 [US1] Implement `runSequentialFanout` in `src/fusion/fanout.ts` (replacing the T006 stub): a `for…of` over enabled candidates in slot order that `await`s each `runWorker`, collects the `WorkerResult`, and reports per-candidate progress via the passed `onProgress` (e.g. `report(0, total, \`candidate ${i+1}/${total} running\`)`). NO budget gate yet (that's US2 — leave it out so US1 is independently testable on ordering alone). Each candidate uses the SAME `runWorker` call shape as `runParallelFanout` (INV-5 — per-worker timeout + 3-retry unchanged). **Deviation**: shipped the full loop (incl. budget gate) in T006 rather than a stub — the gate is behind the optional `overrideBudgetMs` seam, so US1 (no override) gets ordering-only behavior. Verified by T010/T011.
- [X] T013 [US1] Verify the survivor gate is mode-agnostic (INV-2): confirm `fusion.ts`'s `workerResults.filter(ok && content)` + `survivorCount < 2` check (line ~217) is untouched and works on `runSequentialFanout`'s output. Add a serial test where one candidate errors → run continues, proceeds with ≥2 survivors (FR-003 acceptance #4). Run T010 + T011 green. **Covered by `tests/serial-budget.test.ts` T16 (c2 errors → 2 survivors → proceeds) + the budget formula/exhaustion tests. Full suite 98/98 green.**

**Checkpoint**: User Story 1 functional + independently testable. **MVP deliverable** — issue #2's core ask works (serial fan-out, same logging, parallel unchanged). Stop and validate with E2 (and a manual local-model run if hardware permits) before continuing to US2.

---

## Phase 4: User Story 2 — Serial-aware time budget (Priority: P1)

**Goal**: Sequential mode computes a total wall-clock budget from candidate count and surfaces it as UI helper text; budget exhaustion stops launching further candidates (does not abort the in-flight one) and proceeds with survivors.

**Independent Test** (quickstart T3, T4, T5, T6): budget formula deterministic + surfaced; budget exhaustion skips remaining candidates, in-flight candidate NOT aborted, survivor gate still applies; per-worker retry unchanged in serial; sequential × benchmark both ON works.

### Tests for User Story 2

- [ ] T014 [P] [US2] Test T3 — budget formula (FR-005, FR-007, SC-003, R-003) (`tests/serial-budget.test.ts`): assert `computeSerialBudgetMs(N) === 180_000 * N + 360_000` for N ∈ {2,3,5}; N=2→12min, N=3→15min, N=5→21min. Assert the UI-side `serialBudgetMinutes(N)` (added in T019) agrees: `serialBudgetMinutes(N) * 60000 === computeSerialBudgetMs(N)`.
- [ ] T015 [P] [US2] Test T4 — budget exhaustion (FR-008, FR-009, R-002, INV-3) (`tests/serial-budget.test.ts`): inject a tiny budget via the **optional `overrideBudgetMs` test seam** on `runSequentialFanout` (added in T018; defaults to `undefined` → uses `computeSerialBudgetMs(count)` in production; test-only). 4 candidates c1=500ms/c2=500ms/c3=5000ms/c4=any, budget=1200ms → c1,c2,c3 run (c3 NOT aborted — its latency reflects ~5000ms), c4 never launched, 3 worker sub_calls, `survivor_count===3` → success. Variant: budget=300ms, all candidates 500ms → c1 finishes at ~500ms, rest skipped, `survivor_count===1` → standard "<2 survivors" error (no hang, no new error shape).
- [ ] T016 [P] [US2] Test T5 — per-worker retry unchanged in serial (FR-008, INV-5) (`tests/serial-budget.test.ts`): 3 candidates, c2 fails twice then ok (faux provider rejects first 2 calls); assert c2 makes 3 attempts via `withRetryTimeout`; fusion succeeds with 3 survivors; c2's retries push elapsed but c2 is not cut short.
- [ ] T017 [P] [US2] Test T6 — sequential × benchmark (FR-016, SC-006) (`tests/fanout-sequential.test.ts`): `executionMode="sequential"` AND `benchmarkMode=true`, 6 candidates (benchmark lifts the 5-cap); assert all 6 run one at a time in slot order; benchmark's 10-min per-candidate timeout applies; `computeSerialBudgetMs(6) === 1_440_000` (24min).

### Implementation for User Story 2

- [ ] T018 [US2] Add the budget gate to `runSequentialFanout` in `src/fusion/fanout.ts`: before each `await runWorker(...)` in the loop, `if (Date.now() - startedAt > budgetMs) break;` where `budgetMs = overrideBudgetMs ?? computeSerialBudgetMs(candidates.length)`. The `startedAt` is captured at fan-out start. Add the optional `overrideBudgetMs` to the fanout args — **test-only seam, default `undefined`**; production callers MUST NOT pass it (U1). Confirm the in-flight candidate is never aborted (R-002 — no AbortController).
- [ ] T019 [US2] Add the Sequential Mode toggle + dynamic helper text to `ui/src/pages/Candidates.tsx` (FR-004, FR-005), mirroring the existing Benchmark Mode toggle block (lines ~99-113): a `sequential` state var initialized from `config.settings.executionMode === "sequential"`; on save, PUT `settings: { ...config!.settings, executionMode: sequential ? "sequential" : "parallel" }`. Helper text (shown when toggle ON, or as a preview when OFF): "Sequential Mode — runs candidates one at a time. Use this for fully-local setups (Ollama/llama.cpp) with limited VRAM; cloud-only setups should stay Parallel." + a computed budget line "~Xm (N candidates × 3m + 6m judging)" via a UI-side `serialBudgetMinutes(enabledCount)` helper. **I4 note**: the constants (3min/6min) are deliberately duplicated between engine (`src/fusion/fanout.ts`) and UI (`Candidates.tsx`) — TS constants don't trivially cross the UI bundle boundary; the T014 agreement test guards them. If either constant changes, update BOTH files + the test together.
- [ ] T020 [US2] Add `executionMode: "parallel" | "sequential"` to the `AppConfig.settings` type in `ui/src/api.ts` (line ~17), alongside the existing `benchmarkMode`. **Do NOT fix the pre-existing missing `personaPolicy` in that type** (AGENTS.md §3 — surgical changes; that's a 006 gap, not this feature's). Run T014–T017 green.

**Checkpoint**: User Stories 1 AND 2 both work. Sequential fusions are now reliable (budgeted) and the toggle + helper text surface the mode + expected time to the user. Parallel mode still unchanged. (SC-002 — "<30s, no restart" — is inherently satisfied by T019's single config PUT; no separate test needed.)

---

## Phase 5: User Story 3 — Dashboard live server-status surface (Priority: P2)

**Goal**: A persistent Dashboard widget shows idle / in-progress (mode-aware affordance) / queued, polled from `GET /api/runtime`, refreshed on tab focus. `runFusion` enters/updates/leaves the registry on every path.

**Independent Test** (quickstart T7–T12): idle at rest; parallel affordance ("X of N responding"); serial affordance ("candidate X of N running"); queued (>1 fusion); enter⇒leave on error/throw (no stuck in-progress); focus refresh (no stale progress).

### Tests for User Story 3

- [ ] T021 [P] [US3] Test T7 — idle at rest (FR-012) (`tests/status-surface.test.ts`): fresh registry → `getSnapshot()` returns `{state:"idle", fusions:[]}`; `GET /api/runtime` returns the same.
- [ ] T022 [P] [US3] Test T8 — parallel in-progress affordance (FR-012, FR-013) (`tests/status-surface.test.ts`): enter a parallel fusion, update `candidatesDone` 0→N; assert snapshot `state==="in-progress"`, one fusion, `mode==="parallel"`, `candidateIndex` ABSENT, `candidatesDone` rises. Leave → idle.
- [ ] T023 [P] [US3] Test T9 — serial in-progress affordance (FR-012, FR-013) (`tests/status-surface.test.ts`): enter a serial fusion, update `candidateIndex` 1→N and `candidatesDone` incrementally; assert `candidateIndex === candidatesDone + 1` mid-run; leave → idle.
- [ ] T024 [P] [US3] Test T10 — queued state (FR-014, R-005) (`tests/status-surface.test.ts`): enter two fusions without leaving → `state==="queued"`, `fusions.length===2`, each carrying its own mode/index/done. Leave one → `in-progress`; leave both → `idle`. (Per FR-014 / R-005: "queued" = >1 active concurrently; there is no serialization queue or waiting line — fusions run concurrently.)
- [ ] T025 [P] [US3] Test T11 — enter ⇒ leave on every terminal path (INV-3) (`tests/status-surface.test.ts`): (a) a fusion that errors (<2 survivors) → registry empty, idle; (b) a fusion that throws inside `runFusion` (inject an unresolvable judge model or test-hook throw) → registry empty, idle. The activity row still records the terminal status (durable record correct).

### Implementation for User Story 3

- [ ] T026 [US3] Wire the registry into `runFusion` (`src/fusion/fusion.ts`): `enter(activityId, executionMode, candidates.length)` after the config gate + activity row allocation (before fan-out); `update(activityId, {candidateIndex, candidatesDone})` per-candidate in the serial loop (T012 already reports progress per candidate — call `update` alongside); for parallel, one `update` at fan-out start with `candidatesDone: 0`. Wrap the ENTIRE `runFusion` body (from `enter` to return) in `try { ... } finally { leave(activityId); }` so every terminal path clears the entry (INV-3 — non-negotiable; a stuck "in-progress" is the one bug that makes the surface worse than useless).
- [ ] T027 [US3] Add the **Server Status** widget to `ui/src/pages/Dashboard.tsx` (FR-012, FR-013, FR-014): a persistent section at the top rendering per the affordance table in contracts/dashboard-status.md (idle / in-progress parallel "X of N responding" / in-progress serial "candidate X of N running (Y done)" + elapsed from `startedAt` / queued "N fusions active" + compact list). Add `getStatus()` to `ui/src/api.ts` calling `GET /api/runtime`.
- [ ] T028 [US3] Wire the polling lifecycle (FR-015, R-006) in the Dashboard widget: a `setInterval` (≥2000ms) calling `getStatus()` that is **paused when `document.visibilityState !== "visible"`** and **resumed on visibilitychange→visible with an immediate refetch**. Reuse the existing `visibilitychange` pattern already in Dashboard.tsx (lines 43-48 — feature 005 added it for chart refresh). Run T021–T025 green.

**Checkpoint**: All three user stories independently functional. A long serial fusion is now legible (live, mode-aware, focus-refreshed widget) instead of looking hung.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates that span all stories. (The Constitution III amendment moved to Phase 2 / T003 per speckit-analyze C1.)

- [ ] T029 [P] Update `AGENTS.md` architecture notes: add a bullet under "The `fusion` Tool" describing execution mode (parallel default; sequential opt-in for low-VRAM local; serial budget gates launching, not the in-flight candidate) + a bullet under "Known limitations" noting that sequential removes OpenFusion's *own* candidate concurrency but does not manage the local server's VRAM (Ollama/llama.cpp keep-alive is the user's responsibility).
- [ ] T030 [P] Run the full quickstart.md validation suite (T1–T12 + E1–E2): all unit/integration tests green; E1 + E2 manual walkthroughs confirm the low-VRAM local scenario works and the parallel default is unaffected. Run `pnpm test` — the 006-era suite must stay green (no regressions).
- [ ] T031 [P] Verify `/api/status` is untouched: confirm `src/server/api/status.ts` still returns version/configured-state/health and its three consumers (dashboard health check, agent skill, CLI health) still work — the new `/api/runtime` is purely additive (research.md R-004).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup. **BLOCKS all user stories** (T003 governance + dispatch extraction + config migration + registry skeleton are prerequisites).
- **US1 (Phase 3)**: Depends on Foundational. **MVP — complete + validate before US2/US3.**
- **US2 (Phase 4)**: Depends on Foundational + US1 (US2 adds the budget gate to US1's `runSequentialFanout`; the toggle/helper-text are independent of US3).
- **US3 (Phase 5)**: Depends on Foundational (registry skeleton T008) + reads state from US1/US2's `runFusion` (mode, candidate index). Could be done in parallel with US2 by different developers since they touch different files (`status.ts`/`Dashboard.tsx` vs `fanout.ts`/`Candidates.tsx`), but US3's T026 wiring into `runFusion` should land after US1's serial loop exists.
- **Polish (Phase 6)**: Depends on all desired stories complete.

### User Story Dependencies

- **US1 (P1)**: Foundational only. No story dependencies. **Independently shippable as MVP.**
- **US2 (P1)**: Foundational + US1 (extends `runSequentialFanout` with the budget gate). Independently testable for the budget mechanics.
- **US3 (P2)**: Foundational (registry). Mode-aware affordance reads `executionMode` (US1's setting) + serial `candidateIndex` (US1's loop), so it's most useful after US1, but the registry/endpoint/widget mechanics are independent of US2.

### Within Each User Story

- Tests written alongside (and failing before) implementation, per project convention.
- fanout/registry primitives before `runFusion` wiring, before UI.
- Core implementation before integration.
- Story complete + checkpoint validated before the next priority.

### Parallel Opportunities

- **Phase 2**: T004, T005, T006, T008, T009 are all `[P]` (different files). T003 (governance) should be first. T007 depends on T006 (calls into fanout.ts).
- **Phase 3**: T010, T011 are `[P]` (same test file but distinct assertions — can be written together). T012 → T013 is sequential (T013 verifies T012's loop).
- **Phase 4**: T014–T017 are all `[P]` (distinct test concerns). T018 (budget gate) → T019/T020 (UI) sequential.
- **Phase 5**: T021–T025 are all `[P]` (distinct registry assertions). T026 (wiring) → T027 (widget) → T028 (polling) sequential.
- **Cross-story**: US2 (`fanout.ts`/`Candidates.tsx`) and US3 (`status.ts`/`Dashboard.tsx`) touch disjoint files — parallelizable by two developers after US1.

---

## Parallel Example: Phase 2 Foundational

```bash
# T003 (governance) first, then these five touch different files with no intra-phase deps
# (T007除外, which needs T006):
Task T004: "Add ExecutionModeSchema + executionMode to SettingsSchema in src/config/schema.ts"
Task T005: "Config migration v4→v5 in src/config/store.ts"
Task T006: "Create src/fusion/fanout.ts (parallel extraction + budget constants + serial stub)"
Task T008: "Create src/fusion/status.ts (FusionStatusRegistry skeleton)"
Task T009: "Create src/server/api/runtime.ts + mount in src/server/ui-server.ts"
```

---

## Implementation Strategy

### MVP First (Phase 3 / US1 Only)

1. Complete Phase 1: Setup (T001–T002) → verify baseline.
2. Complete Phase 2: Foundational (T003–T009) → **BLOCKS everything**. T003 (governance) first.
3. Complete Phase 3: US1 (T010–T013) → serial fan-out works, parallel unchanged.
4. **STOP and VALIDATE**: run T010 + T011 green; run E2 (parallel default unaffected); if hardware permits, run E1 (low-VRAM local scenario). This alone closes issue #2's core ask.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. + US1 → **MVP** (serial works, parallel unchanged). Validate. ← issue #2 closed.
3. + US2 → serial is reliable (budgeted) + toggle/helper-text surfaced. Validate.
4. + US3 → long serial runs are legible (live status widget). Validate.
5. Polish (AGENTS.md notes, full validation).

### Notes

- `[P]` tasks = different files, no dependencies.
- `[USx]` label maps task to its user story for traceability.
- Each user story is independently completable + testable; US1 alone is a shippable MVP.
- Commit after each task or logical group; stop at checkpoints to validate.
- **Hard constraints** (from research.md): no `AbortController` (R-002); no DB migration (data-model.md); `/api/runtime` NOT `/api/status` (R-004); `leave` runs in `finally` (INV-3); parallel dispatch is byte-for-byte the old `Promise.all` (INV-4); per-worker timeout/retry unchanged (INV-5).
- **Remediation applied** (per speckit-analyze): T003 Constitution III amendment moved to Foundational (was Phase 6) — C1; FR-011/FR-014/US3 wording clarified (no "queue/waiting", row-order not required) — I1/I3; serial↔sequential glossary in spec.md — I2; budget-constant sync noted on T019 — I4; `overrideBudgetMs` explicitly test-only on T018 — U1.
