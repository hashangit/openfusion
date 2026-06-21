---

description: "Task list for feature 006-persona-discovery"
---

# Tasks: Persona Discovery & Policy (MCP)

**Input**: Design documents from `/specs/006-persona-discovery/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-persona-tools.md, quickstart.md — all present.

**Tests**: INCLUDED. spec.md SC-008 requires new tests; quickstart.md defines T1–T11 + E1–E2 validation scenarios. Tests are written alongside implementation per story.

**Organization**: Tasks grouped by user story (US1–US4) for independent implementation + testing.

**Branch prerequisite**: feature 005 (`registerToolTask` task-augmented fusion path) is assumed present. Current branch `005-mcp-tasks-sep` — create/switch to `006-persona-discovery` before starting (Setup T001).

## Format: `[ID] [P?] [Story?] Description (file path)`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks in the same phase)
- **[USx]**: user story label (story phases only)
- Every task carries an exact file path

## Path Conventions

Single project (per plan.md Project Structure): `src/`, `migrations/`, `ui/src/`, `tests/`, `.zcode/skills/openfusion/`.

---

## Phase 1: Setup

**Purpose**: Branch + confirm the 005 prerequisite is in place. No new dependencies (constitution: exact-pinned SDK already supports `getClientCapabilities` + `elicitation/create`).

- [X] T001 Create/switch to branch `006-persona-discovery` from `005-mcp-tasks-sep` (git)
- [X] T002 [P] Confirm 005 prerequisite: verify `src/server/mcp-server.ts` registers `fusion` via `experimental.tasks.registerToolTask` and `src/fusion/task-runner.ts` exists; if absent, STOP and merge 005 first

**Checkpoint**: on branch `006-persona-discovery`, 005 baseline verified.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared layer every story depends on — schema, config, types, the persona-policy resolution core, and the `FusionInput`/activity-row plumbing. **No user-story work can begin until this phase is complete.**

- [X] T003 [P] Add migration `migrations/004_add_persona_source.sql` (FR-011): `ALTER TABLE activities ADD COLUMN persona_source TEXT` (nullable, no backfill; wrap in a column-existence guard matching the 001–003 pattern)
- [X] T004 [P] Register migration 004 in the runner (`src/store/db.ts`) so it applies on next boot
- [X] T005 [P] Add `PersonaPolicy` type (`"strict" | "allow-override"`) to config settings (FR-004) (`src/config/types.ts` or the inline settings type) — see data-model.md §1
- [X] T006 [P] Config migration v3→v4: inject `settings.personaPolicy = "allow-override"` if absent in `migrateConfig()` (`src/config/store.ts`), mirroring the v2→v3 `activePersona` injection; bump config version + log message
- [X] T007 [P] Add `PersonaSource` type (`"active" | "override" | "strict-enforced" | "invalid-fallback"`) + `PersonaEvent` / `PersonaEventResult` types to `src/fusion/persona-policy.ts` (new file) — see data-model.md §2, §5
- [X] T008 [P] Add `PersonaLite` interface + `toLite(persona, activeId)` projection to `src/fusion/personas.ts` (narrows to `{id, name, description, builtin, active}`; EXCLUDES `workerPrompt`/`analysisPrompt`/`synthesisPrompt` — SC-001)
- [X] T009 Add `persona_source?: string | null` to `ActivityRow` and thread it through `recordActivity` + `allocateActivity` signatures (`src/store/activity.ts`) — see data-model.md §Schema
- [X] T010 Implement `resolvePersonaWithPolicy(args)` in `src/fusion/persona-policy.ts` (FR-007): returns `{ persona, source }` for all four cases (active / override / strict-enforced / invalid-fallback) by wrapping the existing `resolvePersona`; takes `{ requested?: string, personas, activeId, policy, source }`. Pure function — NO transport concerns, NO elicitation here (R-001)
- [X] T011 Extend `FusionInput` in `src/fusion/fusion.ts`: add `source?: "mcp" | "ui"` (default `"mcp"`) and `onPersonaEvent?: (e: PersonaEvent) => Promise<PersonaEventResult>`
- [X] T012 Integrate policy resolution into `runFusion` (`src/fusion/fusion.ts`): replace the current `resolvePersona` call with `resolvePersonaWithPolicy`; when `source === "ui"`, force `persona_source = "active"` and skip the policy (FR-010, INV-4); write `persona_source` to the activity row alongside `persona`
- [X] T013 Wire warning emission in `runFusion` (FR-005): when `source` ∈ `{strict-enforced, invalid-fallback}` and `onPersonaEvent` is present, call it with a `warning` event BEFORE running (R-004); do not block on the result for warnings
- [X] T014 [P] Wire the UI-triggered fusion path to pass `source: "ui"` in `src/server/ui-server.ts` (Generations/Playground handler) so dashboard fusions are policy-exempt and record `persona_source = "active"`. **FINDING: no UI callsite exists today** — the Generations tab only *reads* past activities; all fusions are triggered via the MCP fusion tool. The `source:"ui"` exemption is correctly modeled in `resolvePersonaWithPolicy` but dormant. When a dashboard fusion endpoint is added later, it must pass `source:"ui"`. T037 (the UI-exemption test) is correspondingly a unit test of `resolvePersonaWithPolicy({source:"ui"})` rather than an end-to-end UI test.

**Checkpoint**: Foundation ready. `runFusion` resolves + audits persona_source for all four cases; UI calls are exempt; migration applies cleanly. User-story implementation can now proceed.

---

## Phase 3: User Story 1 — Agent discovers personas, requests the suitable one (Priority: P1) 🎯 MVP

**Goal**: An agent calls `list_personas`, picks by id, calls `fusion(persona)`, and the QA persona runs with `persona_source = "override"`.

**Independent Test** (quickstart T1 + T2): call `list_personas` → JSON array, 5 keys per entry, no prompt fields, one `active=true`. Call `fusion(persona:"qa")` under `allow-override` → activity row `persona="qa"`, `persona_source="override"`.

### Tests for User Story 1

- [X] T015 [P] [US1] Test T1 — `list_personas` shape (FR-001, FR-002, FR-016, SC-001): ≥4 builtins, exactly `{id,name,description,builtin,active}`, `JSON.stringify(output)` matches `/workerPrompt|analysisPrompt|synthesisPrompt/` → `false`, exactly one `active=true`; ALSO call `list_personas` under `personaPolicy:"strict"` and assert identical output (FR-016 — discovery is never gated) (`tests/persona-discovery.test.ts`)
- [X] T016 [P] [US1] Test T2 (SC-002) — `fusion({persona:"qa"})` under `allow-override` records `persona="qa"`, `persona_source="override"`, no warning emitted (`tests/persona-policy.test.ts`)

### Implementation for User Story 1

- [X] T017 [US1] Register the `list_personas` tool in `src/server/mcp-server.ts`: `server.tool("list_personas", z.object({}).strict(), handler)`; handler reads config personas + activeId, maps via `toLite()`, returns `JSON.stringify(array)` as a single text content block (contracts/mcp-persona-tools.md). **Implemented as `listPersonasToolHandler` (extracted, testable) + registered via `server.tool`.**
- [X] T018 [US1] Trim the `fusion` tool description in `src/server/mcp-server.ts`: remove the inline persona name enumeration; add the discovery nudge sentence ("To see available personas, call `list_personas`; pass `persona=<id>` … subject to the user's persona policy") — both the plain `server.tool` and the `registerToolTask` descriptions (FR-003, SC-006). Capture the pre-006 description as a `PRE_006_FUSION_DESCRIPTION` constant; add a test asserting `newDescription.length < PRE_006_FUSION_DESCRIPTION.length` AND `!newDescription.includes("qa") || !newDescription.includes("researcher")` (the inline enumeration is gone). **Note: initial nudge was 604 chars (>599); tightened to "Call `list_personas` first; pass `persona=<id>` to override." to satisfy SC-006's strict-shorter requirement.**
- [X] T019 [US1] Verify the override path end-to-end: confirm `runFusion` already honors `persona` under `allow-override` via T010/T012; run T15 + T16 green. **73/73 tests green including the e2e override assertion (T016).**

**Checkpoint**: User Story 1 functional + independently testable. MVP deliverable.

---

## Phase 4: User Story 2 — Strict mode: user's selection wins, agent warned not blocked (Priority: P1)

**Goal**: Under `personaPolicy:"strict"`, a client override request runs the active persona, emits a warning notification, and (if the client supports `elicitation.form`) asks the user once per session to relax.

**Independent Test** (T3, T3b, T4, T5): strict + no-elicitation → `strict-enforced` + warning. Strict + elicitation + "keep-strict" → no re-prompt. Strict + elicitation + "relax" → session honors overrides. Concurrent calls → exactly one elicitation.

### Tests for User Story 2

- [X] T020 [US2] Test T3 (SC-003) — strict + notification-only client: `fusion({persona:"qa"})` → `persona=<active>`, `persona_source="strict-enforced"`, warning notification `{requested:"qa", used:<active>, reason:"strict-enforced"}` (`tests/persona-policy.test.ts`)
- [X] T021 [US2] Test T3b — strict + elicitation client, user "keep-strict": one `elicitation/create` sent, `persona_source="strict-enforced"`, subsequent call does NOT re-prompt (`tests/persona-policy.test.ts`)
- [X] T022 [US2] Test T4 — strict + elicitation, user "relax": first call `persona_source="override"`, second call (different persona) `persona_source="override"` with no re-prompt (`tests/persona-policy.test.ts`)
- [X] T023 [US2] Test T5 (SC-004) — concurrency: 3 simultaneous `fusion({persona:"qa"})` → exactly ONE elicitation, all 3 run with the requested persona post-relax (`tests/persona-policy.test.ts`)

### Implementation for User Story 2

- [X] T024 [US2] Implement `SessionOverrideState` in `src/fusion/persona-policy.ts` (FR-006): `{ decision?: "relax"|"keep-strict", inflight?: Promise<"relax"|"keep-strict"> }`; function `askRelaxStrict(elicit: () => Promise<"relax"|"keep-strict">)` that dedupes via the shared `inflight` promise (R-007); module-level singleton (one stdio client per process); canonical enum matches `PersonaEventResult` + elicitation `choice` — no `"keep"` shorthand
- [X] T025 [US2] Wire the MCP strict path in `src/server/mcp-server.ts`: in the `onPersonaEvent` callback, (a) ALWAYS emit `notifications/message` warning via `extra.sendNotification`; (b) when `server.server.getClientCapabilities()?.elicitation?.form` is truthy and the event is an `elicitation-request`, call `askRelaxStrict()` → on `"relax"` return `"relax"` (so `runFusion` flips source to `override`), else `"keep-strict"` (R-002, R-003)
- [X] T026 [US2] Send the relax-strict `form` elicitation per `contracts/mcp-persona-tools.md` (title/description + single `choice` field `enum: ["relax","keep-strict"]`, default `"keep-strict"`); handle reject/timeout as `"keep-strict"` and set `decision="keep-strict"` (no re-prompt)
- [X] T027 [US2] Ensure both fusion entry paths wire `onPersonaEvent`: the plain `server.tool('fusion')` AND the task-augmented `registerToolTask('fusion')` from feature 005 — single source of truth is `runFusion` (FR-009), but both handlers must pass the callback through. **Pre-check**: inspect `src/fusion/task-runner.ts` (feature 005) FIRST to confirm it forwards `FusionInput` fields unchanged to `runFusion`. If `task-runner.ts` constructs its own `FusionInput` or omits fields, expand this task to modify `task-runner.ts` so `onPersonaEvent` + `source` thread through.

**Checkpoint**: User Stories 1 AND 2 independently functional. Strict mode is enforceable + verifiable.

---

## Phase 5: User Story 3 — Invalid persona id falls back gracefully (Priority: P2)

**Goal**: A bad persona id never errors — active persona runs, `persona_source="invalid-fallback"`, a warning fires.

**Nature of this phase**: This is a **verification-heavy** story, not a feature-building one. The `invalid-fallback` classification logic is implemented in Foundational (T010 `resolvePersonaWithPolicy`); the warning emission is wired in T013. US3 exists to *prove* the never-throws contract (FR-008, SC-005) holds and is auditable. If T028 passes on first run, T029/T030 are confirmations — expect this phase to be fast.

**Independent Test** (T6): `fusion({persona:"does-not-exist"})` → no error, `persona=<active>`, `persona_source="invalid-fallback"`, warning with `reason:"invalid-fallback"`.

### Tests for User Story 3

- [X] T028 [P] [US3] Test T6 (SC-005) — invalid id under both policies: fusion completes (no error), `persona=<active>`, `persona_source="invalid-fallback"`, warning notification carries `reason:"invalid-fallback"` (`tests/persona-discovery.test.ts`)

### Implementation for User Story 3

- [X] T029 [US3] Confirm `resolvePersonaWithPolicy` (T010) already classifies an unresolvable requested id as `"invalid-fallback"` (it should — this task is verification + any missing branch). Verify the warning event is emitted with `reason:"invalid-fallback"` via the T013 wiring
- [X] T030 [US3] Assert the never-throws contract holds: no code path in `runFusion` errors on a bad persona id (FR-008); add an explicit assertion in the test that the fusion result is a success

**Checkpoint**: Invalid ids degrade visibly, never break the call.

---

## Phase 6: User Story 4 — Audit trail shows provenance in the dashboard (Priority: P2)

**Goal**: The Generations tab renders the persona chip with source provenance; the Config tab exposes the policy toggle.

**Independent Test** (T8, T9): chip text varies by `persona_source`; Config toggle persists `personaPolicy`; helper text clarifies MCP-only scope.

### Tests for User Story 4

- [X] T031 [P] [US4] Test T8 — Generations chip rendering: mock activities for each source; assert chip text matches `(client override)` / `(strict-enforced)` / `(invalid-fallback)` / no suffix for `active` and `NULL` (`tests/fusion-persona-source.test.ts` or a UI test)
- [X] T032 [P] [US4] Test T9 — Config tab renders the `personaPolicy` control with both values + the MCP-only helper text; changing it round-trips through the config API (`tests/fusion-persona-source.test.ts` or UI test)

### Implementation for User Story 4

- [X] T033 [P] [US4] Add `persona_source?: string | null` to the UI `Activity` type (`ui/src/api.ts`)
- [X] T034 [US4] Verify the activity API surfaces `persona_source` end-to-end (FR-012): confirm the list (`GET /api/activities`) and detail (`GET /api/activities/:id`) response bodies include `persona_source` for 006+ rows and omit/`null` for legacy; assert in a test that a fusion written with `persona_source="override"` round-trips through `getActivityDetail` with the field intact (`src/server/api/activity.ts` + `tests/fusion-persona-source.test.ts`). If `SELECT *` doesn't surface it, add it to the serialization layer.
- [X] T035 [US4] Update the persona chip in `ui/src/pages/Generations.tsx`: suffix logic — `override` → `(client override)`, `strict-enforced` → `(strict-enforced)`, `invalid-fallback` → `(invalid-fallback)`, `active`/`null` → no suffix (FR-013, SC-007)
- [X] T036 [US4] Add the `personaPolicy` toggle to the Config tab (`ui/src/pages/Config.tsx`): a select/segmented control (`strict` / `allow-override`) + helper text "Gates whether MCP clients (e.g. agents) may override your active persona per fusion. Your dashboard fusions are never affected." (FR-014); persist via the existing config save endpoint

**Checkpoint**: All four sources visible to the user; policy is user-controllable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: UI-exemption verification, skill update, edge validation, full suite green, version bump.

- [X] T037 [P] Test T7 — UI exemption: a dashboard-triggered fusion under `strict` still runs the UI-selected persona with `persona_source="active"` (no warning, no elicitation) (`tests/fusion-persona-source.test.ts`); depends on T014 wiring
- [X] T038 [P] Update `.zcode/skills/openfusion/SKILL.md`: teach the 2-call pattern (`list_personas` → `fusion(persona=<id>)`); keep first-level thin; link to `resources/persona-*.md` for deep guidance (FR-015, SC-009)
- [X] T039 [P] Create `.zcode/skills/openfusion/resources/persona-{generalist,qa,researcher,pm}.md`: one file per builtin — when it wins, what it optimizes for, example triggers (progressive disclosure per Agent Skills standard)
- [X] T040 Edge E1 — process restart resets `SessionOverrideState` (opt-in is in-memory); verify `config.settings.personaPolicy` is NOT mutated by a relax opt-in (INV-5). **Testability note**: a unit test cannot restart the process; test indirectly by constructing a *fresh* `SessionOverrideState` instance and asserting it starts undecided (`decision===undefined`), plus a manual/quickstart check that a real process restart re-prompts. Mark this task as "unit-test the reset semantics + manual verify the live restart."
- [X] T041 Edge E2 — legacy activities (`persona_source IS NULL`) render in Generations with no suffix and no crash
- [X] T042 Run `pnpm test` — all pre-existing tests (57 as of v0.2.1) + new T15–T23, T28, T31–T32, T37 green (SC-008)
- [X] T043 Run `pnpm build` (root + `ui/`) — TypeScript + Vite clean
- [X] T044 [P] Update `AGENTS.md` "fusion tool" block: note `list_personas` discovery + the policy toggle + `persona_source` audit field
- [X] T045 [P] Bump version to `0.3.0` (`package.json`) — additive feature, minor bump per spec decision E
- [X] T046 Run `quickstart.md` validation scenarios end-to-end (T1–T11 + E1–E2) as the final acceptance gate

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately
- **Foundational (Phase 2)**: depends on Setup — **BLOCKS all user stories**
- **User Stories (Phases 3–6)**: all depend on Foundational
  - US1, US2, US3 all extend `persona-policy.ts` / `mcp-server.ts` — sequence in priority order (US1 → US2 → US3) to avoid merge conflicts on the same files
  - US4 is UI-only and can proceed in parallel with US2/US3 once Foundational is done
- **Polish (Phase 7)**: depends on all four stories

### User Story Dependencies

- **US1 (P1)**: Foundational only. MVP — stop + validate here first.
- **US2 (P1)**: Foundational + shares `persona-policy.ts`/`mcp-server.ts` with US1 (sequential, not parallel, on those files)
- **US3 (P2)**: Foundational. Logic lives in T010; this story is mostly verification — can run after US2 (same files)
- **US4 (P2)**: Foundational only. UI files (`ui/src/…`) are disjoint from US1–US3 → genuinely parallelizable with US2/US3

### Within Each User Story

- Tests written alongside (or just before) implementation; verify they FAIL first, then pass
- `persona-policy.ts` (shared) before `mcp-server.ts` wiring (transport)
- Tool registration before description trimming (same file)

### Parallel Opportunities

- **Phase 2**: T003–T008 are all `[P]` (different files: migration, db.ts, config types, config store, persona-policy.ts, personas.ts)
- **Phase 3**: T015 + T016 tests are `[P]` (different test files)
- **Phase 4**: T020–T023 are sequential (same file `tests/persona-policy.test.ts`); draft together, commit in order
- **Phase 6**: T031 + T032 tests are `[P]`; T033 (api.ts) is `[P]` with the tests
- **Phase 7**: T037, T038, T043, T044 are `[P]` (disjoint doc/config files)

---

## Parallel Example: Foundational Phase

```bash
# These five touch different files and can be drafted in parallel:
Task T003: "Add migration migrations/004_add_persona_source.sql"
Task T005: "Add PersonaPolicy type to src/config/types.ts"
Task T007: "Add PersonaSource/PersonaEvent types to src/fusion/persona-policy.ts"
Task T008: "Add PersonaLite + toLite() to src/fusion/personas.ts"
Task T009: "Thread persona_source through src/store/activity.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1: Setup (branch + 005 check)
2. Phase 2: Foundational (schema, config, types, resolution core, FusionInput plumbing)
3. Phase 3: User Story 1 (`list_personas` + override happy path)
4. **STOP and VALIDATE**: T1 + T2 green → an agent can discover + use a persona
5. Demo-ready: the core value (discovery + selection) is shippable here

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. + US1 → discovery + override works (MVP)
3. + US2 → strict policy + elicitation (the user's control lever)
4. + US3 → invalid-id robustness
5. + US4 → dashboard audit + Config toggle
6. Polish → skill docs, edge validation, v0.3.0 bump

### Single-Developer Sequential (recommended for this repo)

Foundational → US1 → US2 → US3 → US4 → Polish. US1–US3 share `persona-policy.ts` + `mcp-server.ts`, so sequential avoids merge friction; US4 (UI) is the only story that could cleanly parallelize.

---

## Notes

- `[P]` = different files, no dependency on incomplete tasks in the same phase
- `[USx]` maps the task to a user story for traceability
- Each story is independently testable per its quickstart scenario
- Verify tests FAIL before implementing, then pass
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently
- **Avoid**: vague tasks, same-file conflicts within a phase, cross-story dependencies that break independence
- **Constitution**: every task traces to a constitution-PASS principle (see plan.md gate table); no NON-NEGOTIABLE violations
