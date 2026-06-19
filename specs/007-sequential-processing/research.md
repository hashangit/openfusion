# Research: Sequential Processing Option (Low-VRAM Local Models)

**Feature**: 007-sequential-processing | **Date**: 2026-06-19

Phase 0 research. Resolves the open design questions and locks the decisions Phase 1 builds on. Each entry: Decision → Rationale → Alternatives rejected. Grounded in the current code (`fusion.ts`, `worker.ts`, `util/timeout.ts`, `task-runner.ts`, `schema.ts`, `Candidates.tsx`).

---

## R-001: Execution mode as a boolean, an enum, or maxConcurrency?

**Decision**: `settings.executionMode: "parallel" | "sequential"` (enum), default `"parallel"`.

**Rationale**: The issue asks for a binary choice (serial vs parallel) and the boolean `sequentialMode` (mirroring `benchmarkMode`) is the literal 1:1 with that ask. However:

- `benchmarkMode` is genuinely boolean (on/off, no third state conceivable). Execution mode is not — the natural design space includes concurrency-limited (`maxConcurrency: N`), which the user's own US3 thinking ("queue") gestures toward. A boolean forces a rename if we ever add it; an enum absorbs it as a third value with no rename.
- The cost of the enum over the boolean is one schema line (`z.enum([...])` vs `z.boolean()`) and a 1-branch `switch` at the dispatch site. Zero runtime complexity difference; zero extra UI (the toggle still maps to two visible states).
- Constitution VII (Simple & Local) is about not building speculative *machinery*, not about denying free type-level extensibility. The enum doesn't add machinery — the dispatch is still two branches. `maxConcurrency: number` *would* add machinery (a concurrency-limited runner, head-of-line semantics) and is correctly deferred.

So: enum now (free future-proofing), `maxConcurrency` deferred until a user asks. The `parallel`/`sequential` values are the only two implemented in v1; any third value is a compile error until explicitly added.

**Alternatives rejected**:
- *`sequentialMode: boolean` (mirror benchmarkMode exactly)*: rejected — forces a rename if concurrency-limited is ever added, for zero current benefit. (This was the brainstorm's first recommendation; revised after reading the schema and the user's queue thinking.)
- *`maxConcurrency: number` now (1=serial, N=cap)*: rejected — the in-between values are a near-zero-use case for a single-user local tool, and the concurrency-limited runner + head-of-line semantics are real machinery. Defer; the enum leaves the door open.
- *Per-candidate `sequential: boolean` flag*: rejected — turns fan-out into a scheduling/grouping problem (which candidates run together?). Massive over-engineering for v1.

---

## R-002: How does the serial budget interact with the per-worker timeout and the 3-retry machinery?

**Decision**: The serial budget is an **outer gate on the whole run**; the per-worker timeout + 3-retry machinery is **unchanged per candidate**. Before launching each candidate in the serial loop, check elapsed time against the budget; if exhausted, stop launching and proceed with survivors so far.

**Rationale**: This is the subtlest part of the feature, and getting it wrong breaks either resilience (Constitution III) or the point of the feature (enough time for every candidate). The facts from the code:

- `withRetryTimeout` (`util/timeout.ts:58`) runs up to 3 attempts per candidate, each with a **fresh** per-worker timeout window, with exponential backoff (500ms, 1s, 2s) between attempts. So one pathological candidate can consume up to `3 × workerTimeoutMs + ~3.5s` before finally failing.
- There is **no `AbortController`** in the fan-out today (confirmed; also AGENTS.md known limitations). We are *not* introducing one in this feature. So "budget exhausted" cannot mean "abort the candidate currently running" — there's no mechanism, and building one is scope creep.
- The natural semantics, then: the budget gates **launching the next candidate**, not finishing the current one. If candidate 3 of 5 is running when the budget clock expires, candidate 3 runs to its own per-worker timeout/retry resolution; candidates 4 and 5 are never launched. We then apply the survivor gate (≥2) to whatever we have.

This composes cleanly:
- Per-candidate behavior is byte-for-byte identical to parallel mode (same timeout, same retries, same `runWorker`). No special-casing inside the worker.
- The budget is a single `if (Date.now() - startedAt > budgetMs) break;` before each `await runWorker(...)` in the serial loop.
- The survivor gate (`fusion.ts:217`) is already mode-agnostic — it just filters `workerResults`. Zero changes.

**Edge case (budget exhausted before ≥2 candidates finish)**: proceed with <2 survivors → the existing "only N of M candidates succeeded (min 2)" error path (`fusion.ts:220-241`). Unlikely for real local models (the budget is sized to fit them) but must not hang, and doesn't.

**Alternatives rejected**:
- *Budget aborts the in-flight candidate*: rejected — requires `AbortController` plumbing through `runWorker` → `withRetryTimeout` → `runComplete`, which is out of scope (AGENTS.md known limitations) and not needed.
- *Budget replaces the per-worker timeout in serial mode*: rejected — conflates two concerns; the per-worker timeout protects against a single hung call, the budget protects against runaway total wall-clock. Both are needed.
- *No budget, run unbounded*: rejected — a slow local server could make a serial fusion run for an hour. The user needs a predictable ceiling and a visible one (FR-005 helper text).

