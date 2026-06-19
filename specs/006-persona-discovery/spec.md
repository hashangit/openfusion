# Feature Specification: Persona Discovery & Policy (MCP)

**Feature Branch**: `006-persona-discovery`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "Let MCP clients discover available personas and request a specific one per fusion, with a user-controlled policy toggle (strict vs. allow-override) and a verifiable audit trail. Move persona enumeration out of the system prompt and into on-demand discovery."

## Background & Motivation

As of v0.2.1, OpenFusion ships 4 built-in personas (`generalist`, `qa`, `researcher`, `pm`) and lets users define custom ones. The `fusion` tool accepts an optional `persona` arg (id or name) that overrides the dashboard's active persona, resolved gracefully by `resolvePersona()` (never throws — bad ids silently fall back to the active persona).

Three gaps exist today:

1. **No discovery.** The MCP surface exposes only `fusion` and `open_dashboard`. An agent has no way to enumerate available personas — it must guess ids from the tool description, which hardcodes the 4 builtins as examples. Any user-defined custom persona is invisible to the client. A wrong id silently degrades to the active persona with no signal to the caller.

2. **No policy enforcement.** The user's dashboard-selected "active persona" is advisory — any MCP client can override it per-call with no gate, no log distinction, and no user consent. A user who wants their selected persona used strictly has no way to enforce that.

3. **Persona list bloats the system prompt.** The `fusion` tool description embeds persona names and examples inline, costing tokens on every invocation regardless of whether the agent intends to use persona selection.

This feature closes all three by introducing (a) a `list_personas` discovery tool returning lightweight descriptors (id/name/description/builtin/active — never the raw prompts), (b) a `personaPolicy` config enum governing override behavior, and (c) a `persona_source` audit column making the resolution provenance verifiable in the dashboard.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent discovers personas, then requests the suitable one (Priority: P1)

A Tasks/MCP-aware agent facing a hard problem calls `list_personas`, receives a structured JSON array of `{id, name, description, builtin, active}`, picks the one matching the task (e.g. `qa` for code review), and calls `fusion` with `persona: "qa"`. The fusion runs with the QA persona's worker/judge prompts. The activity row records `persona='qa'`, `persona_source='override'`.

**Why this priority**: This is the core of the feature — discovery + selection. Without it, agents cannot meaningfully use the persona system that already exists server-side.

**Independent Test**: From an MCP client, call `list_personas`. Verify it returns ≥4 entries (the builtins), each with non-empty `name` and `description`, exactly one with `active=true`, and none exposing `workerPrompt`/`analysisPrompt`/`synthesisPrompt` fields. Then call `fusion` with `persona:"qa"`. Verify the DB row's `persona='qa'` and `persona_source='override'`.

**Acceptance Scenarios**:
1. **Given** OpenFusion is configured, **When** the client calls `list_personas`, **Then** it receives a `CallToolResult` whose content is a JSON array; each entry has exactly `{id, name, description, builtin, active}` — no prompt fields; exactly one entry has `active=true`.
2. **Given** `list_personas` output, **When** the agent picks `id="qa"` and calls `fusion(persona:"qa")` (allow-override policy), **Then** the fusion uses the QA persona and the activity row has `persona='qa'`, `persona_source='override'`.

---

### User Story 2 - Strict mode: user's selection wins, agent is warned not blocked (Priority: P1)

The user sets `personaPolicy: "strict"` in the dashboard (their active persona is, say, `researcher`). An agent requests `persona: "qa"`. OpenFusion does NOT run QA — it runs `researcher` (the active persona), records `persona_source='strict-enforced'`, and emits a warning notification to the client carrying {requested, used, reason}. The fusion completes normally; the agent is never lied to about which persona ran (the notification + audit field tell the truth). If the client supports `elicitation`, OpenFusion additionally prompts the user once per session: "Agent requested 'qa' but strict mode is on. Relax for this session?" The answer is remembered in-process for subsequent calls in the same session.

