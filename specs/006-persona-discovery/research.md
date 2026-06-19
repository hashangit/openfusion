# Research: Persona Discovery & Policy (MCP)

**Feature**: 006-persona-discovery | **Date**: 2026-06-19

Phase 0 research. Resolves every NEEDS CLARIFICATION and locks the design decisions that Phase 1 builds on. Each entry: Decision → Rationale → Alternatives rejected.

---

## R-001: Where does the persona-policy check live?

**Decision**: Inside `runFusion` (`src/fusion/fusion.ts`), not in the MCP handler.

**Rationale**: There are two fusion entry points — the plain `server.tool('fusion', …)` and the task-augmented `experimental.tasks.registerToolTask('fusion', …)` (added in feature 005). Both pass `args.persona` into `runFusion`. If the policy check sits in the MCP handler, the task path bypasses it. Putting it in `runFusion` guarantees one enforcement site for both paths and any future ones.

The check needs:
- The requested persona id (already on `FusionInput.persona`).
- The active persona + configured personas (already read from `input.config`).
- The policy (`input.config.settings.personaPolicy` — new field, see R-005).
- A channel to emit warnings/elicitation (new `FusionInput.onPersonaEvent?` callback — see R-004).

**Alternatives rejected**:
- *MCP handler middleware*: rejected — task path is a separate registration; would need duplication.
- *A separate `enforcePersonaPolicy()` called by both handlers*: rejected — spreads the "policy + persona_source" computation across two files and risks drift.

---

## R-002: How does the server detect the `elicitation` client capability?

**Decision**: Call `server.server.getClientCapabilities()` (the low-level `Server` class method, verified at SDK `server/index.js:285`) at the moment strict-enforcement triggers. Check `caps?.elicitation` (presence = any elicitation support).