---

## R-003: What are the budget formula's constants, and where do they live?

**Decision**: `serialBudgetMs = PER_CANDIDATE_MS × enabledCandidateCount + JUDGE_STEPS_MS`, with `PER_CANDIDATE_MS = 180_000` (3 min) and `JUDGE_STEPS_MS = 360_000` (6 min: 3 min analysis + 3 min synthesis). Constants live as module-level `const` in `fanout.ts`, documented in a comment, **not** user-tunable in v1.

**Rationale**: The user gave the formula shape directly in the dialogue ("3min × #candidates + 6min"). The constants encode two assumptions:
- A local 7B–13B model takes ~3 min to respond under normal load (conservative; real numbers vary 30s–4min). 3 min covers the common case without padding excessively.
- The two judge steps together take ~6 min (3 + 3). The judge runs on one model (the configured judge), and in serial mode the judge is still a single call per step — not itself serialized — so 3 min each is the same assumption as one candidate.

Why not measure live latency and adapt? Constitution VII (Simple & Local, YAGNI) and the spec's explicit assumption ("fixed, documented latency assumptions … not user-tunable in v1"). A live-measurement system is real machinery (sliding windows, persistence of past latencies) for a single-user tool where a conservative static constant is fine. The helper text shows the computed budget so the user sees the ceiling; if it's wrong for their hardware, they lower `workerTimeoutMs` (which the per-worker timeout still respects).

The constants are module-level (not magic numbers inline) so a future v2 can lift them to settings in one place if needed.

**Alternatives rejected**:
- *Live-measure per-candidate latency and size the budget from a rolling average*: rejected — machinery for a single-user local tool; YAGNI.
- *User-tunable constants in settings*: rejected — v1 simplicity; the helper text + `workerTimeoutMs` give the user enough control.
- *Use `workerTimeoutMs × candidateCount + 2 × workerTimeoutMs`*: rejected — `workerTimeoutMs` is a *timeout* (failure ceiling), not an *expectation*. Sizing the budget from the timeout would massively over-provision (e.g. 5min × 5 + 2×5min = 35min) and mislead the helper text.

---

## R-004: Where does the status surface get its data, and how does the dashboard read it?

**Decision**: A new in-memory `FusionStatusRegistry` (singleton, `src/fusion/status.ts`) that `runFusion` enters on start, updates during fan-out (per-candidate, serial mode only — parallel mode updates at fan-out begin/end), and leaves on terminal. The dashboard reads it via a new **`GET /api/runtime`** endpoint (deliberately distinct from the existing `/api/status` — see below), polled coarsely (≥2s) only while the Dashboard tab is focused.

**Why `/api/runtime` and not `/api/status`**: `/api/status` already exists (`src/server/api/status.ts`) and returns version/configured-state/health. It is consumed by the dashboard, the agent skill, and CLI health checks — clobbering it would break three consumers. The live-fusion state is a different concern (ephemeral runtime state vs static config/health), so it gets its own additive route: `/api/runtime`.

**Rationale**: The state already exists implicitly — the blocking fusion is `await runFusion(...)` somewhere on the event loop, and detached fusions are tracked in `task-runner.ts`'s `activeTasks` set. But neither is *observable* from the UI server today. The registry makes it observable with minimal moving parts:

- `enter(activityId, mode, candidateCount)` at the top of `runFusion` (after the gate, before fan-out).
- `update(activityId, { candidateIndex, candidatesDone })` — called per-candidate in serial mode (the serial loop knows the index); in parallel mode, one `update` at fan-out start is enough ("N candidates responding").
- `leave(activityId)` in a `finally` around the whole `runFusion` body, so every terminal path (success, partial, error, throw) clears the entry. This is the critical correctness invariant — a stuck "in-progress" after a crash would be worse than no surface.
- `getSnapshot()` returns the current state for `/api/runtime`: `{ state: "idle"|"in-progress"|"queued", fusions: [...] }`. "Queued" is derived: if `getSnapshot().fusions.length > 1`, it's queued (one in-flight, rest waiting on the event loop — they're not literally queued in a data structure; see R-005).

Why polling and not SSE/WebSocket? Constitution VII (simple, local, no new infra). A 2s poll on a focused tab is ~30 bytes per request; the status is best-effort and coarse-grained by design. The existing dashboard already polls the activity list; adding a status poll is the same pattern.

Why a registry and not just reading `activeTasks`? `activeTasks` only covers the detached task path, not the blocking MCP tool path. The registry is the single source covering both, because both go through `runFusion`.

**Alternatives rejected**:
- *SSE/WebSocket push*: rejected — new transport, new lifecycle, for a coarse 2s-status. YAGNI for a local single-user tool.
- *Reuse `activeTasks` directly*: rejected — covers only the task path, not blocking fusions. The blocking path is the common one for non-Tasks clients.
- *Persist status to SQLite*: rejected — status describes the present moment; on restart there is no "present moment" to resume (any in-flight fusion is dead). The activity log is the durable record.