**Why this priority**: The policy toggle is the user's control lever — without it, discovery is a one-way ratchet toward agents overriding user intent.

**Independent Test**: Set `personaPolicy:"strict"`, active persona `researcher`. Call `fusion(persona:"qa")` from a client that does NOT advertise elicitation. Verify (a) the fusion answer reflects the researcher persona, (b) the activity row has `persona='researcher'`, `persona_source='strict-enforced'`, (c) a `notifications/message` warning was emitted. Then repeat with a client that DOES advertise elicitation and verify the user is prompted once.

**Acceptance Scenarios**:
1. **Given** `personaPolicy:"strict"` and active persona `P_active`, **When** a client calls `fusion(persona:"X")` where X ≠ P_active, **Then** the fusion runs with `P_active`, the activity row has `persona=P_active`, `persona_source='strict-enforced'`, and a warning notification is emitted with `{requested:"X", used:P_active, reason:"strict-enforced"}`.
2. **Given** the client advertises the `elicitation` capability, **When** strict enforcement triggers for the first time in a session, **Then** OpenFusion sends an elicitation asking the user whether to relax strict for the session; on "yes", subsequent calls in that session skip elicitation and honor the agent's persona (source `override`); on "no", subsequent calls skip elicitation and continue enforcing strict.
3. **Given** the client does NOT advertise elicitation, **When** strict enforcement triggers, **Then** only the notification is emitted (no elicitation attempt), and the fusion proceeds with the active persona.

---

### User Story 3 - Invalid persona id falls back gracefully (Priority: P2)

An agent passes `persona: "nonexistent"`. Whether in allow-override or strict mode, OpenFusion does not error — it runs the active persona, records `persona_source='invalid-fallback'`, and emits a warning notification. This preserves the existing "never throw on persona resolution" contract while making the fallback visible and auditable.

**Why this priority**: Robustness. Agents will send wrong ids; the system must degrade gracefully and visibly, not crash or silently look correct.

**Independent Test**: Call `fusion(persona:"does-not-exist")` in allow-override mode. Verify the activity row has `persona=<active>`, `persona_source='invalid-fallback'`, and a warning notification fired.

**Acceptance Scenarios**:
1. **Given** any policy, **When** a client calls `fusion(persona:"<invalid-id>")`, **Then** the fusion runs with the active persona, `persona_source='invalid-fallback'`, and a warning notification carries `{requested:"<invalid-id>", used:<active>, reason:"invalid-fallback"}`.

---

### User Story 4 - Audit trail shows provenance in the dashboard (Priority: P2)

The Generations tab displays not just which persona ran, but *how it was chosen*: `◈ researcher` (active), `◈ qa (client override)`, `◈ researcher (strict-enforced)`, or `◈ generalist (invalid-fallback)`. Legacy rows (pre-006) show the persona with no source suffix. This makes the policy verifiable end-to-end.

**Why this priority**: Without visibility, the user cannot tell whether strict mode is actually being honored.

**Independent Test**: Trigger fusions under each of the four sources. Open the Generations tab for each and verify the chip text matches the source. Open a pre-006 activity and verify the chip shows the persona with no suffix.

**Acceptance Scenarios**:
1. **Given** an activity with `persona_source='override'`, **When** viewed in the Generations tab, **Then** the persona chip reads `◈ <persona> (client override)`.
2. **Given** an activity with `persona_source IS NULL` (legacy), **When** viewed, **Then** the chip reads `◈ <persona>` with no suffix.

---

### Edge Cases

