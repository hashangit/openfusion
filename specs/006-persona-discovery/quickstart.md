# Quickstart: Persona Discovery & Policy (MCP)

**Feature**: 006-persona-discovery | **Date**: 2026-06-19

Runnable validation scenarios proving the feature works end-to-end. Each scenario is independently testable. References [spec.md](./spec.md) requirements, [data-model.md](./data-model.md) fields, and the [MCP contract](./contracts/mcp-persona-tools.md).

**Implementation bodies belong in `tasks.md`, not here.** This is a validation/run guide.

---

## Prerequisites

- OpenFusion configured: ≥2 enabled candidates + ≥1 enabled judge + keys for all referenced providers (constitution VI).
- Built with feature 006 changes; dev server running (`pnpm dev` or the built `dist/`).
- A way to drive MCP calls: either the test suite (Vitest + `registerFauxProvider`) or a manual MCP probe (e.g. the codex/ZCode client, or a stdio JSON-RPC script).
- For elicitation scenarios: a client that advertises `elicitation.form`; for notification-only scenarios, any client.

---

## T1 — `list_personas` returns descriptors only (SC-001, FR-001, FR-002)

**Goal**: discovery output is lightweight and well-formed.

**Steps**:
1. Call the `list_personas` tool (no args).
2. Parse `content[0].text` as JSON.

**Expected**:
- Array with ≥4 entries (the builtins: `generalist`, `qa`, `researcher`, `pm`).
- Each entry has EXACTLY `{id, name, description, builtin, active}` — no other keys.
- `JSON.stringify(output).includes("workerPrompt" | "analysisPrompt" | "synthesisPrompt")` is `false` (the SC-001 assertion).
- Exactly one entry has `active=true`.
- `builtin=true` for the 4 shipped defaults; `builtin=false` for any user customs.

---

## T2 — `allow-override`: valid request honored (SC-002, FR-007)

**Goal**: the happy path — agent discovers and uses a persona.

**Steps**:
1. Ensure `config.settings.personaPolicy === "allow-override"` (default).
2. Set `activePersona = "generalist"` (via dashboard or direct config).
3. Call `fusion({ prompt: <smoke>, persona: "qa" })`.
4. Inspect the latest `activities` row.

**Expected**:
- Fusion runs (returns a synthesized answer).
- `activities.persona === "qa"`.
- `activities.persona_source === "override"`.
- No warning notification emitted.

---

## T3 — `strict`: user wins, agent warned, never blocked (SC-003, FR-005, FR-006)

**Goal**: strict policy runs the active persona and signals the override attempt.

**Steps (notification-only client)**:
1. Set `personaPolicy = "strict"`, `activePersona = "researcher"`.
2. Use a client that does NOT advertise `elicitation`.
3. Call `fusion({ prompt, persona: "qa" })`.
4. Capture emitted notifications + inspect the activity row.

**Expected**:
- Fusion completes (no error, no block).
- `activities.persona === "researcher"` (active ran).
- `activities.persona_source === "strict-enforced"`.
- A `notifications/message` was emitted with `level:"warning"`, `data:{requested:"qa", used:"researcher", reason:"strict-enforced"}`.

**Steps (elicitation-capable client)** — T3b:
1. Same config as T3.
2. Use a client advertising `elicitation.form`.
3. Call `fusion({ prompt, persona: "qa" })` and respond `"keep-strict"` to the elicitation.

**Expected**:
- One `elicitation/create` sent.
- `activities.persona_source === "strict-enforced"` (user kept strict).
- Subsequent calls in the same session do NOT trigger another elicitation.

---

## T4 — Elicitation "relax" honors the request for the session (FR-006, SC-004)

**Goal**: opting in changes behavior for the rest of the session, once.

**Steps**:
1. Strict mode, elicitation-capable client.
2. Call `fusion({ prompt, persona: "qa" })`; respond `"relax"` to the elicitation.
3. Call `fusion({ prompt, persona: "researcher" })` again (different persona).

**Expected**:
- Exactly ONE elicitation sent (for the first call).
- First call: `activities.persona === "qa"`, `persona_source === "override"` (relaxed).
- Second call: `activities.persona === "researcher"`, `persona_source === "override"` (no re-prompt, agent honored).
- `SessionOverrideState.decision === "relax"` in memory (not persisted — restart resets it).

---

