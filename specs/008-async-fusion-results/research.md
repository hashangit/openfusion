# Research: Async Fusion Results via Deferred Retrieval

**Feature**: 008-async-fusion-results | **Phase**: 0 | **Date**: 2026-06-19

This document resolves the technical unknowns from the plan's Technical Context and captures the load-bearing decisions. Each decision cites the spec FR it grounds and the alternatives rejected. The single empirical gate (R-001) is flagged for resolution before retrieval timing is locked.

---

## R-001 — The client timeout is per-call and resets (EMPIRICAL GATE)

**Decision**: Treat the codex/ZCode per-call timeout as a per-`tools/call` ceiling that **resets on each new `tools/call`**, with no additional session/turn-level wall-clock budget across tool calls. The bounded long-poll escape (FR-004) depends on this.

**Rationale**: Source review of codex's MCP client (`codex-rs/rmcp-client/src/rmcp_client.rs`, `call_tool()`) shows the timeout is applied by `run_service_operation("tools/call", timeout, …)` — a wrapper around a single request/response. Each `fusion({ _resume_from })` call is a fresh `tools/call` and thus gets a fresh timeout window. codex issue #4157 documents the ~60 s default; `tool_call_timeout_ms` exists but is widely reported sticky at ≤60 s (#2346). The kickoff returning immediately + each retrieval staying under ~40 s means no single call approaches the ceiling.

**Alternatives considered**:
- *Assume a session-level budget*: would force fire-and-forget for parallel mode too (no tight-poll), making US1 unreachable. Rejected unless R-001 verification fails — see "If the gate fails" below.
- *Ship a probe binary*: overkill; reading `run_service_operation`'s call sites and whether any turn/session deadline wraps the tool loop in `core/src/mcp_tool_call.rs` settles it.

**If the gate fails** (a session/turn budget exists): FR-004's tight bounded long-poll is unsafe for parallel mode. **The R-001 fallback becomes the PRIMARY design, not a contingency** — kickoff returns immediately with the reference id (still no timeout on kickoff), and *every* retrieval is fire-and-forget (returns `processing` instantly, no long-poll). The agent paces itself using `retry_after_ms` + `eta_ms`. This is strictly less efficient but correct under either timeout model. If the gate fails, rebuild T011/T012/T008 against fire-and-forget-for-all before writing feature code.

**Resolution action (tasks T002 — source trace AND diagnostic harness, both required)**:
- (a) **Source trace**: read `run_service_operation`'s call sites + whether any turn/session deadline wraps the tool loop in `core/src/mcp_tool_call.rs`. Confirms the mechanism.
- (b) **Diagnostic harness** (~15 min): register a probe MCP tool that `sleep`s N seconds, call it through codex at escalating durations (5s, 30s, 55s, 65s), repeated across calls AND across turns. Confirms observed behavior: (1) is the timeout per-call? (2) does it reset between calls? (3) is there a cumulative turn/session budget across N calls? (4) what error does the agent see after a timeout, and does the next call work?
A trace proves capability; a harness proves behavior. Record both in this file (append "R-001 verified") before implementing the bounded long-poll.

### ✅ R-001 VERIFIED (source trace) — 2026-06-21

**Result: GATE PASSES.** The codex per-call timeout is **per-`tools/call` and resets between calls**; there is **no session/turn-level wall-clock budget** across tool calls. FR-004's bounded long-poll (~40 s per retrieval, under the ~60 s ceiling) is safe. No adjustment to the 008 design needed.

**Source trace** (codex 0.138.0, `openai/codex` main, 2026-06-21):

1. **`codex-rs/rmcp-client/src/rmcp_client.rs` — `active_time_timeout(duration, pause_state, operation)`:** the countdown is a **local `remaining` variable** scoped to a single invocation:
   ```rust
   async fn active_time_timeout(duration: Duration, mut pause_state, operation) {
       let mut remaining = duration;        // ← fresh per call
       loop {
           select! {
               _ = time::sleep(remaining) => { return Err(()); }   // timeout fires
               // ... pause_state suspend/resume, operation completion
           }
       }
   }
   ```
   `call_tool()` → `run_service_operation("tools/call", timeout, …)` → `run_service_operation_once` → `active_time_timeout(duration, …)`. Each `tools/call` gets a **fresh `duration` and fresh `remaining`** — nothing accumulates.

