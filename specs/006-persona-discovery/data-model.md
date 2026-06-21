# Data Model: Persona Discovery & Policy (MCP)

**Feature**: 006-persona-discovery | **Date**: 2026-06-19

Derived from [spec.md](./spec.md) + [research.md](./research.md). Covers the new/changed entities, fields, migrations, and lifecycle. Existing entities (`Persona`, `Activity`, `SubCall`) are referenced, not redefined.

---

## Entities

### 1. `PersonaPolicy` (NEW — config enum)

Controls whether MCP clients may override the dashboard's active persona per fusion.

```ts
type PersonaPolicy = "strict" | "allow-override";
```

- **Storage**: `config.settings.personaPolicy` (plaintext `config.json`, NOT secrets).
- **Default**: `"allow-override"` (migration v3→v4 injects if absent).
- **Scope**: gates MCP-client `fusion` calls only. UI-triggered fusions are always exempt (FR-010).

| Value | Behavior on `fusion(persona=X)` where X ≠ active |
|---|---|
| `allow-override` (default) | Run X. `persona_source="override"`. |
| `strict` | Run active. `persona_source="strict-enforced"`. Warn (always) + elicit (if supported). |

---

### 2. `PersonaSource` (NEW — audit enum)

Records *how* the persona for a fusion was chosen. Stored on the activity row.

```ts
type PersonaSource = "active" | "override" | "strict-enforced" | "invalid-fallback";
```

| Value | Meaning |
|---|---|
| `active` | No override requested; the dashboard's active persona ran. Also used for ALL UI-triggered fusions. |
| `override` | Client requested a valid persona under `allow-override`; honored. |
| `strict-enforced` | Client requested a persona but `strict` policy ran the active one instead. |
| `invalid-fallback` | Client requested a persona id/name that resolves to nothing; fell back to active. |
| `NULL` | Legacy row (pre-006). Source unknown. |

**Validation**: free-text column (no CHECK constraint) — matches the existing `status` column's philosophy (constitution: simple). The TS type union is enforced at the write site, not the DB.

---

### 3. `PersonaLite` (NEW — view projection, not persisted)

The discovery projection of a `Persona`, returned by `list_personas`. **Excludes all prompt fields.**

```ts
interface PersonaLite {
  id: string;          // persona.id
  name: string;        // persona.name
  description?: string;// persona.description (may be undefined for customs)
  builtin: boolean;    // persona.builtin ?? false
  active: boolean;     // computed: this.id === resolved active persona id
}
```

**Projection rule**: `Persona → PersonaLite` is a strict narrowing. A test asserts the serialized output contains zero occurrences of `workerPrompt`, `analysisPrompt`, `synthesisPrompt` (SC-001).

**`active` computation**: uses `resolvePersona({personas, activeId: config.settings.activePersona}).id`. Exactly one entry has `active=true` (FR-002). If `activePersona` is unset/invalid, resolution falls back to `generalist` → exactly one entry (generalist) is `active`.

---

### 4. `SessionOverrideState` (NEW — in-memory only, never persisted)

Per-stdio-session state for the relax-strict elicitation dedup.

```ts
interface SessionOverrideState {
  decision?: "relax" | "keep-strict";                   // undefined = not yet asked
  inflight?: Promise<"relax" | "keep-strict">;          // shared across concurrent callers
}
```

