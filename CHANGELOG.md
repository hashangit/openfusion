# Changelog

All notable changes to OpenFusion are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Async fusion results via deferred retrieval (feature 008)** — the `fusion` tool's new optional `_resume_from` arg gives non-Tasks clients (codex/ZCode, which hardcode `task:None`) a deferred-result protocol that sidesteps the client's tool-call timeout. A kickoff `fusion({prompt})` returns in ~1s with a `processing` shape carrying a `reference_id`; the agent retrieves the synthesized answer via `fusion({_resume_from: "<id>"})`. Parallel retrievals bounded-long-poll (~45s, under the ~60s codex per-call ceiling) so a ~90s fusion returns in ≤3 LLM round-trips; sequential retrievals are ETA-guided (immediate return with a refined remaining ETA + dashboard link). The result is byte-identical to the blocking path and to the 005 Tasks path. Tasks-aware clients are unaffected (they still get `CreateTaskResult` + `tasks/result` — FR-013). Details in `specs/008-async-fusion-results/`.
- **`fusion_jobs` table** (migration `005_fusion_jobs`) — durable job-state for the deferred-result path, keyed by the activity id (= the reference id). One row per deferred fusion: `status` (processing → completed/error/interrupted/expired), `execution_mode`, `result`, `result_is_error`, `error_kind`, `eta_ms`, `retrieved_at`, plus TTL + progress timestamps and a per-row `stall_threshold_ms`. Additive (`CREATE TABLE IF NOT EXISTS`); no change to `activities`/`sub_calls`.
- **`FusionResult.errorKind`** (`no-survivors` | `judge-failed` | `internal`) — a structural failure kind on `!ok` results, flowing to `fusion_jobs.error_kind` so the durable record distinguishes judge-failure-after-candidates-complete from all-candidates-failed (FR-014). Additive; existing callers ignore it.
- **Startup sweep** — at boot, every `processing` `fusion_jobs` row from a previous process is reclassified to `interrupted`, so a post-restart retrieval returns a clear restart message instead of hanging on a dead job (FR-009).
- **Stalled circuit (per-row threshold)** — a `processing` row whose `last_progress_at` is older than its `stall_threshold_ms` is lazily reclassified to `error/stalled` on read, so a hung fusion can't empty long-poll forever (FR-012). The threshold is computed at kickoff as `max(RESUME_STALL_MS, workerTimeoutMs × 3)` and stored per-row, so it correctly accommodates the legitimate inter-callback gap in BOTH modes — parallel (a slow worker exhausting all retries) and sequential (a single candidate running 3–9 min with no mid-candidate report). A speculative `stalled` reclassification is overridable: if the runner genuinely completes later, `markTerminal`'s `completed` write wins over the stall guess (interrupted/expired are authoritative and never overridden).
- **Write-late guard** — `markTerminal` extends `expires_at` for a `processing` row near eviction before storing the terminal result, so a late completion lands as `completed` rather than `expired` (FR-011). Job length is uncapped.
- **Never-retrieved counter** — when a `completed` row ages out past TTL without ever being retrieved, a metric is logged to stderr (Constitution V: no silent ops; the leading indicator that clients have shipped native Tasks support).

### Changed
- **`fusion` tool `prompt` is now optional** when `_resume_from` is present (FR-002 — the agent must not resend the full prompt on every poll). A fresh kickoff still requires `prompt`; the retrieval branch enforces this at runtime and ignores `prompt`/`context`/`persona` when `_resume_from` is set.
- **`fusion` tool description** now mentions the `_resume_from` retrieval path so agents discover it from the schema. Still strictly shorter than the pre-006 description (SC-006).
- **`startDetachedFusion`** now writes the `fusion_jobs` kickoff row first (before `taskStore.createTask`), accepts an optional `KickoffContext` (`executionMode` + `etaMs` + `stallThresholdMs`), makes the `extra` (Tasks handler) optional so the non-Tasks kickoff path skips the Tasks substrate entirely, and returns `{ task, activityId }` so the kickoff site builds the shape with the correct reference id (identity collapse — the runner owns the id).
- **Known limitation revised** — the "Tasks are non-durable" caveat now scopes to the 005 Tasks path only; feature 008's `_resume_from` path IS durable and survives restarts.