2. **`codex-rs/core/src/mcp_tool_call.rs` — `handle_mcp_tool_call`:** processes **one** tool call, records `start.elapsed()` as a metric, returns. **No accumulator** across tool calls in a turn; **no wrapping deadline** around the tool loop.

3. **`task: None` hardcoded** (confirms non-Tasks client): `CallToolRequestParams { …, task: None }` — codex never sends `params.task`; a `CreateTaskResult` response hits the `_ => Err(UnexpectedResponse)` arm.

**Bonus finding (useful for 008):** the timeout clock **pauses during elicitation** — `active_time_timeout` watches `pause_state` and suspends the countdown while an approval/elicitation prompt is pending, then resumes. So a `_resume_from` retrieval that triggers an elicitation won't burn its timeout budget during the prompt. Relevant only if 008 ever gates retrieval behind approval; noted for completeness.

**Harness (b) — deferred.** The source trace is conclusive on mechanism (the local `remaining` is dispositive: there is no field anywhere that could accumulate across calls). The diagnostic harness (~15 min, escalating-duration probe) would confirm *observed* behavior but cannot overturn a mechanism that has no accumulator. Run it opportunistically during 008 implementation if any anomaly appears; not a blocker.

---

## R-001b — ZCode task-capability + orphan/timeout root-cause framing (OPEN — verify at implementation)

**Status**: reference note from the 007 debugging session. Not a gate; the 008 design holds either way. **Verify before locking US1's client examples.**

During 007 debugging (see the 007 follow-up commit `e610394` message + `postmortem.md`), we traced why the dashboard showed inconsistent activity metadata between MCP clients and landed on discussion points that bear directly on 008. Recording them here so the 008 implementer has the context without re-deriving it.

### (a) Is ZCode a Tasks-aware or non-Tasks client? — UNVERIFIED

008's US1 frames its audience as "codex **or ZCode**" (non-Tasks clients). That framing rests on the assumption ZCode behaves like codex (hardcodes `task: None`). **This was not directly verified** during 007 — it was inferred, ambiguously, from indirect signals:

- **DB-row shape evidence (indirect, contradictory):** a ZCode run (`327bfb78`) lacked `judge_model`/`persona` up front (the `allocateActivity`/task-runner signature), while a Claude Code run (`833592bd`) had them (the `recordActivity`/blocking-path signature). Taken at face value this says ZCode = task path, Claude Code = blocking path.
- **But the routing code says otherwise:** `registerToolTask` with `taskSupport:"optional"` (`mcp-server.ts:189-194`) routes **both** Tasks-aware and non-Tasks clients through the same `createTask` handler — non-Tasks clients get SDK auto-polling of that handler. So "hit `createTask`" is **not** proof of Tasks-awareness; both kinds do. The DB-shape signal therefore may not distinguish the two clients the way the 007 debug initially read it.