## T5 — Concurrency: N calls → one elicitation (SC-004, R-007)

**Goal**: concurrent fusions under strict + elicitation don't multi-prompt.

**Steps**:
1. Strict mode, elicitation-capable client.
2. Fire 3 `fusion({ persona: "qa" })` calls concurrently (`Promise.all`).
3. Respond to the (single) elicitation with `"relax"`.

**Expected**:
- Exactly ONE `elicitation/create` observed.
- All 3 calls run with `persona="qa"`, `persona_source="override"`.

---

## T6 — Invalid id falls back gracefully (SC-005, FR-008)

**Goal**: wrong ids never break the call; the fallback is visible.

**Steps**:
1. Any policy. `activePersona = "generalist"`.
2. Call `fusion({ prompt, persona: "does-not-exist" })`.
3. Inspect the activity row + notifications.

**Expected**:
- Fusion completes (no error).
- `activities.persona === "generalist"` (active).
- `activities.persona_source === "invalid-fallback"`.
- Warning notification with `reason:"invalid-fallback"`.

---

## T7 — UI-triggered fusion is policy-exempt (FR-010, INV-4)

**Goal**: the dashboard's own fusions ignore the policy.

**Steps**:
1. Set `personaPolicy = "strict"`, `activePersona = "researcher"`.
2. From the dashboard's Generations/Playground, trigger a fusion with persona `qa` selected in the UI.
3. Inspect the activity row.

**Expected**:
- Fusion runs with `qa` (the user IS the picker).
- `activities.persona_source === "active"` (UI exemption — never `override`/`strict-enforced`).
- No warning notification, no elicitation.

---

## T8 — Generations tab renders source provenance (FR-013, SC-007)

**Goal**: the audit dimension is visible to the user.

**Steps**:
1. Produce one activity for each `persona_source` value (via T2, T3, T6 + a legacy row).
2. Open the Generations tab for each.

**Expected chip text**:
- `override` → `◈ qa (client override)`
- `strict-enforced` → `◈ researcher (strict-enforced)`
- `invalid-fallback` → `◈ generalist (invalid-fallback)`
- `active` → `◈ <persona>` (no suffix)
- `NULL` (legacy) → `◈ <persona>` (no suffix — indistinguishable from `active`, by design)

---

## T9 — Config tab exposes the policy toggle (FR-014)

**Goal**: the user can flip the policy, with clear helper text.

**Steps**:
1. Open the Config tab.
2. Locate the `personaPolicy` control.

**Expected**:
- A select/segmented control with values `strict` / `allow-override`.
- Helper text stating: "Gates whether MCP clients (e.g. agents) may override your active persona per fusion. Your dashboard fusions are never affected."
- Changing it persists to `config.json` and is reflected on the next `fusion` call.

---

## T10 — Existing suite stays green (SC-008)

**Goal**: no regressions.

**Steps**: `pnpm test`.

**Expected**: all 57 (as of v0.2.1) pre-existing tests pass; new tests for T1–T9 added and green.

---

## T11 — Skill teaches the 2-call pattern (FR-015, SC-009)

**Goal**: an agent reading the skill learns discover-then-use.

**Steps**:
1. Read `.zcode/skills/openfusion/SKILL.md`.
2. Check it documents: call `list_personas`, pick by id, pass `persona=<id>` to `fusion`.
3. Check it links to `resources/persona-*.md` for deep guidance.
4. Confirm the first-level SKILL.md does NOT inline the full persona prompt text or per-persona deep guidance.

**Expected**: all four hold; the first-level skill is token-light, deep guidance lives in `resources/`.

---

## E1 — Process restart resets session opt-in (edge)

**Goal**: "relax for session" is truly session-scoped.

**Steps**:
1. Strict + elicitation; relax via T4.
2. Restart the OpenFusion process.
3. Call `fusion({ persona: "qa" })` again.

**Expected**: elicitation fires again (session state was in-memory). `config.settings.personaPolicy` is still `strict` (NOT mutated by the opt-in).

---

## E2 — Legacy rows render without suffix (edge, INV-1)

**Goal**: pre-006 activities don't break the UI.

**Steps**:
1. Ensure the DB has activities from before migration 004 (or simulate: a row with `persona_source IS NULL`).
2. Open Generations tab for such a row.

**Expected**: chip shows `◈ <persona>` (no suffix, no crash).
