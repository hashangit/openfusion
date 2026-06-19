# Feature Specification: Sequential Processing Option (Low-VRAM Local Models)

**Feature Branch**: `007-sequential-processing`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "An option to allow sequential processing instead of parallel requests, useful to allow systems with low VRAM to run local models one at a time." (GitHub issue #2)

**Terminology**: The canonical term is **sequential** (the `executionMode` enum value and the user-facing "Sequential Mode" toggle). **Serial** is used as internal shorthand for the same concept throughout this feature's design/code (e.g. `serialBudgetMs`, `runSequentialFanout`, "serial mode"). They are the same thing — "serial" is just the shorter internal name.

## Background & Motivation

OpenFusion's fan-out runs all enabled candidates **simultaneously** via parallel requests. This is optimal for cloud-hosted models (OpenAI, Anthropic, etc.) — they are independent, fast, and resource-cheap to call concurrently. But for users running **local models** through providers like Ollama or llama.cpp, parallel fan-out loads every candidate model into VRAM at the same instant. On a low-VRAM machine (e.g. a single 8–16 GB GPU running a few 7B-class models), this causes out-of-memory errors, model-swapping thrash, or silent degradation.

These users do not need parallelism — they need exactly **one model resident at a time**. Today OpenFusion offers no way to express that. The user's only workaround is to reduce to 2 candidates and hope both fit, which defeats the panel-of-reviewers value proposition.

This feature adds a user-controlled **execution mode** toggle: parallel (the existing default, optimal for cloud) or sequential (candidates run one after another, optimal for low-VRAM local setups). The existing precedent is the **Benchmark Mode** toggle on the Candidates page, which already proves the pattern: a settings boolean → UI switch → behavior change in the fusion engine.

Sequential execution has a knock-on consequence worth addressing in the same feature: a serial fusion of N candidates takes roughly N×(per-candidate latency) plus the two judge steps, which can far exceed the wall-clock budget a parallel fusion assumes. The feature must therefore **compute a serial-aware total time budget** rather than reuse the parallel per-worker timeout, and it must surface progress in a way that makes a long serial run legible to the user.

Finally, because OpenFusion runs as an MCP server that a client drives, the user has nowhere today to see *what the server is doing right now* — the dashboard shows past activity, not live state. A long serial fusion (potentially 10–15 minutes) makes that gap painful. This feature adds a **live server-status surface on the dashboard** so the user can see idle / in-progress / queued state at a glance, with the look adapting to parallel vs sequential mode.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Low-VRAM local user switches to sequential mode and completes a fusion (Priority: P1)

A user runs OpenFusion with three local candidates via Ollama on a machine with limited VRAM. In parallel mode, fusions fail or thrash because all three models load simultaneously. The user opens the Candidates page, flips a "Sequential Mode" toggle (mirroring the existing Benchmark Mode toggle), and saves. Subsequent fusions run the candidates one at a time — only one model is resident at any moment. The fusion completes successfully and the consolidated answer is returned. The candidate sub-calls are still recorded individually in the activity log, exactly as in parallel mode.

**Why this priority**: This is the entire point of the feature — issue #2's core ask. Without it, low-VRAM local users cannot use OpenFusion's multi-candidate panel at all. Everything else in the feature is in service of making this usable (timeout budgeting, progress visibility).

**Independent Test**: Configure ≥2 local (or faux) candidates, enable Sequential Mode via the dashboard, trigger a fusion, and verify (a) it completes, (b) the activity row shows the expected candidate count and survivor count, (c) each candidate has its own sub-call row, (d) only one candidate was in-flight at a time (observable via non-overlapping sub-call timing or a serial-mode progress signal).

**Acceptance Scenarios**:
1. **Given** Sequential Mode is OFF (the default), **When** a fusion runs, **Then** candidates are dispatched in parallel (today's behavior, unchanged).
2. **Given** Sequential Mode is ON and N candidates are enabled, **When** a fusion runs, **Then** candidates execute one after another in candidate-slot order; candidate k+1 does not begin until candidate k has resolved (ok, timeout, or error).
3. **Given** Sequential Mode is ON, **When** a fusion completes, **Then** the activity row and N+2 sub-call rows are written identically to a parallel fusion (same fields, same survivor semantics — ≥2 survivors required to proceed to judging).
4. **Given** Sequential Mode is ON, **When** a candidate fails or times out during the serial run, **Then** the run continues with the next candidate and proceeds to judging if ≥2 survivors remain; if <2, it errors with the same message shape as parallel mode.

---

### User Story 2 - Serial fusion uses a serial-aware time budget instead of the per-worker timeout (Priority: P1)

A user with Sequential Mode ON has the per-worker timeout set to 5 minutes and 4 candidates. Naively, serial execution could take up to 4×5 = 20 minutes for candidates alone, plus judging — far longer than the wall-clock budget a parallel fusion assumes. Instead of reusing the parallel per-worker timeout as the *total* budget (which would abort early and lose most candidates) or unboundedly extending it, OpenFusion computes a serial-specific total time budget derived from the candidate count and the configured per-worker latency assumption, and communicates that budget to the user so a long serial run is not a surprise. The budget protects the user from runaway waits while still allowing enough time for every candidate to complete under normal local-model latency.

**Why this priority**: Without a serial-aware budget, sequential mode is unusable in practice — either every fusion times out (budget too tight) or it can run indefinitely (no budget at all). Budgeting is what makes P1-US1 actually reliable.

**Independent Test**: Enable Sequential Mode with a known candidate count. Verify the total serial time budget is computed deterministically from the candidate count and a documented per-candidate latency assumption (e.g. budget = perCandidateAssumption × candidateCount + judgeAssumption), and that the budget is surfaced in the UI near the toggle. Verify a fusion that fits within the budget completes normally, and one that would exceed it is handled gracefully (the run ends with whatever survivors it collected, subject to the ≥2 gate).

**Acceptance Scenarios**:
1. **Given** Sequential Mode is ON with N enabled candidates, **When** the user views the Candidates page, **Then** helper text near the toggle states the approximate total serial wall-clock (derived from N and the documented per-candidate latency assumption) so the user knows what to expect.
2. **Given** Sequential Mode is ON, **When** a fusion's total elapsed time reaches the serial budget, **Then** any not-yet-started candidates are skipped and the run proceeds with the survivors collected so far (≥2 → judge; <2 → error with the standard message).
3. **Given** Sequential Mode is OFF, **Then** the per-worker timeout and wall-clock behavior are unchanged from today (the serial budget is computed/applied only in serial mode).

---

### User Story 3 - Dashboard shows live server status during a fusion, adapting to parallel vs sequential (Priority: P2)

During a long serial fusion (potentially 10+ minutes), the user has no way to see what OpenFusion is doing right now — the dashboard's activity table shows completed runs, not live state. The user wants a persistent status surface on the Dashboard page that shows: **idle** when no fusion is running; **in-progress** with a progress affordance (showing candidate count and, in serial mode, which candidate is currently running and how many remain) when one fusion is active; and a **multi-fusion** view when more than one fusion is active concurrently (OpenFusion does not serialize fusions, so there is no "waiting line" — they run concurrently on the event loop). The affordance's look changes based on mode — parallel fusions show "N of M candidates responding", serial fusions show "candidate 3 of 5 running". This is a status surface, not per-candidate results.

**Why this priority**: This is the difference between a long serial run feeling transparent vs feeling like the tool hung. It is valuable but not blocking — P1 delivers the core capability; this makes it humane to use. It also generalizes beyond serial mode (any parallel fusion benefits from a live status), which increases its return.

**Independent Test**: With Sequential Mode ON, trigger a fusion. While it runs, open the Dashboard and verify the status surface shows "in-progress" with a serial-style progress affordance (current candidate index / total). Trigger a second fusion while the first runs (e.g. from a second client or the Generations page) and verify the queue state is reflected. When both finish, verify the surface returns to idle.

**Acceptance Scenarios**:
1. **Given** no fusion is running, **When** the user opens the Dashboard, **Then** the status surface shows an idle state.
2. **Given** a fusion is running in **parallel** mode, **When** the user opens the Dashboard, **Then** the status surface shows in-progress with a parallel affordance reflecting how many candidates are responding out of the total.
3. **Given** a fusion is running in **sequential** mode, **When** the user opens the Dashboard, **Then** the status surface shows in-progress with a serial affordance reflecting the current candidate index and the remaining count.
4. **Given** two or more fusions are active concurrently, **When** the user opens the Dashboard, **Then** the status surface reflects a multi-fusion state (number of fusions active). There is no "waiting" count — fusions run concurrently, not serialized.
5. **Given** a fusion completes or errors, **Then** the status surface updates to reflect the new live state (returns toward idle, or shows the next queued item).

### Edge Cases

- **Sequential Mode × Benchmark Mode both ON**: both settings are orthogonal — Benchmark lifts the max-candidate cap and forces a long per-candidate timeout; Sequential serializes execution. Both on simultaneously must work (a benchmark of many models, run one at a time). The serial budget calculation must account for the (possibly large) candidate count Benchmark permits.
- **Sequential Mode with only 2 candidates**: still valid; the serial run is two steps instead of two parallel calls. No special handling.
- **A candidate in a serial run takes the full per-worker timeout then retries (up to 3 attempts)**: the retry/timeout machinery per candidate is unchanged — each candidate still gets its own per-worker timeout with retries; the serial *total* budget is what gates the overall run.
- **Sequential budget exhausted before any candidate finishes**: proceed with zero survivors → standard "<2 survivors" error. (Unlikely for real local models but must not hang.)
- **Status surface when a fusion is active but the dashboard tab is not focused**: the surface should reflect current state when the tab becomes visible (no stale frozen progress).
- **Multiple concurrent fusions contending for the same local model**: OpenFusion does not arbitrate the local server's own model scheduling — that is the local server's responsibility (Ollama/llama.cpp manage their own VRAM). Sequential mode removes OpenFusion's *own* concurrency; it does not guarantee no OOM if the user's local server misbehaves. This is documented, not solved in code.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a per-fusion **execution mode** that is either parallel (default) or sequential, configurable by the user and persisted across restarts.
- **FR-002**: Parallel mode MUST behave exactly as today — all enabled candidates dispatched concurrently — with no behavioral change introduced by this feature.
- **FR-003**: Sequential mode MUST execute enabled candidates one at a time in candidate-slot order; candidate k+1 MUST NOT begin until candidate k has resolved (success, timeout, or error).
- **FR-004**: System MUST expose the execution mode as a toggle in the Candidates dashboard page, co-located with the existing Benchmark Mode toggle and following the same interaction pattern.
- **FR-005**: The Candidates page MUST display helper text near the Sequential toggle explaining when to use it (fully-local setups / low VRAM) and the approximate total serial wall-clock for the current enabled-candidate count, derived from a documented per-candidate latency assumption.
- **FR-006**: The default execution mode MUST be parallel; Sequential Mode MUST be an explicit opt-in.
- **FR-007**: In sequential mode, the system MUST compute a serial-specific total time budget derived from the enabled-candidate count and the documented latency assumptions (per-candidate + judge), rather than reusing the parallel per-worker timeout as the total budget.
- **FR-008**: In sequential mode, each candidate MUST retain its existing per-worker timeout and retry behavior (up to 3 attempts with timeout reset); the serial total budget is an additional, outer constraint governing the whole run.
- **FR-009**: In sequential mode, when the total serial budget is exhausted, the system MUST stop launching further candidates and proceed with the survivors collected so far, subject to the existing ≥2-survivor gate.
- **FR-010**: The survivor gate (≥2 successful candidates required to proceed to judging) MUST apply identically in parallel and sequential mode; no special-casing.
- **FR-011**: Activity and sub-call logging MUST be identical in **fields and row count** between parallel and sequential mode — one activity row plus N+2 sub-call rows, each candidate recorded individually with its own status, latency, and tokens. (Row *ordering* is explicitly not required to match: parallel sub-calls resolve in nondeterministic race order, sequential in slot order. Field presence + row count is what must be invariant.)
- **FR-012**: System MUST provide a live server-status surface on the Dashboard page that reflects the current state of the fusion engine: idle, in-progress, or queued.
- **FR-013**: When a fusion is in-progress, the status surface MUST reflect how many candidates are responding (parallel mode) or which candidate index is currently running and how many remain (sequential mode).
- **FR-014**: When more than one fusion is active concurrently, the status surface MUST reflect a multi-fusion state showing the number of fusions currently active. (OpenFusion does not serialize fusions against each other — concurrent fusions coexist on the event loop. "Queued" here means "more than one is in the registry at once", not a serialization queue with a waiting line.)
- **FR-015**: The status surface MUST reflect current (non-stale) state when the Dashboard tab regains focus.
- **FR-016**: Sequential Mode and Benchmark Mode MUST be independently combinable (either, both, or neither ON); no setting may disable or override the other.

### Key Entities *(include if feature involves data)*

- **Execution Mode (setting)**: A user-configurable mode (`parallel` | `sequential`) governing how candidate fan-out is scheduled. Default `parallel`. Persisted in configuration; read by the fusion engine at fan-out time. Orthogonal to Benchmark Mode.
- **Serial Time Budget (derived)**: A per-fusion value computed only in sequential mode from the enabled-candidate count and documented latency assumptions. Acts as the outer wall-clock constraint on the whole serial run; the per-worker timeout still governs each individual candidate.
- **Live Server Status (ephemeral runtime state)**: In-memory state of the fusion engine at the current moment — idle / one-or-more fusions in-progress / queued — plus, for an in-progress fusion, the candidate progress affordance appropriate to its execution mode. Derived from in-process fusion state; not persisted (lost on restart, which is acceptable since it describes the present moment only).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user with a low-VRAM machine running local models can complete a multi-candidate fusion that previously failed or thrashed in parallel mode, by enabling Sequential Mode — measured by the fusion returning a consolidated answer where it previously errored or hung.
- **SC-002**: Switching execution mode requires a single toggle action and no restart; the new mode takes effect on the next fusion — measured by a user completing the mode switch in under 30 seconds and observing the new behavior on the immediately following fusion.
- **SC-003**: In sequential mode with N candidates, the total serial time budget is communicated to the user before the fusion runs and is within the documented per-candidate/judge latency assumptions — measured by the displayed budget matching the formula's output for the current candidate count.
- **SC-004**: A long serial fusion does not appear to hang — the Dashboard status surface shows a live, updating progress affordance throughout, and reflects the correct candidate index/remaining count — measured by a user being able to state the run's progress at any point during a 10-minute serial fusion by viewing the Dashboard.
- **SC-005**: Activity logs are indistinguishable in structure between a parallel and a sequential fusion of the same candidates — measured by identical row counts and field presence regardless of mode.
- **SC-006**: The two mode toggles (Sequential, Benchmark) function independently — measured by all four on/off combinations being valid and each toggle's documented effect holding regardless of the other's state.

## Assumptions

- **Target users**: The sequential option exists for users running local models (Ollama, llama.cpp, etc.) on machines where VRAM is the binding constraint. Cloud-only users have no reason to use it; parallel remains strictly better for them. Helper text will direct local users toward sequential.
- **Parallel remains the default**: Matching the user's explicit decision and the cloud-optimized status quo. Sequential is an opt-in for the constrained case.
- **Per-candidate latency assumption is a documented constant**: The serial budget formula uses fixed, documented latency assumptions (e.g. ~3 minutes per candidate, ~3 minutes for the analysis step, ~3 minutes for the synthesis step) rather than measuring live. These are conservative defaults; the exact values are finalized in planning. They are not user-tunable in v1 (YAGNI — Constitution VII).
- **Local-server VRAM/OOM is out of scope**: OpenFusion will not manage, detect, or recover from the local model server's own VRAM scheduling (Ollama keep-alive, llama.cpp offloading, etc.). Sequential mode removes OpenFusion's *own* candidate concurrency; it is the user's responsibility to configure their local server so one model at a time is feasible. This is documented, not engineered.
- **Existing entry paths are reused**: Both the blocking MCP tool path and the detached task path read configuration at fusion time, so a new setting automatically applies to both with no per-path wiring. The status surface (US3) is read from in-process state shared by both paths.
- **Live status is best-effort, ephemeral**: The server-status state is in-memory and lost on restart. It describes the present moment; it is not a durable record (the activity log remains the durable record). Correctness of fusions never depends on it.
- **Status surface does not expose per-candidate content**: It shows progress and state only — candidate results continue to live in the activity log and appear there once a fusion completes.