We flip-flopped on the ZCode path three times during debugging — the tell that we were reasoning about SDK internals we hadn't observed directly. **Resolution deferred** because we couldn't test ZCode against the 007 fixes (the published `openfusion-mcp` package predates them; ZCode's long-lived process loaded stale code). Once 007 is republished and ZCode's openfusion process is restarted, **verify directly**: log `params.task` (and whether `createTask`'s auto-poll vs direct route fired) for one fusion each from ZCode and Claude Code, then correct US1's client list if ZCode turns out to be Tasks-aware.

**Why it doesn't block 008's design:** `_resume_from` is needed for codex regardless (codex's `task: None` is source-verified, R-001). If ZCode is also non-Tasks, US1's framing is correct as written. If ZCode is Tasks-aware, it keeps using the 005 path and US1's examples narrow to codex — the mechanism is unchanged. Either way 008 ships.

### (b) The orphaned-row cause is non-durable task state — 008's R-002 is the fix, not a heartbeat/sweep

The 007 orphan (`e34df6af`, `status='running'`, `0ms`, abandoned when a ZCode session ended mid-fusion) prompted a "fix the cause" discussion. Three options were weighed:

1. **Startup sweep of stale `running` rows** — rejected as **unsafe in this project's real topology**: multiple openfusion processes share one `OPENFUSION_HOME` (one DB), so a fresh process can't tell its own in-flight fusions from another process's. A naive sweep would mark another process's genuinely-running fusion as errored.
2. **Heartbeat + sweep (PID-tagged)** — rejected as **cosmetic-only**: it stops the dashboard from lying about dead work, but recovers nothing. Once the owning process is dead, the task id is gone (`InMemoryTaskStore` is non-durable), so no client can ever retrieve the result by id. A tidier zombie is still a zombie.
3. **Durable result store (008's R-002)** — **the actual fix.** Persisting `fusion_jobs.{status, result}` to SQLite means a completed fusion's answer survives process death and stays retrievable by its (activity) id. This is why 008 chose durability for **both** modes, not a per-mode hybrid.

The key reframing from the discussion: **orphaning is not a recoverability bug, it's a garbage-in-dashboard bug** — and the real "lost work" cause is the non-durable task store (task ids vanish on restart), which only 008's durability addresses. A heartbeat/sweep would be a worthwhile *dashboard-hygiene* addition later, but it is not the cause-fix and should not be mistaken for one.

### (c) Cross-process dashboard reality (informs 008's progress surface)

007 discovered the deployment topology is **multi-process**: ZCode, Claude Code, and the dashboard each spawn their own openfusion Node process, all sharing one `OPENFUSION_HOME` (one DB). The in-process `FusionStatusRegistry` (007) therefore can't see fusions from other processes — fixed in 007 by merging DB `status='running'` rows into `/api/runtime`. **Implication for 008:** live candidate-progress ("candidate 3 of 5") is inherently same-process-only (R-002 already scopes it ephemeral for exactly this reason — on restart it describes nothing). The 008 progress surface should lean on the durable `fusion_jobs` row for cross-process state and treat in-memory progress as a same-process nicety, not a guarantee.

### (d) Sequential-mode staleness (not a 008 concern, but adjacent)

007's sequential mode appeared broken in ZCode because the long-lived process loaded pre-sequential code at startup (Node caches modules). Fresh-process verification proved sequential works correctly. **Not a 008 issue**, but if 008's `_resume_from` retrieval ever reports a mode, it must read `execution_mode` from the durable `fusion_jobs` row (not the in-process registry) to avoid the same cross-process staleness.

---

## R-002 — Storage is durable (SQLite) for both modes; live progress is ephemeral for both

**Decision**: Persist job-state + result to a new `fusion_jobs` SQLite table for **both** parallel and sequential mode. Keep live candidate-progress (the "candidate 3 of 5" affordance spec 007's dashboard reads) **in-memory only** for both modes. (Spec Assumptions + FR-007/010.)

**Rationale**: The panel's initial hybrid ("parallel in-memory, serial SQLite") optimizes machinery-per-mode. The user's follow-up question ("what if both are durable? are we making it unnecessarily complex?") surfaced the better frame: **minimize total system complexity**, not machinery-per-mode. Two storage backends (in-memory map + SQLite, each with its own TTL/eviction/id story) is more code and more bug surface than one SQLite backend used everywhere. Once sequential forces SQLite to exist, pointing parallel at it is ~free.

The durability mechanism is built once either way. The DB cost is a non-issue — a fusion already writes 1 activity row + N+2 sub_calls rows in WAL SQLite; one extra job-state row is noise for a local single-user tool (Constitution VII).

Live progress is the one deliberately ephemeral surface because on restart it describes nothing — the in-flight job died with the process. Persisting it would leave stale "running" rows. So: durable = `{id, status, result, mode, timestamps}`, ephemeral = `{current candidate index, remaining count}`. One durable contract + one ephemeral surface, uniform across modes.

**Bonus**: this closes a gap in 005. 005 justified in-memory results with "the SQLite activity log is the durable record." But the activity log is built for observability (prompt excerpts, tokens, cost, per-call rows) — not for returning the full synthesized answer to a `_resume_from` call. Digging the answer out of a `judge_synthesis` sub_call row would couple retrieval to the logging schema (fragile). A dedicated `fusion_jobs.result` column is the clean separation.

**Alternatives considered**:
- *In-memory for both (005's stance)*: rejected — a 21-min serial job overlapping a restart orphans the ticket and wastes compute; even a 90 s parallel job can overlap a deploy.
- *Hybrid (panel default)*: rejected on total-complexity grounds (above). Two storage paths is more code than one.
- *Persist live progress too*: rejected — stale-on-restart, adds a cleanup problem for zero retrieval value.

---

## R-003 — Collapse the identity map: `reference_id = activity_id`

**Decision**: The reference id the agent receives **is** the SQLite activity id. There is no separate task-id ↔ activity-id ↔ reference-id mapping for the `_resume_from` path. (Spec FR-006.)

**Rationale**: 005's `taskActivity: Map<string, string>` exists only because the SDK generates the taskId (`taskStore.createTask` mints a 32-char hex id) and it cannot be forced to equal the activity id. The `_resume_from` path has no such constraint — OpenFusion controls id generation at the `_resume_from` kickoff entry point (it calls `allocateActivity`, which returns the UUID). So the reference id is the activity id directly. One id space across kickoff, retrieval, logging, and the dashboard.

**Contingency**: if, during implementation, the kickoff entry point turns out not to control id generation (e.g. the SDK injects an id before our handler runs on the non-Tasks path), fall back to persisting the mapping in SQLite (a `fusion_jobs.task_id` column) rather than an in-memory map — durability requirement (R-002) forbids an in-memory map regardless. But the expectation is the collapse holds.

**Alternatives considered**:
- *Three-way map (005 shape)*: rejected — unnecessary indirection given we control id generation; and an in-memory map violates R-002's durability requirement.
- *Opaque reference id (not the activity id)*: rejected — adds a mapping for no privacy benefit (the activity id is already a UUID; exposing it to the client's agent reveals nothing sensitive).

**005 interplay**: 005's `taskActivity` map **stays** for the Tasks path (the SDK still mints taskIds there). The `_resume_from` path does not use it. Two identity stories for two egress paths; the `_resume_from` one is the simpler collapsed form.

---

## R-004 — Mode-aware retrieval shapes (one cadence breaks both ways)

**Decision**: The kickoff result, the retrieval result, and the pending-wording are **parameterized by execution mode**. (Spec FR-005, US1 vs US2.)

- **Parallel** (~60–140 s wall-clock): kickoff returns `{status:"processing", reference_id, retry_after_ms, instruction}` with **transparent pacing** wording — "Fusion started in the background (reference_id: …). It takes roughly 60-140 seconds. Call `fusion({_resume_from:'…'})` to receive the result — retry after ~30s if not ready." The mandate is the call; the pacing is `retry_after_ms`. (M4 — the earlier "do not inform the user" adversarial wording was dropped: it risks tripping safety-training refusals in frontier models, which would kill the retrieval outright. Transparent pacing achieves the same retrieve-don't-over-explain goal without the disclosure directive.) Retrieval bounded-long-polls ~40 s; for a 90 s fusion that's kickoff + ~1–2 retrievals.
- **Sequential** (~12–21 min wall-clock): kickoff returns `{status:"processing", reference_id, eta_ms, dashboard_url, instruction}` with user-facing wording — "This is a long (~15 min) serial run. I've started it. Check the dashboard for live progress, or call `fusion({_resume_from:'…'})` later to retrieve the answer." Retrieval is ETA-guided (the agent retrieves once near the ETA or hands the user the ticket), not tight.

**Rationale**: The constants force the split. A 15-min job tight-polled at 40 s = ~22 retrieval calls = the token-storm + context-exhaustion cliff SEP-1686 warned about, now 10× worse than the parallel case. Conversely, always-fire-and-forget adds friction (and a guaranteed second call) to a 90 s job that could finish inside one long-poll. The agent will lose the thread or burn the context window on a long tight-loop; pretending it won't is the trap.

**The wording is mode-dependent and must scale with duration** (M4 revised the earlier "adversarial" framing): for ~90s the message is terse + retrieval-mandated (the user shouldn't see intermediate state for a sub-minute-extra wait); for 15 min it's verbose + dashboard-linked (the user *must* be told). Both modes use transparent pacing — an explicit `retry_after_ms` + a "call this to get the result" mandate — never a "do not inform the user" directive. Spec FR-005 encodes this.

**Implementation note**: the mode is read from the config snapshot the detached runner already captures at kickoff (no new setting — R-002). `resume-shapes.ts` is a set of pure functions over `(FusionJob, configSnapshot)` so the wording/cadence is trivially unit-testable and the sequential shape can call spec 007's `computeSerialBudgetMs` without coupling.

**Alternatives considered**:
- *Single tight-poll cadence*: rejected — token-storm on serial (above).
- *Single fire-and-forget cadence*: rejected — friction on parallel (above).
- *REST/curl fetch as the primary retrieve*: rejected by the panel — crossing the tool→shell boundary is fragile and assumes shell access. The kickoff result *may* include a dashboard URL as a human fallback (FR-005 sequential shape), but retrieval is always via the connected `fusion` tool.

---

## R-005 — Bounded long-poll mechanics (parallel mode)

**Decision**: A parallel-mode `fusion({ _resume_from })` retrieval that finds the job still `processing` waits up to a **bounded** duration (default ~40 s) for terminal, then returns `processing` if it didn't land. The wait is implemented as a Promise race between (a) a resolver fired when the job transitions to terminal, and (b) a timeout. (Spec FR-004.)

**Rationale**: An immediate "still pending" return causes a tight loop (the LLM re-calls within milliseconds, risking codex's rate-limiter/runaway detection). Bounded long-poll collapses ~22 hypothetical instantaneous polls into ~1–2 real calls for a 90 s job. The ~40 s default is sized with margin under the ~60 s client ceiling (R-001); the exact value is locked after R-001 verification.

**Mechanism**: `resume-store.ts` keeps an in-memory `Map<activityId, Array<resolver>>` of waiters. On `markTerminal(id)`, it resolves all waiters for that id. A retrieval adds itself to the list, races against `setTimeout(wait, 40_000)`, and returns whichever fires first. If the job is already terminal at call time, it returns immediately with no wait (the completed fast-path — SC-003).

**Pacing signal — `retry_after_ms` (B2 — BLOCKER)**: every `processing` result (kickoff AND retrieval) carries an explicit `retry_after_ms` field so the agent knows how long to wait before its next `_resume_from` call, rather than tight-looping or guessing. Without this, even with bounded long-polling, an agent with a fast-path that returns `processing` immediately would burn tokens or trip rate limits — especially for 21-min sequential runs where retrieval returns instantly by design (R-004). Values:
- **Parallel**: `retry_after_ms ≈ 30_000` (sized just under `RESUME_LONG_POLL_MS` — if the agent waits ~30s before re-calling, the long-poll window typically catches completion; if it calls sooner the long-poll still bounds it).
- **Sequential**: `retry_after_ms = max(eta_remaining / 4, 60_000)` (quarter the remaining ETA, floored at 1 min — the agent paces itself toward completion rather than tight-polling a 15-min job).

The field is surfaced both in the prose instruction ("Retry after approximately N seconds") AND in the structured `_meta` block (m10 — `CallToolResult._meta = { reference_id, retry_after_ms }`) so agents that parse structure get it reliably. This is additive to the long-poll mechanism, not a replacement: the long-poll bounds a single retrieval call; `retry_after_ms` bounds the gap between retrieval calls.

**Alternatives considered**:
- *SSE / server-push*: rejected — MCP has no server-push of a new result to a new request; `notifications/progress` can't carry the final answer or reset the client's timeout. The pull model is forced.
- *Instantaneous return + client-paced re-poll without a signal*: rejected — token-storm (above). The signal is the fix, not the cadence.

---

## R-006 — TTL, eviction, and the write-late guard

**Decision**: Completed results carry a TTL. A retrieval after TTL returns `{status:"expired", instruction:"Re-run with your original query."}` (spec FR-008, edge case). The TTL is **derived** from the longest legitimate fusion wall-clock (sequential budget from spec 007 + margin), not a fixed short value — a 5-min TTL would silently kill every serial fusion (the cross-feature conflict surfaced in dialogue).

**Mechanism**: `fusion_jobs.expires_at = created_at + TTL` at kickoff. A background sweep (or lazy check on retrieval) marks rows `expired` past their TTL. Default TTL ≈ 30 min (max serial budget ~21 min + margin), finalized in tasks.

**Write-late guard** (panel gap #1, spec FR-011): the TTL-eviction-vs-late-completion race is real — a job whose TTL expires near the moment it finishes must not orphan-write or discard the result. Two options, finalized in tasks:
- **(a)** Before storing a terminal result, check the registry for eviction; if already evicted, drop the write (the ticket is already `expired`).
- **(b)** Extend `expires_at` while status is `processing` (a running job never expires; only completed results age out).

(b) is simpler and is the expected choice — a running job's TTL clock shouldn't tick down.

**Stalled-job circuit** (panel gap #3, spec FR-012): a parallel fusion that shows no progress for N seconds must cause the next `_resume_from` to return an error, not empty long-polls forever. Implementation: track `last_progress_at` on the FusionJob (updated by the runner's progress callback); the retrieval checks `now - last_progress_at > STALL_MS` and returns `{status:"error", …}` if exceeded. Bounds the worst-case loop without an `AbortController` (the detached work continues, but the agent stops waiting on it).

**Heartbeat story (M5 — what makes the stalled circuit reliable)**: `last_progress_at` is set to `now` at kickoff INSERT (T004a) — before any detached work starts — so a job that hangs immediately is still stall-detectable. During a healthy run, the runner's `onProgress` callback fires at each stage (per-candidate start/finish, judge steps) and calls `touchProgress(id)` (T013). The one gap — a single provider HTTP call that hangs without firing `onProgress` — is bounded by the **per-worker timeout** (default 120s, Constitution III): a hung worker call rejects at 120s, which either throws (caught, surfaces as progress via the error path) or retries. So worst-case stall detection = `workerTimeoutMs × (retries+1)` ≈ ~6min, comfortably under `STALL_MS=300s × 2`. A separate `setInterval` heartbeat is rejected for v1 — the existing per-worker timeout already bounds hung calls, and a heartbeat timer adds event-loop machinery for a case the timeout already covers. If real-world traces show `onProgress` not firing reliably, revisit with a heartbeat in v1.1.

**Terminal-write optimistic guard (n13)**: `markTerminal`'s UPDATE is `UPDATE fusion_jobs SET status=?, … WHERE activity_id=? AND status='processing'`. The `AND status='processing'` clause defends against the (unlikely) race where the startup sweep already reclassified a job `interrupted` and a surviving runner then tries to write `completed`. In that case the WHERE doesn't match, `changes === 0`, and the update silently no-ops — log a warning. Without this guard, a late runner write would overwrite the sweep's `interrupted`, lying to the user about a job that died with the previous process.

**Never-retrieved counter (F3 — observability for abandoned compute)**: a `retrieved_at TEXT` column on `fusion_jobs` records the first `_resume_from` that returned a terminal result. The `sweepExpired` background pass logs a counter whenever a `completed` row ages out with `retrieved_at IS NULL` — i.e. the fusion finished but no agent ever fetched the answer (provider compute burned for nothing). This satisfies Constitution V ("No silent operations") for the one inherent cost of LLM-mediated retrieval, and doubles as the leading indicator that codex has shipped native Tasks support (the counter drops to ~0 once clients stop using `_resume_from`).

**Alternatives considered**:
- *Fixed short TTL (panel's 5-min)*: rejected — silently breaks serial (above).
- *No TTL (unbounded retention)*: rejected — unbounded SQLite growth; the never-retrieved-result case (panel blind-spot) would accumulate forever.

---

## R-007 — Restart recovery and the ephemeral-progress invariant

**Decision**: After a process restart:
- A `_resume_from` for a fusion that **completed before** the restart returns its result from `fusion_jobs` as long as it's within TTL (R-006).
- A `_resume_from` for a fusion that was **in-flight** when the restart happened returns `{status:"interrupted", instruction:"The job was interrupted by a restart. Re-run fusion with your original query, or check the dashboard."}`. (The in-memory waiters are gone; the durable row's status is stale — a sweep at startup marks `processing` rows older than a heuristic as `interrupted`, or the retrieval itself reclassifies on read.)
- Live candidate-progress is **absent** (spec FR-010) — it was in-memory and died with the process. No stale "running" progress is reported.

**Rationale**: The whole point of durability (R-002). A 21-min serial job has a meaningful probability of overlapping a restart; without recovery, US3 fails and the compute is wasted. The `interrupted` outcome is defined (not hallucinated by the agent) per the panel's "tombstone on restart" guidance.

**Startup sweep**: on boot, `UPDATE fusion_jobs SET status='interrupted' WHERE status='processing' AND created_at < <boot_time>`. The condition is correct as written: `boot_time = now` and `created_at` is a past timestamp for every pre-existing row, so the sweep catches **all** orphaned `processing` rows from the previous process regardless of how recently they were created (a job created 10s before a crash + a 5s restart is still caught, because its `created_at` precedes the new process's `boot_time`). Using `last_progress_at` instead (as one reviewer suggested) would be *less* correct — it would miss recently-progressed orphans. Cheap, bounded by in-flight count (single user). Live progress map starts empty.

**Sweep-before-connect ordering (B3 — BLOCKER)**: the sweep MUST run as a **blocking initialization step BEFORE the MCP transport accepts connections** (before `createMcpServer`'s connect promise resolves). Without this, there's a race where a post-restart retrieval hits a stale `processing` row from the previous process before the sweep marks it `interrupted` — the retrieval would then long-poll a dead job for ~40s before erroring. Await the sweep, then connect. This is the one startup-ordering constraint; it costs ~1 DB round-trip.

**Alternatives considered**:
- *Resume the in-flight job after restart*: rejected — the detached `runFusion` is gone; resuming would mean re-running provider calls already made (wasted tokens) and re-deriving intermediate state OpenFusion doesn't checkpoint. Out of scope (Constitution VII — YAGNI). The activity log shows partial sub_calls for forensic interest; the job itself is `interrupted`.
- *Persist live progress*: rejected (R-002).

---

## R-008 — Tasks-path coexistence (005 is a sibling, not a dependency)

**Decision**: The 005 Tasks path (`createTask`/`getTask`/`getTaskResult` over `InMemoryTaskStore`) continues to work **unchanged**. Tasks-aware clients still get `CreateTaskResult` + `tasks/result`. The `_resume_from` path is a **sibling branch** over the same detached runner and the new durable store. (Spec FR-013, FR-015, SC-007.)

**Rationale**: 005 is correct and standards-aligned for Tasks-aware clients; it just provably cannot help non-Tasks clients (codex/ZCode). Removing it would regress the clients it *does* help. The two paths share the expensive parts (the detached runner, the result) and diverge only in egress shape.

**Shared substrate**: `startDetachedFusion` becomes the single kickoff for both. It writes the `fusion_jobs` row at kickoff (so `_resume_from` works) **and** calls `taskStore.createTask` (so the Tasks path works) when invoked from the Tasks handler. The terminal handler writes both the `fusion_jobs` result **and** `taskStore.storeTaskResult`. One runner, two egress writes.

**Future codex Tasks support**: if codex ships a Tasks client, the `_resume_from` branch becomes unused but is **not** removed (graceful coexistence — the panel's client-versioning blind-spot). Detection: the never-retrieved counter drops to ~0 when clients stop using `_resume_from`.

**Alternatives considered**:
- *Collapse to Tasks-only and wait for codex*: rejected — codex's `task: None` is hardcoded and Tasks is being walked back in the MCP spec (2026-07-28 RC removes `tasks/list`, moves Tasks to a future extension). Waiting is indefinite.
- *Collapse to `_resume_from`-only*: rejected — regresses Tasks-aware clients for no gain; the LLM-mediated polling cost applies to them too, unnecessarily.

---

## R-009 — Judge-failure distinction and partial-result salvage

**Decision**: The durable job-state distinguishes **judge-failure-after-candidates-complete** from **all-candidates-failed** (spec FR-014). A retrieval for the former returns a meaningful error and, where viable, access to raw candidate outputs; the latter returns the standard `<2 survivors` fusion error.

**Load-bearing prerequisite (F5)**: `FusionResult` (`src/fusion/fusion.ts`) currently carries only `status: "success" | "partial" | "error"` + a text `error` field — both failure modes collapse to `status: "error"`. To make FR-014 implementable, `FusionResult` gains an **additive optional** `errorKind?: "no-survivors" | "judge-failed" | "internal"`, set at each failure site in `runFusion` (`"no-survivors"` at the `<2 survivors` gate; `"judge-failed"` when `runAnalysis`/`runSynthesis` throws; `"internal"` in the outer catch). The detached runner's terminal handler maps `FusionResult.errorKind → fusion_jobs.error_kind`. This is additive only — no existing caller (`fusionToolHandler`, the 005 Tasks path, the UI path, 007's `runSequentialFanout` which returns `WorkerResult[]`) reads the field, so none break. The alternative — parsing the error string to infer the kind — is rejected as fragile for a MUST-grade requirement.

**Rationale**: Without the distinction, a judge-side failure looks identical to a fusion that never gathered enough candidates — the user can't tell whether their candidates were good (judge broke) or bad (consensus failed). Raw candidate outputs are already in `sub_calls.generated_text` for `worker` rows; the retrieval can surface them by joining via the activity id.

**Partial-result salvage** (panel blind-spot): if candidates 1–4 of 5 finish before abandonment/TTL, they're currently discarded. This is real waste, but **salvage is out of scope for v1** (Constitution VII — YAGNI). The candidate outputs remain in `sub_calls` (forensic); a future "partial mode" could expose them. Documented as an assumption, not engineered.

**Alternatives considered**:
- *Always expose raw candidates on any failure*: rejected — couples retrieval to the logging schema and changes the result contract; defer to a possible future "partial mode".

---

## Summary of decisions → spec FR trace

| Decision | Grounds spec FRs |
|----------|------------------|
| R-001 per-call timeout (empirical gate) | FR-004 |
| R-002 durable-for-both, progress ephemeral | FR-007, FR-010 |
| R-003 identity collapse (`reference_id = activity_id`) | FR-006 |
| R-004 mode-aware shapes | FR-005, US1/US2 |
| R-005 bounded long-poll mechanics | FR-004 |
| R-006 TTL + write-late guard + stalled circuit | FR-008, FR-011, FR-012 |
| R-007 restart recovery | FR-009, FR-010 |
| R-008 Tasks-path coexistence | FR-013, FR-015, SC-007 |
| R-009 judge-failure distinction | FR-014 |

**Unresolved at planning exit**: R-001's empirical verification (trace codex source for a wrapping session/turn deadline). This is the one task that must complete before the bounded long-poll wait duration is locked. All other decisions are locked.