### SDK coupling (load-bearing)
- **`src/fusion/resume-dispatch.ts`** replaces the SDK's installed `CallToolRequest` handler post-registration to intercept non-Tasks fusion calls before the SDK's `handleAutomaticTaskPolling` blocks (that blocking loop is the codex/ZCode timeout bug 008 fixes). The wrapper captures the SDK's handler, routes non-Tasks fusion calls to kickoff/retrieval, and delegates Tasks clients + other tools unchanged. Reaches into `server.server._requestHandlers.get("tools/call")` — a deliberate, documented coupling. A dispatch canary test catches shape changes at test time. **On `@modelcontextprotocol/sdk` upgrade**, verify the handler install timing, key, and blocking-auto-poll behavior (see `resume-dispatch.ts` header).

## [0.3.0] - 2026-06-19

### Added
- **Async non-blocking fusion via MCP Tasks (SEP-1686)** — the `fusion` tool is now registered with `server.experimental.tasks.registerToolTask` and `taskSupport: 'optional'`. A Tasks-aware client (e.g. Claude Code) receives a `CreateTaskResult` immediately and fetches the result via `tasks/get` + `tasks/result`, so a 2–10 minute fusion no longer trips the client's tool-call timeout. Non-Tasks clients are unaffected — the SDK auto-polls the same handler and returns the final `CallToolResult` (blocking, byte-for-byte unchanged). Verified end-to-end: a 452-second Claude Code fusion returned successfully where the previous blocking path would have been killed at the client ceiling.
- **Detached fusion runner** (`src/fusion/task-runner.ts`) — allocates an `activities` row up front (`status='running'`), fires-and-forgets `runFusion` on the Node event loop (same process; no worker threads), forwards progress via `updateTaskStatus`, and stores the terminal `CallToolResult` (success or `isError` on failure). A module-level `Map<taskId, activityId>` correlates the two ids; `drainTasks()` awaits in-flight fusions for deterministic teardown.
- **No-hang guarantee (FR-009)** — the detached runner's outer catch always transitions the task to a terminal `failed` state, so a task can never stick in `working` past its bounded lifetime (worker timeout × retries + judge).
- **`activities.status='running'`** — the free-text status column now records in-flight fusions before they resolve (no migration; the column was already unconstrained `TEXT`).
- **`list_personas` MCP tool** — read-only persona discovery. Returns a JSON array of `{id, name, description, builtin, active}` so an agent can enumerate available personas (including user-defined customs) and pick a suitable one before calling `fusion`. Deliberately excludes prompt text — agents pick by name + description, keeping the response token-light. Exactly one entry has `active:true`. Discovery is never gated by the persona policy.
- **Persona policy** — a new `config.settings.personaPolicy` (`"strict" | "allow-override"`, default `"allow-override"`) governing whether MCP clients may override the dashboard's active persona per fusion. Exposed as a toggle on the Personas tab with helper text clarifying it gates MCP clients only.
- **Strict-mode enforcement (warn + continue, never block)** — when `strict` and a client requests a different persona, OpenFusion runs the active persona instead, records `persona_source="strict-enforced"`, and emits a `notifications/message` warning carrying `{requested, used, reason}`. If the client advertises the `elicitation.form` capability, the user is asked **once per session** whether to relax strict for the session (a shared in-flight promise dedupes concurrent callers, so N simultaneous fusions trigger exactly one prompt). The opt-in is in-memory only — it never mutates the global policy.
- **`persona_source` audit column** (migration `004_add_persona_source`) — each fusion now records *how* the persona was chosen: `active`, `override`, `strict-enforced`, or `invalid-fallback` (NULL for pre-0.3.0 fusions). Surfaced in the Generations tab as a chip suffix: `◈ qa (client override)`, `◈ researcher (strict-enforced)`, etc.
- **Skill: persona 2-call pattern** — `SKILL.md` now teaches discover-then-use (`list_personas` → `fusion(persona)`), with progressive disclosure via a new `references/personas.md` covering when each builtin wins and how the policy affects the call.
- **New builtin persona: System Architect / Principal Engineer** (`id: "architect"`) — candidates counsel as principal engineers reading the proposed plan against the *whole* application (every system, layer, boundary), assessing cross-cutting concerns, hidden coupling, blast radius, and sequencing/migration risk; the judge consolidates one holistic architectural consultation. Brings the shipped set to five.