- **Concurrent `fusion` calls under strict + elicitation**: if N calls arrive while strict is active and elicitation is supported, only the FIRST triggers an elicitation prompt; concurrent callers await the same in-process promise and reuse the answer. No duplicate prompts.
- **Session opt-in lifetime**: "relax for this session" is an in-process boolean, cleared on server restart. It is NOT persisted to `config.json` (that would silently flip the user's global setting). Documented.
- **Elicitation rejection / timeout**: if the user rejects or the elicitation times out, strict remains in effect for the session; no retry loop.
- **UI-triggered fusions**: the dashboard's own Generations/Playground path is exempt from the policy — the user IS the picker, so `persona_source` is always `active`. The policy gates MCP clients only.
- **No personas configured** (edge): `list_personas` still returns the 4 builtins (they're always available as the fallback baseline).
- **`list_personas` under strict mode**: returns the full list with `active` flagged — discovery is never gated by policy; only the `fusion` override is.
- **`list_personas` token cost**: the response is a JSON array of lightweight descriptors, deliberately excluding the worker/analysis/synthesis prompt text. Agents pick by name+description; they never need the raw prompts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: OpenFusion MUST expose a `list_personas` MCP tool that returns a JSON array; each entry has exactly `{id, name, description, builtin, active}` — the raw prompt fields (`workerPrompt`, `analysisPrompt`, `synthesisPrompt`) MUST NOT appear in the output.
- **FR-002**: Exactly one persona in the `list_personas` output MUST have `active=true` (the dashboard-selected active persona, resolved via the existing `resolvePersona` precedence).
- **FR-003**: The `fusion` tool description MUST be updated: remove the inline enumeration of persona names/examples; add a one-sentence discovery nudge ("call `list_personas` to see available personas; pass `persona=<id>` to override, subject to the user's persona policy").
- **FR-004**: OpenFusion MUST introduce a `personaPolicy` config field of type `"strict" | "allow-override"` with default `"allow-override"`, persisted in `config.json` (not secrets — not sensitive).
- **FR-005**: When `personaPolicy="strict"` and an MCP client passes a `persona` differing from the active persona, OpenFusion MUST run the active persona, set `persona_source="strict-enforced"`, and emit a `notifications/message` warning carrying `{requested, used, reason}`.
- **FR-006**: When the client advertises the MCP `elicitation` capability AND strict enforcement triggers, OpenFusion MUST send an elicitation request asking whether to relax strict for the session; the answer MUST be remembered in-process for the rest of the session (concurrent callers share one promise, no duplicate prompts).
- **FR-007**: When `personaPolicy="allow-override"` and the client passes a valid persona id/name, OpenFusion MUST run it and set `persona_source="override"`.
- **FR-008**: When the client passes an invalid persona id/name (under any policy), OpenFusion MUST run the active persona, set `persona_source="invalid-fallback"`, and emit a warning notification. It MUST NOT error.
- **FR-009**: The policy enforcement MUST live inside `runFusion` (fusion.ts), NOT in the MCP handler, so both the plain `fusion` tool and the task-augmented path (`experimental.tasks.registerToolTask`) share the same enforcement.
- **FR-010**: UI-triggered fusions (dashboard Generations/Playground) MUST be exempt from the policy; `persona_source` is `active` for those calls.
- **FR-011**: OpenFusion MUST add a `persona_source` column to the `activities` table via an additive migration (`NULL` for legacy rows; valid values: `active`, `override`, `strict-enforced`, `invalid-fallback`).
- **FR-012**: The `activities` API serialization (list + detail) MUST include `persona_source`.
- **FR-013**: The Generations tab MUST render the persona chip with source provenance: `(client override)`, `(strict-enforced)`, `(invalid-fallback)`, or no suffix for `active`/NULL.
- **FR-014**: The Config tab MUST expose the `personaPolicy` toggle with helper text clarifying it gates MCP-client overrides only (not the dashboard's own fusions).
- **FR-015**: The `openfusion` skill MUST be updated to teach the 2-call pattern (`list_personas` → `fusion(persona)`), and progressive disclosure: the first-level SKILL.md links to persona-depth resources in the skill's `resources/` folder (per Agent Skills standard), so niche persona guidance loads only when relevant.
- **FR-016**: `list_personas` MUST be invocable regardless of policy (discovery is never gated); the active persona is always flagged in its output.

### Key Entities *(include if feature involves data)*

- **PersonaLite** (new, view-only): `{id, name, description, builtin, active}` — the discovery projection of a `Persona`, excluding all prompt fields. Returned by `list_personas`.
- **PersonaPolicy** (new config enum): `"strict" | "allow-override"`. Stored in `config.json`. Gates MCP-client persona overrides only.
- **PersonaSource** (new audit enum): `"active" | "override" | "strict-enforced" | "invalid-fallback"`. Stored on `activities.persona_source` (nullable for legacy rows).
- **SessionOverrideState** (new, in-memory only): per-stdio-session state tracking whether the user has opted to relax strict mode for this session. Holds a shared `Promise` for concurrent elicitation calls. Cleared on process restart; never persisted.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An MCP client calling `list_personas` receives a JSON array whose entries expose descriptor fields only — no prompt fields are present (asserted by a test that greps the serialized output for `workerPrompt` and expects zero matches).
- **SC-002**: A client calling `fusion(persona:"qa")` under `allow-override` produces an activity row with `persona='qa'`, `persona_source='override'`.
- **SC-003**: A client calling `fusion(persona:"qa")` under `strict` (active=`researcher`) produces an activity row with `persona='researcher'`, `persona_source='strict-enforced'`, AND emits a warning notification with the correct `{requested, used, reason}` payload.
- **SC-004**: When the client advertises elicitation and strict triggers, exactly ONE elicitation is sent per session regardless of the number of concurrent/sequential triggering calls (concurrency test).
- **SC-005**: A client calling `fusion(persona:"<invalid>")` produces `persona_source='invalid-fallback'` and a warning, never an error.
- **SC-006**: The `fusion` tool description's token footprint shrinks — measured as: the new description string is strictly shorter than the pre-006 description (captured as a `PRE_006_FUSION_DESCRIPTION` snapshot constant), and the inline persona id enumeration (`qa`, `researcher`, `pm`) is absent from the new string. Asserted via a length comparison + a substring-absence check.
- **SC-007**: The Generations tab renders the four `persona_source` variants with the correct suffix text, and renders legacy (`NULL`) rows with no suffix.
- **SC-008**: All existing tests (57 as of v0.2.1) continue to pass; new tests cover discovery, override, strict (with/without elicitation), invalid-fallback, concurrency, and UI rendering.
- **SC-009**: The `openfusion` skill teaches the 2-call pattern and uses progressive disclosure via its `resources/` folder; the first-level SKILL.md does not inline deep persona guidance.

## Assumptions

- **Capability detection is runtime**: `elicitation` is a per-client capability advertised during MCP initialization. OpenFusion checks it per-session and falls back to notification-only when absent. No build-time assumption about which clients support it.
- **Stdio = one client per process**: "session" in the relax-strict opt-in means process lifetime. The in-memory `SessionOverrideState` is correct because stdio MCP is 1:1 client↔server. (If OpenFusion ever gains multi-client transport, this assumption must be revisited.)
- **Persona prompts are never agent-visible**: by design (confirmed). Agents pick by name+description; exposing prompt text would add token cost with no actionable benefit and could invite agents to "complement" a persona in their own system prompt (a footgun). `list_personas` excludes prompts; no `get_persona` tool is added.
- **Policy does not gate discovery**: `list_personas` returns the full list under any policy. Enforcement is at `fusion` time only. Blocking discovery in strict mode would be hostile and pointless.
- **`resolvePersona` never-throws contract preserved**: invalid ids still fall back; this feature makes the fallback *visible* (audit + notification) rather than changing the fallback behavior itself.
- **Additive migration is non-breaking**: `activities.persona_source` is `TEXT NULL`; legacy rows stay NULL; the UI treats NULL as "no suffix." No backfill required.
- **`personaPolicy` is not sensitive**: stored in plaintext `config.json` alongside other non-secret settings (not in `secrets.enc`).
- **Skill update is in scope**: the current skill assumes agents know persona ids from the system prompt; the new contract is discover-then-use.
