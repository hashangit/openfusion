# Tasks: Fusion MCP Server

**Input**: Design documents from `/specs/004-fusion-mcp-server/` — [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, constitution ✅

**Tests**: INCLUDED (test-first) — Constitution Principle VII mandates Vitest; plan lists explicit test files; quickstart.md V-scenarios map to them.

**Organization**: Tasks grouped by user story (US1 = fuse, P1 MVP; US2 = configure, P1; US3 = monitor, P2; US4 = skill, P2).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

Single project at repo root: `src/` (server, ESM TypeScript → `dist/`), `ui/` (React/Vite workspace), `skill/`, `tests/`. UI built to `ui-dist/` (served by Express).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, tooling, and directory structure.

- [X] T001 Create project structure per [plan.md](./plan.md) Project Structure: `src/{server,server/api,fusion,config,providers,store,util}/`, `ui/`, `skill/`, `tests/`
- [X] T002 Initialize ESM TypeScript project: `package.json` (`"type":"module"`, deps `@modelcontextprotocol/sdk@^1`, `@earendil-works/pi-ai`, `better-sqlite3`, `express`, `zod`, `open`, `env-paths`; devDeps `typescript`, `tsx`, `vitest`, `@types/*`), `tsconfig.json` (ES2022/NodeNext/strict), `pnpm-workspace.yaml` including `ui/`
- [X] T003 [P] Configure linting/formatting (prettier, eslint flat config) and `.gitignore` (`dist/`, `ui-dist/`, `node_modules/`, `~/.openfusion` artifacts, `.env`)
- [X] T004 [P] Add `pnpm` scripts in `package.json`: `build` (`tsc` + `cd ui && pnpm build`), `dev` (`tsx watch src/index.ts`), `test` (`vitest`), `start` (`node dist/index.js`)
- [X] T005 Initialize Vite React app in `ui/` (`ui/package.json`, `ui/index.html`, `ui/vite.config.ts`) with Tailwind + recharts deps

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Paths & crypto

- [X] T006 Implement OS path resolution in `src/util/paths.ts` via `env-paths` (`configDir`/`dataDir` → `~/.openfusion`)
- [X] T007 [P] Write crypto tests in `tests/crypto.test.ts`: AES-256-GCM encrypt/decrypt round-trip, `mask()` (first 3 + last 4 for keys ≥8 chars; `******` otherwise), master.key generation with `chmod 600` (TDD — must fail first)
- [X] T008 Implement AES-256-GCM crypto in `src/config/crypto.ts`: `generateMasterKey()`, `encrypt(json, key)` (iv(12)+authTag(16)+ciphertext), `decrypt(blob, key)`, `mask(key)` — make T007 pass

### Config schema & store

- [X] T009 [P] Define zod schemas in `src/config/schema.ts`: `AppConfig`, `CandidateSlot` (id/provider/model), `JudgeConfig`, `Settings` (workerTimeoutMs 5000–600000, uiPort default 9077, bind default `127.0.0.1` loopback-only) per [data-model.md](./data-model.md) E1
- [X] T010 Implement config store in `src/config/store.ts`: `loadConfig()` (missing file ⇒ unconfigured, not error), `saveConfig()` (atomic temp+rename with `.bak`), validates against schema + pi-ai registry
- [X] T011 Implement secrets store in `src/config/secrets.ts`: `loadSecrets()`/`saveSecrets()` via `crypto.ts` (read/write `secrets.enc`); refuses to regenerate `master.key` if missing (treats secrets as unconfigured); `setProviderKey(provider, key|null)`, `getKey(provider)`, `maskedPresence(config)`
- [X] T012 Implement `isConfigured()` in `src/config/completeness.ts`: `candidates.length 2–5 && judge set && every referenced provider has a key` per [contracts/config-schema.md](./contracts/config-schema.md)

### Provider bridge

- [X] T013 [P] Write provider-bridge tests in `tests/pi-ai-bridge.test.ts`: `getModel` for valid provider/model; error on unknown; `complete()` call shape with `apiKey` injected; test-ping returns `{ok, latencyMs, usage}` (use `registerFauxProvider`)
- [X] T014 Implement `src/providers/pi-ai-bridge.ts`: `resolveModel(provider, model)`, `runComplete(model, context, apiKey)`, `listProviders()`, `listModels(provider)`, `testPing(provider, model, apiKey, timeoutMs)` per [research.md](./research.md) D1

### SQLite store

- [X] T015 [P] Write DB tests in `tests/activity.test.ts`: migration creates `activities`+`sub_calls`; FK `sub_calls.activity_id→activities.id ON DELETE CASCADE`; `recordActivity`/`recordSubCall` round-trip; KPI + cost-by-model + fusions-by-day aggregations return expected rows
- [X] T016 Implement `src/store/db.ts`: open `~/.openfusion/openfusion.db`, `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`, run migrations (DDL per [data-model.md](./data-model.md) E3/E4 with indexes), `ON DELETE CASCADE`
- [X] T017 Implement `src/store/activity.ts`: `recordActivity(row)`, `recordSubCall(row)` (parameterized INSERTs), `getActivity(id)` with `subCalls`
- [X] T018 Implement `src/store/stats.ts`: `kpis(filters)`, `costByModel(filters)`, `fusionsByDay(filters)`, `listActivity({limit,offset,filters})`, `totalCount(filters)` per [data-model.md](./data-model.md) aggregation section

### Utilities

- [X] T019 [P] Implement `src/util/timeout.ts`: `withTimeout(promise, ms, label)` returning a typed promise; rejects with `TimeoutError` (carries `code`+`retryable`)

**Checkpoint**: Foundation ready — config/crypto/secrets/provider/DB/util all green. User story implementation can now begin.

---

## Phase 3: User Story 1 — Fuse a prompt → one consolidated answer (Priority: P1) 🎯 MVP

**Goal**: An MCP client calls `fusion` with a prompt (+ optional context); candidates fan out in parallel; a two-step judge returns one synthesized answer; the fusion is logged.

**Independent Test**: With candidates+judge configured, call `fusion` with a multi-perspective prompt and verify a synthesized answer + logged activity (1 activity row, N+2 sub_call rows) — [quickstart.md](./quickstart.md) V2.

### Tests for User Story 1 (write first, must fail)

- [X] T020 [P] [US1] Worker tests in `tests/worker.test.ts`: single-shot `runWorker` returns content+usage+latency+status; respects timeout (faux provider scripted to hang) — fails first
- [X] T021 [P] [US1] Judge tests in `tests/judge.test.ts`: step-1 analysis must emit `record_analysis` tool call with all 5 fields; step-2 synthesis uses only candidates+analysis; same provider/model for both steps — fails first
- [X] T022 [P] [US1] Fusion orchestration tests in `tests/fusion.test.ts`: parallel fan-out; ≥2-survivor success; <2-survivor error; partial-survivor `status="partial"`; per-candidate + 2 judge sub_calls logged; progress callback invoked at each stage — fails first

### Implementation for User Story 1

- [X] T023 [P] [US1] Write fusion prompts in `src/fusion/prompts.ts`: `WORKER_PROMPT` (single-shot, answer the prompt given context), `ANALYSIS_PROMPT` (analyze candidates only, never answer — Constitution II), `SYNTHESIS_PROMPT` (synthesize from candidates+analysis only, no new info)
- [X] T024 [US1] Implement `src/fusion/worker.ts`: `runWorker({model, prompt, context, apiKey, timeoutMs})` → `{slotId, provider, model, content?, usage?, latencyMs, status, error?}`; wraps `pi-ai-bridge.runComplete` in `withTimeout` — make T020 pass
- [X] T025 [US1] Implement `src/fusion/judge.ts`: `record_analysis` TypeBox tool schema (consensus/contradictions/partialCoverage/uniqueInsights/blindSpots); `runAnalysis({model, candidates, prompt, apiKey})` (forced tool call); `runSynthesis({model, candidates, analysis, apiKey})` (text) — make T021 pass
- [X] T026 [US1] Implement `src/fusion/fusion.ts` orchestrator per [data-model.md](./data-model.md) state machine: config gate → `Promise.allSettled` fan-out (each via T024) → survivor count check → `runAnalysis` (T025) → `runSynthesis` (T025) → log via `activity.ts` (status success/partial/error) → return finalAnswer; emits progress via injected callback — make T022 pass
- [X] T027 [P] [US1] MCP handler tests in `tests/mcp-server.test.ts`: tool registered with zod schema `{prompt, context?}`; success returns single text block; unconfigured returns `isError:true` (Constitution VI); progress notifications emitted via `extra.sendNotification` when `progressToken` present, no-op otherwise — fails first
- [X] T028 [US1] Implement MCP server in `src/server/mcp-server.ts`: `McpServer`, register `fusion` tool (handler delegates to `fusion.ts`, passes a progress callback reading `extra._meta?.progressToken`), register `open_dashboard` tool; logs to `console.error` only (stdout is JSON-RPC) — make T027 pass
- [X] T029 [US1] Implement server entry in `src/index.ts`: shebang `#!/usr/bin/env node`; boot `McpServer`+`StdioServerTransport`; stub Express bootstrap (full UI in US2) so the server is runnable end-to-end for V2

**Checkpoint**: US1 fully functional + independently testable. A fusion can be called, judged, logged, and returned. (Requires US2's config to be set, but US2 is testable next; MVP demo = US1+US2 together.)

---

## Phase 4: User Story 2 — Configure OpenFusion before first use (Priority: P1)

**Goal**: First-run refuses fusion and directs the user to a glass-morphic dashboard at `http://localhost:9077`; there they add 2–5 candidates + judge + per-provider keys (with test pings), save, and fusion works immediately.

**Independent Test**: From a fresh install, call `fusion` → directed to dashboard → configure → test each provider → save → `fusion` succeeds without restart — [quickstart.md](./quickstart.md) V1 + V2.

### Tests for User Story 2 (write first, must fail)

- [X] T030 [P] [US2] REST API tests in `tests/api.test.ts`: `GET/PUT /api/config` (validation, unknown provider/model → 409); `GET /api/secrets` returns masked presence only (never raw); `PUT /api/secrets` encrypts; `GET /api/providers`+`/models` passthrough; `POST /api/test` `{ok,error,latencyMs}` — fails first
- [X] T031 [P] [US2] Config-gate flow test in `tests/mcp-server.test.ts`: unconfigured `fusion` call returns `isError:true` with `http://localhost:9077` message and attempts browser open when display present; returns URL only when headless — fails first

### Implementation for User Story 2

- [X] T032 [US2] Implement Express UI server in `src/server/ui-server.ts`: bind `127.0.0.1:9077` (loopback only — Constitution IV), `express.json()`, SPA static serve from `ui-dist/` with catch-all, `console.error` logging — wires into `src/index.ts` (replaces T029 stub)
- [X] T033 [US2] Implement `src/server/api/config.ts`: `GET /api/config` (returns config + `configured` flag, no secrets), `PUT /api/config` (validate → save) per [contracts/rest-api.md](./contracts/rest-api.md)
- [X] T034 [US2] Implement `src/server/api/secrets.ts`: `GET /api/secrets` (masked presence via `secrets.maskedPresence`), `PUT /api/secrets` (set/clear one provider key)
- [X] T035 [P] [US2] Implement `src/server/api/providers.ts`: `GET /api/providers`, `GET /api/providers/:provider/models` (pi-ai passthrough)
- [X] T036 [US2] Implement `src/server/api/test.ts`: `POST /api/test` → `pi-ai-bridge.testPing` (bounded ~10s timeout; does not persist)
- [X] T037 [US2] Wire config-gate + browser open in `src/server/mcp-server.ts`: unconfigured `fusion` returns `isError` message + `open("http://localhost:9077")` when display present, else URL only — make T031 pass
- [X] T038 [P] [US2] Build `ui/src/api.ts`: typed fetch wrappers for all `/api/*` endpoints
- [X] T039 [US2] Build `ui/src/pages/Setup.tsx`: first-run wizard (Candidates → Judge → ApiKeys → Test → Save)
- [X] T040 [P] [US2] Build `ui/src/pages/Candidates.tsx`: add/remove 2–5 slots; provider dropdown (from `/api/providers`); model dropdown filtered by provider (`/api/providers/:p/models`) per [contracts/config-schema.md](./contracts/config-schema.md)
- [X] T041 [P] [US2] Build `ui/src/pages/Judge.tsx`: single provider+model picker
- [X] T042 [P] [US2] Build `ui/src/pages/ApiKeys.tsx`: per-provider key entry, masked display of existing, "Test" button per [FR-013] (`POST /api/test`)
- [X] T043 [US2] Build `ui/src/App.tsx` + `ui/src/main.tsx`: glass-morphic layout (translucent cards, `backdrop-blur`, OpenFusion gradient), navigation, routes; ready state badge from `GET /api/config.configured`

**Checkpoint**: US1 + US2 together = full MVP. Fresh install → configure in browser → fuse successfully without restart.

---

## Phase 5: User Story 3 — Monitor usage & cost across providers (Priority: P2)

**Goal**: The dashboard shows KPIs, cost/tokens-over-time and by-model charts, and an expandable activity log (each fusion → its N+2 sub-calls).

**Independent Test**: Run several fusions → dashboard KPIs/charts match → expand any activity to its per-candidate + per-judge sub_calls — [quickstart.md](./quickstart.md) V5.

### Tests for User Story 3 (write first, must fail)

- [X] T044 [P] [US3] Stats/activity REST tests in `tests/api.test.ts`: `GET /api/stats` KPIs + costByModel + fusionsByDay honor date/model/status filters; `GET /api/activity` pagination; `GET /api/activity/:id` returns activity + exactly `candidateCount+2` subCalls — fails first

### Implementation for User Story 3

- [X] T045 [US3] Implement `src/server/api/stats.ts`: `GET /api/stats` (delegates to `store/stats.ts`), `GET /api/activity` (paginated list), `GET /api/activity/:id` (expandable detail) — make T044 pass
- [X] T046 [US3] Build `ui/src/pages/Dashboard.tsx`: KPI cards (fusion count, total cost, total tokens, avg latency, success rate); recharts — cost/tokens over time (line), cost by model (bar), fusions by model; date-range/model/status filters
- [X] T047 [US3] Build activity table component in `ui/src/components/ActivityTable.tsx`: paginated list; each row expands to show its N+2 `subCalls` (model, role, tokens, cost, latency, status) — activity-as-a-dimension

**Checkpoint**: US3 complete. Dashboard is a real usage/cost observability surface.

---

## Phase 6: User Story 4 — Know when/when-not to use OpenFusion (Priority: P2)

**Goal**: Ship a `SKILL.md` that gives client agents explicit when-to-use / when-not-to-use criteria, the cost/latency trade-off, and the reminder that they must supply prompt+context.

**Independent Test**: Load the skill into a skill-capable MCP agent and verify it restricts Fusion calls to multi-perspective tasks and supplies context itself — [quickstart.md](./quickstart.md) V7.

### Implementation for User Story 4

- [X] T048 [P] [US4] Write `skill/SKILL.md`: YAML frontmatter (name/description) + body — what OpenFusion is; WHEN to use (complex reasoning, deep research, cross-model verification, high-stakes answers needing consensus); WHEN NOT to use (routine lookups, single-turn Q&A, trivial coding, anything a base model handles); the 2–3× slower/costlier trade-off; OpenFusion does not call tools — supply prompt + context; min 2 / max 5 candidates; setup reminder (`http://localhost:9077`) per [spec.md](./spec.md) US4

**Checkpoint**: Skill shipped; agents can self-govern their Fusion usage.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hardening, distribution, docs — affects multiple stories.

- [X] T049 [P] Add second bin entry `openfusion-ui` in `package.json` + `src/ui-only.ts`: standalone always-on dashboard (boots Express UI server without the stdio MCP transport) per [research.md](./research.md) D6 caveat
- [X] T050 Configure `package.json` for npx distribution: `bin` (`openfusion-mcp`→`dist/index.js`, `openfusion-ui`→`dist/ui-only.js`), `files: ["dist","ui-dist"]`, build copies `ui/dist`→`ui-dist/`
- [X] T051 [P] Add error envelope uniformity in `src/server/api/`: all non-2xx use `{error, detail, issues?}`; central error middleware
- [X] T052 [P] Security hardening pass: confirm no raw key in any log path or response; `secrets.enc` binary not plaintext; `bind` always loopback; full disk grep sanity per [quickstart.md](./quickstart.md) V6
- [X] T053 Write `README.md`: install (`pnpm`), build, run, client install snippet (Claude Desktop/Cursor/Cline/Zed/Claude Code), first-run config, link to `skill/SKILL.md`
- [X] T054 Run full [quickstart.md](./quickstart.md) validation: V1 (gate) → V2 (fuse) → V3 (partial) → V4 (too-few) → V5 (stats) → V6 (secrets) → V7 (skill); fix gaps
- [X] T055 Run `pnpm test` (vitest) end-to-end; ensure all suites green (faux providers, no real API calls)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Phase 1 — **BLOCKS all user stories**.
- **US1 (Phase 3)**: Depends on Phase 2. MVP core.
- **US2 (Phase 4)**: Depends on Phase 2; co-required for a usable MVP (US1 needs config to run, US2 provides config). US1+US2 = MVP demo.
- **US3 (Phase 5)**: Depends on Phase 2 + US1 (needs logged activity). Independently testable once US1 produces data.
- **US4 (Phase 6)**: Depends on Phase 1 only (pure docs) — can run in parallel with any story.
- **Polish (Phase 7)**: Depends on US1+US2; T054/T055 depend on all stories.

### User Story Dependencies

- **US1 (P1, MVP)**: Starts after Phase 2. No story deps. (To *demo* it you need US2 config, but US1 is implementable/testable with seeded config.)
- **US2 (P1)**: Starts after Phase 2. Integrates with US1's MCP server (config-gate message) — testable independently.
- **US3 (P2)**: Starts after Phase 2 + US1 (consumes activity rows). Independently testable.
- **US4 (P2)**: Starts after Phase 1 only. Fully independent.

### Within Each User Story

- Tests written FIRST and failing before implementation (TDD — AGENTS.md §4, Constitution VII).
- Prompts/utilities before services; services before handlers/UI.
- Each story's checkpoint = independently testable.

### Parallel Opportunities

- Phase 1: T003, T004, T005 in parallel; Phase 2: T007, T009, T013, T015, T019 in parallel.
- US1 tests T020/T021/T022 in parallel; then T023 (prompts) parallel with nothing (T024/T025 depend on it).
- US2 UI pages T040/T041/T042 in parallel (different files).
- US4 (T048) parallel with any story — pure docs.

---

## Parallel Example: User Story 1

```bash
# Write all US1 tests first (different files, no deps):
Task: "T020 worker tests in tests/worker.test.ts"
Task: "T021 judge tests in tests/judge.test.ts"
Task: "T022 fusion orchestration tests in tests/fusion.test.ts"
Task: "T027 [P] MCP handler tests in tests/mcp-server.test.ts"

# Then implement (after T023 prompts):
Task: "T024 worker.ts (depends on T023, T014)"
Task: "T025 judge.ts (depends on T023, T014)"
# T026 fusion.ts depends on T024+T025; T028 mcp-server depends on T026.
```

## Parallel Example: User Story 2

```bash
Task: "T040 Candidates.tsx"
Task: "T041 Judge.tsx"
Task: "T042 ApiKeys.tsx"   # all different files, parallel
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1 (Setup) → Phase 2 (Foundational) — **CRITICAL, blocks everything**.
2. Phase 3 (US1) — the fusion engine + MCP tool + logging.
3. Phase 4 (US2) — config gate + dashboard (setup wizard + candidates/judge/keys pages).
4. **STOP & VALIDATE**: quickstart V1 (gate) + V2 (fuse) green → **MVP demoable**.

### Incremental Delivery

5. Phase 5 (US3) — dashboard stats/charts/activity → demo usage observability (V5).
6. Phase 6 (US4) — `SKILL.md` → demo agent self-governance (V7).
7. Phase 7 (Polish) — `openfusion-ui` bin, npx packaging, README, full V1–V7 validation, full test suite green → release-ready.

### Parallel Team Strategy (if multi-dev)

1. Team completes Phase 1 + Phase 2 together.
2. After Foundational: Dev A → US1; Dev B → US2 UI; Dev C → US4 (docs). US3 waits for US1 data.
3. Each story integrates + tests independently.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] label maps task to a user story for traceability.
- Every user story is independently completable and testable.
- Write tests first, watch them fail, then implement (Constitution VII, AGENTS.md §4).
- Commit after each task or logical group.
- Stop at any checkpoint to validate a story independently.
- Avoid: vague tasks, same-file conflicts, cross-story dependencies that break independence.
- All code paths honor Constitution Principles I–VII (see [plan.md](./plan.md) Constitution Check).