---

## R-005: Is there an actual queue, or does "queued" just mean "multiple in-flight"?

**Decision**: **No queue data structure.** "Queued" in the status surface means ">1 fusion is currently in the registry (entered, not yet left)". Concurrent fusions already coexist on the event loop today (a blocking fusion and a detached task, or two detached tasks); the surface *observes* that, it does not *serialize* it.

**Rationale**: OpenFusion today does not serialize fusions — they run concurrently in one Node process (the event loop interleaves them; `better-sqlite3` is synchronous so DB writes briefly block, tolerable per AGENTS.md). Sequential mode serializes *candidates within one fusion*, not *fusions against each other*. Building a cross-fusion queue would be:

- New machinery (a queue, a worker, backpressure) — violates Constitution VII.
- Solving a problem the user didn't ask about. The user's problem is VRAM across *candidates in one fusion*, not across *separate fusions*.
- Possibly wrong — a user running two local fusions concurrently might *want* them concurrent if they have the VRAM for two judges.

So the status surface shows "2 fusions in progress" as a fact, and lets the user draw their own conclusion. If cross-fusion serialization becomes a real ask later, it's a separate feature.

**Alternatives rejected**:
- *A fusion queue that runs one fusion at a time*: rejected — solves an unasked problem, adds machinery, and may be wrong for users with more VRAM.
- *Serial mode also implies cross-fusion serialization*: rejected — conflates two scopes. Serial mode is intra-fusion (candidates). Cross-fusion is a different axis.

---

## R-006: How does the dashboard avoid stale status when the tab regains focus?

**Decision**: The status poll runs on two triggers: (a) a coarse interval (≥2s) that is **paused when the tab is hidden** and **resumed on visibilitychange**, and (b) an immediate fetch on `visibilitychange → visible`. The registry is always current server-side (it's in-memory, updated synchronously on enter/leave), so any fetch returns the truth; the only risk is the client showing stale data, which the immediate-on-focus fetch eliminates.

**Rationale**: The existing dashboard already has this pattern — feature 005's changelog notes "refresh dashboard charts when the tab regains visibility" (commit `1ee73d6`). We reuse the same `visibilitychange` hook: on focus, immediately re-fetch `/api/runtime` so the widget never shows a frozen "candidate 3 of 5" from 10 minutes ago. Pausing the interval when hidden avoids pointless polling (the user isn't looking). FR-015 is satisfied by the immediate-on-focus fetch + always-current registry.

**Alternatives rejected**:
- *Poll regardless of visibility*: rejected — pointless requests to a local server when nobody's looking; minor but avoidable waste.
- *Push-based (SSE) so staleness is impossible*: rejected — see R-004; new transport, not worth it for a coarse status.

---

## R-007: Does the config migration need a version bump, and is v4→v5 right?

**Decision**: Yes — bump `CONFIG_VERSION` 4 → 5 and add a v4→v5 migration in `store.ts` that injects `settings.executionMode = "parallel"` if the field is absent. The Zod schema defaults the field, so the migration is belt-and-suspenders (old files without the field parse to the default either way).

**Rationale**: The project bumps `CONFIG_VERSION` on schema additions (006 went 3→4 for `personaPolicy`). Adding `executionMode` to `SettingsSchema` is the same kind of additive change. The migration ensures an explicit, logged transition rather than relying silently on the Zod default — consistent with how 006 handled `personaPolicy`. No data transformation, no breaking change, no re-validation of existing fields.

**Alternatives rejected**:
- *Rely on Zod default, no version bump*: works functionally, but loses the explicit migration trail the project keeps. Rejected for consistency with 006's approach.
- *Major version bump*: rejected — additive, non-breaking.

---

## Summary of locked decisions

| # | Decision |
|---|---|
| R-001 | `executionMode: "parallel" \| "sequential"` enum, default `parallel`. (Boolean rejected; maxConcurrency deferred.) |
| R-002 | Serial budget = outer gate on *launching* next candidate; per-worker timeout + 3-retry unchanged per candidate. No AbortController. |
| R-003 | `serialBudgetMs = 180_000 × N + 360_000`. Module-level constants, not user-tunable in v1. |
| R-004 | New `FusionStatusRegistry` singleton (`status.ts`); `runFusion` enters/updates/leaves; dashboard polls `GET /api/runtime` ≥2s, focused-tab only. **Not** `/api/status` (that route already exists for config/health). |
| R-005 | No queue data structure. "Queued" = ">1 fusion in registry". Cross-fusion serialization is out of scope. |
| R-006 | Status poll paused when hidden, immediate refetch on `visibilitychange → visible`. Reuses 005's pattern. |
| R-007 | Bump `CONFIG_VERSION` 4→5; migration injects `executionMode:"parallel"` if absent. Belt-and-suspenders with Zod default. |