- **Scope**: module-level singleton, scoped to the stdio server instance. One client per process (stdio transport), so one state object is correct.
- **Lifecycle**: created lazily on first strict-enforcement event; cleared on process restart. NEVER written to `config.json` (would silently flip the user's global policy).
- **Canonical values**: `"relax"` and `"keep-strict"` — identical to `PersonaEventResult` and the elicitation form `choice` enum. ONE enum, used everywhere (no `"keep"` shorthand).
- **Concurrency contract**:
  - First caller (`decision===undefined && inflight===undefined`): creates `inflight`, awaits, stores `decision`, clears `inflight`.
  - Concurrent callers (`inflight` set): await the same promise.
  - Subsequent callers (`decision` set): return immediately, no elicitation.
- **Failure semantics**: elicitation reject/timeout → treat as `"keep-strict"` (strict stays), set `decision="keep-strict"` (no re-prompt).

---

### 5. `PersonaEvent` (NEW — engine→transport callback payload)

The shape `runFusion` uses to signal persona-policy events up to the MCP layer (R-004).

```ts
type PersonaEvent =
  | { kind: "warning"; source: PersonaSource; requested?: string; used: string }
  | { kind: "elicitation-request"; requested: string; used: string };

type PersonaEventResult = "relax" | "keep-strict" | undefined;
```

- `warning`: always emitted for `strict-enforced` and `invalid-fallback`. The MCP layer translates it to `notifications/message`.
- `elicitation-request`: emitted only when strict + client supports elicitation. The MCP layer sends the form, returns the user's choice. `runFusion` honors `"relax"` by running the requested persona (source flips to `override`).
- `undefined` return (no callback / no elicitation capability): `runFusion` proceeds with `strict-enforced`.

---

## Changed Entities

### `FusionInput` (modified — `src/fusion/fusion.ts`)

```ts
export interface FusionInput {
  // …existing fields unchanged…
  persona?: string;
  /** NEW: where this call originated. "ui" bypasses the persona policy entirely. */
  source?: "mcp" | "ui"; // default "mcp"
  /** NEW: channel for persona-policy warnings + elicitation. UI calls leave undefined. */
  onPersonaEvent?: (e: PersonaEvent) => Promise<PersonaEventResult>;
}
```

- `source`: defaults to `"mcp"`. UI callers pass `"ui"` to record `persona_source="active"` unconditionally and skip the policy.
- `onPersonaEvent`: optional. Absent on UI calls; present on MCP calls (wired by the handler).

### `FusionResult` — unchanged. The `persona` field on the result still reflects the resolved persona id (already present).

---

## Schema Changes

### Migration `004_add_persona_source.sql`

```sql
ALTER TABLE activities ADD COLUMN persona_source TEXT;
```

- **Additive**, nullable, no backfill. Legacy rows = NULL.
- Idempotency: `ALTER TABLE … ADD COLUMN` on SQLite errors if the column exists; the migration runner wraps in a column-existence check (pattern from migrations 001–003).
- No index — `persona_source` is a display/filter dimension, not a query key.

### `config.json` migration v3 → v4

```jsonc
{
  "settings": {
    // …existing…
    "activePersona": "generalist",
    "personaPolicy": "allow-override"   // NEW, injected if absent
  }
}
```

- Injected by `migrateConfig()` in `src/config/store.ts` if `settings.personaPolicy` is absent. Follows the v2→v3 `activePersona` injection pattern.

---

## Activity Serialization (API)

The activity API already uses `SELECT *`, so `persona_source` flows through automatically. Changes:

- **`ActivityRow`** (`src/store/activity.ts`): add `persona_source?: string | null`.
- **`recordActivity` / `allocateActivity`**: accept and persist `persona_source` (alongside the existing `persona`).
- **UI `Activity` type** (`ui/src/api.ts`): add `persona_source?: string | null`.

---

## State Transitions

### Persona resolution within a single `runFusion` call

```
            ┌─ source==="ui" ────────────────────► persona_source="active" (no policy check)
            │
input ──────┤   requested valid?
            │       ├─ yes + allow-override ────► persona_source="override"
            │       ├─ yes + strict:
            │       │     ├─ elicit (if caps) → user "relax" ─► "override"
            │       │     └─ else / "keep-strict" ► "strict-enforced" (+warn)
            │       └─ no (invalid id) ─────────► persona_source="invalid-fallback" (+warn)
            └─ no override requested ───────────► persona_source="active"
```

The resolved `persona` (whose prompts actually run) and `persona_source` (audit reason) are written together to the activity row.

### `SessionOverrideState` lifecycle

```
[idle: decision=undefined, inflight=undefined]
   │ first strict trigger
   ▼
[asking: inflight=Promise<elicit>] ◄── concurrent callers await same promise
   │ resolve
   ▼
[resolved: decision="relax"|"keep-strict", inflight=undefined] ── subsequent calls return immediately
   │ process restart
   ▼
[idle] (cleared)
```

---

## Validation Rules (from requirements)

- **FR-001**: `list_personas` output entries have exactly 5 keys: `{id, name, description, builtin, active}`. No prompt keys. (Test-asserted.)
- **FR-002**: exactly one entry has `active=true`.
- **FR-008**: invalid persona id never errors — always falls back to active with `invalid-fallback` source.
- **FR-009**: policy check is inside `runFusion` (single enforcement site).
- **FR-011**: `persona_source` column is nullable TEXT; migration is additive.
- **SC-001**: serialized `list_personas` output contains zero matches for `workerPrompt|analysisPrompt|synthesisPrompt`.

---

## Invariants

- **INV-1**: Exactly one `activities.persona_source` value is written per fusion (never NULL for a 006+ fusion; NULL only for legacy).
- **INV-2**: The `persona` column (which persona ran) and `persona_source` column (why) are consistent: `persona_source="override"` ⟹ `persona == requested`; `persona_source in {"strict-enforced","invalid-fallback"}` ⟹ `persona == active`.
- **INV-3**: At most one elicitation per session (SC-004), enforced by `SessionOverrideState`.
- **INV-4**: UI-triggered fusions always have `persona_source="active"`, regardless of `personaPolicy`.
- **INV-5**: `personaPolicy` is never mutated by the relax-strict opt-in (which is session-scoped, in-memory only).