**Rationale**: Client capabilities arrive during MCP `initialize` and are stored on the `Server` instance. They are **not** available at server-construction time (the client hasn't connected yet), so capability detection must be lazy, at call time. `getClientCapabilities()` returns `undefined` if the client hasn't advertised elicitation.

**Alternatives rejected**:
- *Cache caps at initialize via an event handler*: rejected — premature optimization; the lookup is a property read, and caching introduces a stale-cache risk if the client ever re-initializes.
- *Assume the codex/ZCode client supports elicitation*: rejected — the contract is "any MCP client", not a specific one. Some stdio clients won't support it.

---

## R-003: How is the relax-strict elicitation actually sent? (NEEDS CLARIFICATION — resolved)

**Question**: The SDK's built-in elicitation helpers (`server/index.js:355-366`) only support `url` and `form` flavors, both gated by the corresponding sub-capability (`_clientCapabilities.elicitation.url|form`). A yes/no "relax strict for this session?" question is neither a URL redirect nor a rich form. What is the right mechanism?

**Decision**: Use **`form` elicitation** with a minimal single-select schema — a "relax" / "keep strict" choice plus a short prompt. Gate on `caps?.elicitation?.form`. Fall back to notification-only when form elicitation is absent.

**Rationale**:
- The MCP spec's `elicitation/create` with `form` params is the closest fit to a yes/no decision with context. We send a 1-field form.
- `url` elicitation is for browser-redirect flows (auth) — wrong shape for an in-session toggle.
- Sending a raw `elicitation/create` JSON-RPC with a custom `multipleSchema`/boolean type would be cleaner but the SDK's typed helpers don't expose it, and hand-rolling a raw `server.request({method:'elicitation/create', …})` bypasses the SDK's validation. Using `form` via the helper is the supported path on the pinned SDK (1.29.0).
- The risk: a client that advertises `elicitation` but only `url` (not `form`) gets notification-only. Acceptable — notification is the floor, elicitation is the upgrade.

**Alternatives rejected**:
- *Raw `elicitation/create` with a boolean schema*: cleaner semantically, but unsupported by the SDK's typed helpers on 1.29.0 and fragile across clients.
- *`sampling/createMessage`*: wrong — that's for LLM generation, not user input.
- *Just use a notification + dashboard banner*: rejected per user decision A (do HITL where possible).

**Open note for tasks.md**: if the codex/ZCode client in practice advertises `elicitation.form`, verify in the implementation task with a live test. If it only advertises `elicitation.url`, the notification-only path is the de-facto experience on that client — documented, not a bug.

---

## R-004: How are warnings + elicitation surfaced from `runFusion` to the MCP layer?

**Decision**: Add an optional callback to `FusionInput`:

```ts
export type PersonaEvent =
  | { kind: "warning"; source: PersonaSource; requested?: string; used: string }
  | { kind: "elicitation-request"; requested: string; used: string };

export interface FusionInput {
  // …existing fields…
  onPersonaEvent?: (e: PersonaEvent) => Promise<"relax" | "keep-strict" | undefined>;
}
```

`runFusion` calls `onPersonaEvent` when it detects strict/invalid scenarios. The MCP layer wires this callback to: emit `notifications/message` (always), and if the client supports elicitation, send the form and return the user's answer. `runFusion` interprets the return: `"relax"` → honor the requested persona this call (source `override`), `"keep-strict"`/`undefined` → run active persona (source `strict-enforced`).

**Rationale**: `runFusion` already takes an `onProgress` callback for the same reason (decoupling engine from transport). `onPersonaEvent` follows the established pattern. The callback returns the elicitation answer so `runFusion` can decide synchronously without re-entrancy.

**Alternatives rejected**:
- *Throw a special error up to the handler*: rejected — errors mean the fusion didn't happen; we want warn-and-continue.
- *Put elicitation logic inside `runFusion`*: rejected — couples the engine to the MCP SDK; violates layering (constitution: engine knows nothing of transport).

---

## R-005: Where is `personaPolicy` stored, and what's the default?

**Decision**: `config.settings.personaPolicy: "strict" | "allow-override"`, default `"allow-override"`. Stored in plaintext `config.json` (not `secrets.enc` — it's not a secret).

**Rationale**:
- The existing `settings` object already holds `activePersona`, `benchmarkMode`, `workerTimeoutMs` — all non-sensitive knobs. `personaPolicy` is the same kind of field.
- Default `allow-override` matches the user's stated intent ("by default, agent can use the suitable one").
- Config migration v3 → v4: if `settings.personaPolicy` is absent, inject `"allow-override"`. Follows the existing migration pattern in `store.ts` (v2→v3 injected `activePersona`).

**Alternatives rejected**:
- *Boolean `allowPersonaOverride`*: rejected — leaves no room for a future `"allow-builtin-only"` tier. Enum is future-proof at no cost.
- *Store in `secrets.enc`*: rejected — not sensitive; would complicate the read path.
- *Per-persona policy*: rejected — YAGNI; the policy is about the *act* of overriding, not individual personas.

---

## R-006: How is `persona_source` stored and surfaced?

**Decision**: New nullable column `activities.persona_source TEXT`, values in `{active, override, strict-enforced, invalid-fallback}`. `NULL` for legacy rows (pre-006). Migration `004_add_persona_source.sql` is additive (`ALTER TABLE activities ADD COLUMN persona_source TEXT`). The activity API serialization (already `SELECT *`) exposes it; the UI `Activity` type gains `persona_source?: string | null`.

**Rationale**:
- Nullable + no backfill = zero-risk migration. Legacy rows show no suffix in the UI (treated as "unknown / pre-006").
- Free-text column (not a CHECK constraint) mirrors the existing `status` column's design philosophy (constitution: simple, no over-engineering).
- `SELECT *` already returns it; serialization needs only the TS type addition.

**Alternatives rejected**:
- *Encode source in the existing `status` field (e.g. `ok:override`)*: rejected — corrupts the activity-status dimension (constitution V) and breaks every existing status query.
- *Backfill legacy rows to `active`*: rejected — we don't know the true source of pre-006 fusions; NULL = honest "unknown".

---

## R-007: Concurrency strategy for the session relax-strict promise

**Question**: If N `fusion` calls arrive while strict is active and the client supports elicitation, how do we avoid N duplicate prompts?

**Decision**: A module-level `SessionOverrideState` object, scoped to the stdio server instance (one client per process — assumption verified):

```ts
interface SessionOverrideState {
  // Tristate: undefined = not yet asked, "relax" = relax for session, "keep-strict" = keep strict for session.
  decision?: "relax" | "keep-strict";
  // Shared promise: the first caller creates it (triggers elicitation); concurrent callers await it.
  inflight?: Promise<"relax" | "keep-strict">;
}
```

First caller: sees `decision === undefined && inflight === undefined` → creates `inflight = elicit()`, awaits it, stores `decision`, clears `inflight`. Concurrent callers: see `inflight` set → await the same promise. Subsequent callers (after resolution): see `decision` set → return immediately.

**Rationale**:
- Single shared promise = exactly one elicitation per session, regardless of concurrency (SC-004).
- "Session" = process lifetime (stdio = 1 client). Cleared on restart; never persisted (R-004 — persisting would silently flip the user's global `personaPolicy`).
- `Promise.allSettled` is already used in fan-out; the engine is comfortable with shared-promise concurrency.

**Edge cases handled**:
- Elicitation rejects/times out → treat as `"keep-strict"` (strict stays); `decision` set so we don't re-prompt.
- Client disconnects mid-elicitation → promise rejects → callers fall through to `strict-enforced`; state resets on new session.
- UI-triggered fusions → never trigger this path (they pass `onPersonaEvent = undefined`; `runFusion` sees no channel, defaults to source `active`).

**Alternatives rejected**:
- *Per-call elicitation (no dedup)*: rejected — N concurrent fusions = N prompts; hostile UX.
- *Persistent flag in `config.json`*: rejected — would silently change the user's global policy setting behind their back.

---

## R-008: `list_personas` output shape — structured JSON, no prompts

**Decision**: Return a `CallToolResult` whose `content[0]` is a `text` content block containing a JSON-serialized array of `PersonaLite`:

```json
[
  { "id": "generalist", "name": "Generalist", "description": "…", "builtin": true, "active": true },
  { "id": "qa", "name": "QA / Code Reviewer", "description": "…", "builtin": true, "active": false }
]
```

**Rationale**:
- Agents parse structured JSON reliably; prose wastes tokens and invites misreading.
- Excluding prompt fields (`workerPrompt`/`analysisPrompt`/`synthesisPrompt`) is deliberate and asserted by a test (SC-001): agents pick by name+description; they never need raw prompt text (confirmed user decision C).
- `active` is computed via the existing `resolvePersona` precedence (override→active→generalist→first), but since `list_personas` takes no override, it's just `activePersona` resolution.

**Alternatives rejected**:
- *MCP `resources/read` for persona detail*: rejected (user decision, gap 10 corrected) — progressive disclosure lives in the **skill's** `resources/` folder, not the MCP server. The server's job is the lightweight list.
- *A separate `get_persona` tool*: rejected (user decision C) — one tool only; descriptions are rich enough. No code bloat.

---

## R-009: System prompt / tool description trimming

**Decision**: Rewrite the `fusion` tool description to:
1. Remove the inline persona name enumeration (currently lists `qa`, `researcher`, `pm` as examples).
2. Add a one-sentence discovery nudge: *"To see available personas, call `list_personas`; pass `persona=<id>` to override the active one (subject to the user's persona policy)."*

**Rationale**: The inline list is both incomplete (custom personas invisible) and wasteful (loaded on every call whether or not persona selection is relevant). Discovery + nudge is cheaper and always accurate.

**Alternatives rejected**:
- *Leave the examples, add the nudge*: rejected — duplicates information and the examples will go stale as users add custom personas.

---

## R-010: Skill update — 2-call pattern + progressive disclosure

**Decision**: Update `.zcode/skills/openfusion/SKILL.md` to teach the 2-call pattern (`list_personas` → `fusion(persona)`). Keep the first-level skill thin. Move deep "when to use which persona" guidance into `resources/` files under the skill folder (per the Agent Skills standard), linked from SKILL.md:

```text
.zcode/skills/openfusion/
├── SKILL.md                          # thin: when to fuse, the 2-call pattern, link to resources
└── resources/
    ├── persona-qa.md                 # deep: when QA persona wins, what it optimizes for
    ├── persona-researcher.md
    ├── persona-pm.md
    └── persona-generalist.md
```

**Rationale**:
- Capable clients (ZCode, Claude) load SKILL.md and selectively read `resources/` only when the task matches — token-efficient.
- Matches the user's correction of gap 10: progressive disclosure lives in the skill, NOT in an MCP `resources/read` capability. The server exposes only `list_personas`.

**Alternatives rejected**:
- *Inline all persona guidance into SKILL.md*: rejected — bloats every skill load.
- *MCP `resources` capability*: rejected (user decision) — unnecessary; skill resources cover it.

---

## R-011: UI-triggered fusion policy exemption

**Decision**: The dashboard's Generations/Playground path calls `runFusion` with `onPersonaEvent: undefined` and no `persona` override (or `persona = activePersona`). `runFusion` records `persona_source = "active"` unconditionally for these calls. The `personaPolicy` is never consulted for UI calls.

**Rationale**: The user IS the picker in the UI. Gating the user behind their own strict-mode setting would be absurd. The policy gates *MCP clients only* — this must be stated in the Config-tab helper text (FR-014) to avoid confusion.

**Implementation note**: The cleanest signal is a new `FusionInput` field, e.g. `source?: "mcp" | "ui"` defaulting to `"mcp"`. When `source === "ui"`, skip the policy check entirely and set `persona_source = "active"`. This avoids inferring intent from the presence/absence of callbacks.

---

## Summary: locked design

| Concern | Locked decision |
|---|---|
| Policy enforcement site | `runFusion` (fusion.ts) — both entry paths covered |
| Capability detection | `server.server.getClientCapabilities()` at call time |
| Elicitation mechanism | `form` elicitation, gated on `caps.elicitation.form`; notification-only fallback |
| Engine↔transport channel | `onPersonaEvent` callback on `FusionInput` |
| Policy storage | `config.settings.personaPolicy` enum, default `allow-override` |
| Audit column | `activities.persona_source TEXT NULL`, additive migration 004 |
| Concurrency | Module-level `SessionOverrideState` with shared in-flight promise |
| Discovery output | `list_personas` → JSON array of `PersonaLite` (no prompts) |
| Skill | Thin SKILL.md + `resources/persona-*.md`; teach 2-call pattern |
| UI exemption | `FusionInput.source: "mcp"\|"ui"`; UI calls bypass policy |

All NEEDS CLARIFICATION resolved. Phase 1 can proceed.