### Changed
- **`runFusion` accepts an optional `activityId`** — when provided (task path), it writes against a pre-allocated `running` row instead of inserting its own. The legacy blocking path (no `activityId`) is unchanged. Fusion semantics — fan-out (`Promise.allSettled`, ≥2 survivors), two-step judge, persona resolution, config gate — are identical on both paths; only *when* `tools/call` returns differs.
- **MCP server constructor** now passes an `InMemoryTaskStore` and declares the `tasks.requests.tools.call` capability (object `{}`, not boolean — the SDK's experimental `registerToolTask` does not auto-declare it).
- **`updateActivity`** now permits `candidate_count` in its patch (so a pre-allocated row's metadata can be aligned after fan-out resolves the enabled set).
- **Config schema v3 → v4** with automatic migration: injects `settings.personaPolicy: "allow-override"` on load (a notice prints if a v3 file is upgraded).
- **`fusion` tool description trimmed** — the inline persona id enumeration (`qa`, `researcher`, `pm`) is removed in favor of a discovery nudge ("call `list_personas` first; pass `persona=<id>` to override"). The new description is strictly shorter and always accurate (custom personas no longer invisible to the client).
- **`GET /api/personas`** now also returns `personaPolicy` alongside `activePersona`.
- **`activities.persona_source`** flows through the activity list + detail API responses and the UI `Activity` type.

### Fixed
- **Dashboard charts no longer freeze** — the cost/token-by-model charts fetched `/api/stats` only on mount and manual Refresh, so they were frozen at the last page-load snapshot and never reflected fusions that landed while the user was away. Added a `visibilitychange` listener that re-fetches when the tab regains focus. (Data, API, and rendering were all correct; only the re-fetch trigger was missing.)
- **Invalid persona ids are now visible, not silent** — a wrong id still never errors (the active persona runs, preserving the never-throws contract), but it now records `persona_source="invalid-fallback"` and emits a warning, so the fallback is auditable instead of indistinguishable from a correct override.
- **Persona policy now has a single enforcement site** — the check lives inside `runFusion` (not the MCP handler), so both the blocking fusion path and the task-augmented path (`registerToolTask`, feature 005) enforce it identically. UI-triggered fusions are exempt via a `source:"ui"` flag (the user is the picker).
- **`list_personas` no longer shadows newly shipped builtins** — the handler used `config.personas ?? BUILTIN_PERSONAS` (a nullish fallback), so a v3 config that persists its persona list on disk would hide any builtin absent from that list — the new `architect` persona never appeared via the MCP tool even though it was in code. Now merges missing builtins in (mirroring the REST `withBuiltins` path), so MCP and UI agree. User-authored personas were never affected (they're in the persisted list and pass straight through). Covered by a new regression test in `tests/persona-discovery.test.ts`.

### Documentation
- **`AGENTS.md`** — the `fusion` Tool section now documents the task-capable contract and three v1 limitations: tasks are non-durable (`InMemoryTaskStore` + in-process map, lost on restart; `activities` row is the durable record), event-loop blocking under concurrent load (`better-sqlite3` is synchronous), and no `tasks/cancel` wiring (scoped as a possible v1.1 addition).
- **`skill/SKILL.md`** — notes that long calls are non-blocking on Tasks-aware clients (the host handles polling transparently; the agent calls `fusion` as normal).
- **Full design artifacts** for feature 005 under `specs/005-mcp-tasks-sep/` (spec, plan, research, data-model, contracts, quickstart, tasks), including `research.md` R-010 documenting the three SDK capability-wiring prerequisites verified by a throwaway probe.

### Tested
- **64/64 tests passing** (57 pre-existing + 7 new in `tests/fusion-tasks.test.ts`): `CreateTaskResult` sync return, `tasks/result` fetch + single activity row + N+2 sub_calls, non-Tasks blocking fallback, survival/config-gate/idempotent failure handling, and best-effort progress observation.


### Added (feature 007 — sequential processing)
- **Sequential execution mode** (`config.settings.executionMode`, default `"parallel"`) — candidates run **one at a time** in slot order instead of concurrently. An opt-in for low-VRAM machines running local models (Ollama/llama.cpp) where simultaneous model loads OOM. Parallel remains the byte-for-byte unchanged default (optimal for cloud). Exposed as a Candidates-page toggle mirroring Benchmark Mode, with dynamic helper text showing the expected total wall-clock ("~Xm total — N candidates × 3m + 6m judging"). Sequential and Benchmark are independently combinable.
- **Serial time budget** (`computeSerialBudgetMs = 3min × N + 6min`, `src/fusion/fanout.ts`) — in sequential mode, an outer wall-clock budget gates *launching* the next candidate (never aborts the in-flight one — no `AbortController`); on exhaustion the run proceeds with the survivors collected so far, subject to the same ≥2-survivor gate. The per-worker timeout + 3-retry machinery is identical in both modes.
- **Live server-status surface** — a persistent Dashboard widget showing the fusion engine's current state: idle / in-progress / queued (when >1 fusion is active concurrently). The affordance is mode-aware: parallel fusions show "X of N candidates responding" rising as workers land; sequential fusions show "candidate X of N running (Y done)". Polled from a new `GET /api/runtime` endpoint at a coarse 2s interval, paused when the tab is hidden, with an immediate refetch on regain-focus so progress is never stale. `/api/runtime` is deliberately distinct from the existing `/api/status` (which returns version/configured-state/health for the dashboard, agent skill, and CLI health checks) — that route is untouched.

### Changed (feature 007)
- **Fan-out dispatch extracted** to `src/fusion/fanout.ts` — `runFusion` now dispatches to `runParallelFanout` (the verbatim original `Promise.all`) or `runSequentialFanout` (a `for…of` loop) based on `executionMode`. Single dispatch site covers both entry paths (blocking MCP tool + detached task runner).
- **Config schema v4 → v5** with automatic migration: injects `settings.executionMode: "parallel"` on load (a notice prints if a v4 file is upgraded). No SQLite migration — sequential mode adds no persisted column (the activity row already records candidate/survivor counts + per-candidate latency).
- **`FusionStatusRegistry`** (`src/fusion/status.ts`) — an in-memory process-singleton `runFusion` enters on start, updates per-candidate, and leaves in a `finally` on every terminal path (success/partial/error/throw — a stuck "in-progress" is the one failure mode that would make the surface useless). Ephemeral by design; lost on restart (the activity log remains the durable record). Never exposes content — only counts, indices, ids, timestamps.
- **Constitution Principle III amended** to acknowledge sequential mode as a user-opted alternative to the parallel default, with the survivor gate and per-worker timeout/retry identical to parallel (the parallel default is preserved exactly).

### Fixed (feature 007)
- **Parallel fusions now show rising progress** — the live-status widget showed a parallel fusion as "0 of N responding" for its entire run because the parallel fan-out path wired no per-completion update to the status registry. `runParallelFanout` now fires an `onUpdate` callback in completion order as each worker resolves, wired to the registry. Regression test `T010b` added and teeth-checked (reverting the wiring makes it fail). See `specs/007-sequential-processing/postmortem.md`.

### Documentation (feature 007)
- **`AGENTS.md`** — the `fusion` Tool section documents execution mode, the serial budget semantics (gates launching, not the in-flight candidate), and the `/api/runtime` status surface; a new Known Limitation notes that sequential mode removes OpenFusion's *own* candidate concurrency but does not manage the local model server's VRAM (Ollama `keep_alive`, llama.cpp offloading).
- **Full design artifacts** under `specs/007-sequential-processing/` (spec, plan, research, data-model, contracts, quickstart, tasks, postmortem), including `research.md` R-001–R-007 locked decisions and the Constitution III governance amendment rationale.

### Tested (feature 007)
- **105/105 tests passing** (91 pre-007 + 14 new across `tests/fanout-sequential.test.ts`, `tests/serial-budget.test.ts`, `tests/status-surface.test.ts`): parallel-unchanged invariant, serial non-overlapping slot-ordered fan-out, serial budget formula + self-calibrating exhaustion gate, per-worker retry unchanged in serial, sequential × benchmark independence, registry idle/in-progress/queued/enter⇒leave, and the parallel-progress regression.

## [0.2.1] - 2026-06-18

### Added
- **Personas** — named bundles of the three system prompts (worker + analysis + synthesis) tailored to the task. Ships with four defaults: **Generalist**, **QA / Code Reviewer**, **Researcher**, **Project Manager / Strategist**. Each gets specialized role framing for the candidates and matching emphasis in the judge steps.
- **Personas tab** — a full editor: pick a persona, edit all three prompts in textareas, set the active one, duplicate, reset a builtin to its shipped default, or create/delete your own.
- **Per-fusion persona override** — the `fusion` tool now accepts an optional `persona` (id or name, e.g. `qa`, `researcher`) so an agent can match the persona to the task on each call. Defaults to the active persona.
- **`GET/POST/PUT/DELETE /api/personas`** — full persona CRUD.

### Changed
- **Config schema v2 → v3** with automatic migration: injects the builtin personas and sets `activePersona: "generalist"` on load (a notice prints if a v2 file is upgraded). Existing config upgrades transparently.
- The default **Generalist** prompts are sharper without bloat: workers now "show reasoning briefly so the judge can weigh it"; synthesis now "corrects wrong consensus instead of rubber-stamping it."
- **`activities.persona`** column (migration `003_add_persona`) — each fusion logs which persona it used (shown in Generations/Errors views; null for pre-0.2.1 fusions).
- The three system prompts are no longer hardcoded — they're threaded from the resolved persona through the worker and both judge steps. The standalone `prompts.ts` is removed.

## [0.2.0] - 2026-06-18

### Added
- **Published to npm** — `npx -y openfusion-mcp` now works with no clone/build. Every client snippet defaults to it.
- **`npx openfusion-setup`** — interactive installer: picks your MCP client, writes the correct config snippet (`claude mcp add`, ZCode `mcp.servers`, Cursor `.cursor/mcp.json`, Zed `context_servers`, Codex `mcp_servers`, Gemini-CLI family, Cline, Claude Desktop…), and offers to install the agent skill.
- **First-run UX** — on a fresh install the server prints a stderr banner (version, data path, configured status) and **opens the dashboard** automatically (when a display is present). Same for the standalone `openfusion-ui` bin.
- **`GET /api/status`** — one lightweight call returning `{ version, home, configured, reasons?, firstRun, dbPath }` for the dashboard, agents, and CLI health checks.

### Changed
- **`GET /api/health`** now also returns `version` + `configured` (still has `ok:true` for back-compat).
- **Version is no longer hardcoded** — read from `package.json` via a shared helper; the MCP handshake reports the real version (was stale at 0.1.0).
- **Config upgrades print a notice** — when a v1 config is migrated to v2 on load, a one-time stderr message tells you (so you know a restart-after-update happened).

### Fixed
- **better-sqlite3 native-addon failures are now actionable** — instead of an opaque `MODULE_NOT_FOUND` stack trace, OpenFusion prints a clear "run `npm rebuild better-sqlite3`" message with the toolchain requirements.
- **Docs**: README leads with `npx`; documents `OPENFUSION_HOME` (and that it prints on startup), the native-build requirement + recovery, an Updating section, and the client tool-call-timeout caveat (a client can time out while the server completes and logs the fusion — check Generations/Errors).

## [0.1.2] - 2026-06-17

### Added
- **Generations tab** — read what each model actually produced for a given fusion. Pick an activity from a dropdown, choose Candidates or Judge view. Candidates view shows generation boxes side by side (2 by default, add more to the right with horizontal scroll), each with a per-box model dropdown, a scrollable rendered view of the generation, and per-box stats (tokens/cost/latency/status). Judge view shows the structured analysis (consensus/contradictions/partial coverage/unique insights/blind spots) plus the synthesized final answer.
- **Generated text is now persisted** to SQLite — a new migration (`002_add_generated_text`) adds `generated_text` and `analysis_json` columns to `sub_calls`, so you can re-read any future fusion's outputs. Historical fusions (pre-0.1.2) show an honest "predates generation logging" note.

### Changed
- **Nav reorder**: Dashboard · Generations · Candidates · Judge · API Keys · Errors (Generations right after Dashboard; Errors moved to the end).
- Lightweight markdown-ish rendering of generations (headings, bold, inline code, code fences, lists) with a copy button.

## [0.1.1] - 2026-06-16

### Added
- **On/off toggles** for candidates and judges — configure many, enable the ones you want to fuse with. Candidates enforce 2–5 enabled (min/max); judges enforce exactly 1 enabled.
- **Benchmark Mode** (Candidates page, default off) — lifts the max-candidate limit and forces a 10-minute candidate timeout, for comparing many models at once.
- **Error Log tab** — a dedicated troubleshooting view listing failed/partial fusions with a one-click **copy** button per activity (copies the full activity JSON incl. sub_calls + error).
- **Config schema v2** with automatic v1→v2 migration on load (single `judge` → `judges[]`; candidates gain `enabled`; settings gain `benchmarkMode`).

### Fixed
- **Judge latency was always 0** — both judge steps (analysis, synthesis) now record real wall-clock latency (incl. retry time) in the dashboard's per-step breakdown.

### Changed
- `judge` (single object) is now `judges` (list); each judge has an `enabled` flag. Only the first enabled judge runs.
- Disabled candidates/judges no longer require API keys (the API Keys page only shows providers used by enabled slots).
- Candidates enforce their 2–5 range on **enabled** slots (not total); benchmark mode lifts the 5 cap.

## [0.1.0] - 2026-06-16

### Changed
- **Per-call timeout default raised from 2 min to 5 min** (`settings.workerTimeoutMs`), giving slower providers more room. Still user-configurable (5 s – 10 min); lower it if your MCP client enforces a tighter tool-call ceiling.
- **Retry on failure** — workers and both judge steps now retry up to 3 times on a transient error or timeout (the per-call timeout resets on each attempt; exponential backoff between attempts). Previously a single timeout/error ended the call.

### Fixed
- The two judge steps (analysis + synthesis) now have a per-call timeout + retry, matching the workers. Previously a hung judge would hang the whole fusion indefinitely.

## [0.1.0] - 2026-06-16

The first public release. A local MCP server that brings OpenRouter's [Fusion](https://openrouter.ai/blog/announcements/fusion-beats-frontier/) panel architecture to any MCP-capable client — fan a prompt out to 2–5 candidate models, run a two-step judge, return one consolidated answer.

### Added
- **`fusion` MCP tool** — parallel fan-out to 2–5 single-shot candidates (`Promise.allSettled` + per-candidate timeout), a two-step judge (structured `record_analysis` tool call → synthesis) on the same provider/model, ≥2-survivor threshold, and progress notifications. OpenFusion is a fusion engine, not an agent — candidates get no tools; the caller supplies `prompt` + optional `context`.
- **`open_dashboard` MCP tool** — opens the config/stats dashboard in a browser.
- **Configuration system** — plaintext `config.json` (model choices) + AES-256-GCM `secrets.enc` (one key per provider, shared across slots) + chmod-600 machine-bound `master.key`. `isConfigured()` gate (≥2 candidates + judge + all referenced provider keys) refuses `fusion` until satisfied.
- **Provider layer** — `@earendil-works/pi-ai` bridge with per-call `apiKey` injection, `getProviders()`/`getModels()` for UI dropdowns, and a live test-ping endpoint. Model-override registry for dynamic providers.
- **Persistence** — SQLite (better-sqlite3, WAL) with `activities` (one per fusion) + `sub_calls` (N+2 per fusion) tables; aggregation queries power the dashboard's "activity as a dimension".
- **REST API** on `127.0.0.1:9077` — config, secrets (masked presence only), providers/models, test, stats, activity (paginated + expandable).
- **Glass-morphic React dashboard** (Vite + Tailwind + recharts) — Candidates, Judge, API Keys (with per-provider Test), and Dashboard pages with KPI cards, fusions-per-day line chart, cost-by-model + token-usage-by-model bar charts, and an expandable activity table.
- **`openfusion-ui` bin** — standalone always-on dashboard (survives independent of the MCP client).
- **`SKILL.md`** — agent guidance on when (and when not) to use Fusion, dropped into a client's skills folder.
- **`INSTALL.md`** — registration recipes for 18+ MCP clients (Claude Code, Cursor, Cline, Roo, Zed, Continue, Codex, Gemini CLI, Qwen Code, Kimi Code, Antigravity, opencode, Hermes, Claude Desktop, Codebuff, ZCode, and more).
- **Design record** — full speckit `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`.
- **38 tests** (vitest) — crypto round-trips, SQLite aggregations, worker timeout, two-step judge, fusion orchestration (success / partial / <2-survivor / judge-failure / wall-clock budget), config merge-and-validate, MCP handler + progress + gate. All deterministic via pi-ai faux providers.

### Security
- API keys encrypted at rest (AES-256-GCM); never logged; never returned unmasked from any API.
- Dashboard binds to `127.0.0.1` only.

### Conventions
- pnpm, TypeScript (ES2022, NodeNext, ESM), no bundler; `tsc` → `dist/`, Vite → `ui-dist/`.
- stdout reserved for MCP JSON-RPC; all logs to stderr.

[Unreleased]: https://github.com/hashangit/openfusion/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/hashangit/openfusion/releases/tag/v0.3.0
[0.2.1]: https://github.com/hashangit/openfusion/releases/tag/v0.2.1
[0.2.0]: https://github.com/hashangit/openfusion/releases/tag/v0.2.0
[0.1.2]: https://github.com/hashangit/openfusion/releases/tag/v0.1.2
[0.1.1]: https://github.com/hashangit/openfusion/releases/tag/v0.1.1
[0.1.0]: https://github.com/hashangit/openfusion/releases/tag/v0.1.0
