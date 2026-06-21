# Data Model: Sequential Processing Option (Low-VRAM Local Models)

**Feature**: 007-sequential-processing | **Date**: 2026-06-19

Derived from [spec.md](./spec.md) + [research.md](./research.md). Covers the new/changed entities, fields, config migration, and lifecycle. Existing entities (`CandidateSlot`, `Activity`, `SubCall`, `Settings`) are referenced, not redefined.

**No SQLite migration in this feature.** Sequential mode adds no persisted column — the activity row already records candidate count, survivor count, and per-candidate latency/status, which is sufficient. The only persisted change is a `config.json` v4→v5 field addition. The status surface is in-memory only.

---

## Entities

### 1. `ExecutionMode` (NEW — config enum)

Controls how candidate fan-out is scheduled for a fusion.

```ts
type ExecutionMode = "parallel" | "sequential";
```

- **Storage**: `config.settings.executionMode` (plaintext `config.json`, NOT secrets).
- **Default**: `"parallel"` (migration v4→v5 injects if absent; Zod schema also defaults it — belt-and-suspenders, R-007).
- **Scope**: read by `runFusion` at fan-out time; applies to **both** entry paths (blocking MCP tool + detached task path) because both build `FusionInput.config` from the same `loadConfig()`.
- **Orthogonality**: independent of `benchmarkMode` (FR-016). All four on/off combinations are valid.

| Value | Fan-out behavior |
|---|---|
| `parallel` (default) | `Promise.all` over enabled candidates — today's behavior, byte-for-byte unchanged (FR-002). |
| `sequential` | `for…of` over enabled candidates in slot order; candidate k+1 does not start until k resolves; serial budget gates launching (R-002). |

**Validation**: `z.enum(["parallel", "sequential"])`. Any other value fails config parse (Zod), so a corrupt file surfaces at load, not at fusion time.

---

### 2. `SerialBudget` (NEW — derived per-fusion value, not persisted)

The outer wall-clock constraint on a sequential run. Computed fresh for each fusion from the enabled-candidate count.

```ts
// In src/fusion/fanout.ts (module-level constants, R-003):
const PER_CANDIDATE_MS = 180_000;   // 3 min — conservative local-model response assumption
const JUDGE_STEPS_MS  = 360_000;    // 6 min — 3 min analysis + 3 min synthesis

function computeSerialBudgetMs(enabledCandidateCount: number): number {
  return PER_CANDIDATE_MS * enabledCandidateCount + JUDGE_STEPS_MS;
}
```

- **Computed only in sequential mode** (parallel mode ignores it entirely — FR-002/FR-007).
- **Semantics (R-002)**: gates *launching the next candidate*, not finishing the current one. Before each `await runWorker(...)` in the serial loop: `if (Date.now() - startedAt > serialBudgetMs) break;`. The in-flight candidate runs to its own per-worker timeout/retry resolution.
- **Not user-tunable in v1** (R-003). Surfaced to the user as helper text near the toggle (`computeSerialBudgetMs(enabledCount)` formatted as "~Xm"), so the ceiling is visible.
- **Interaction with `workerTimeoutMs`**: independent. `workerTimeoutMs` is the per-call failure ceiling (unchanged, applies to every candidate in both modes). `serialBudgetMs` is the run-level wall-clock ceiling (sequential only).

**Example**: 4 enabled candidates → `180_000 × 4 + 360_000 = 1_080_000 ms = 18 min`. Helper text: "~18 min total (4 candidates × 3 min + 6 min judging)".

---

### 3. `FusionRuntimeStatus` (NEW — ephemeral in-memory state, NOT persisted)

The live state of the fusion engine at the current moment, exposed via `GET /api/runtime`. Backed by a process-singleton `FusionStatusRegistry` (`src/fusion/status.ts`).

```ts
type RuntimeState = "idle" | "in-progress" | "queued";

interface FusionRuntimeStatus {
  state: RuntimeState;
  /** Present (possibly empty) only when state ≠ "idle". One entry per entered fusion. */
  fusions?: ActiveFusion[];
}

interface ActiveFusion {
  activityId: string;
  mode: ExecutionMode;            // parallel | sequential — drives the affordance shape
  candidateCount: number;         // total enabled candidates in this fusion
  /** serial only: which candidate is currently running (1-indexed); parallel: omitted. */
  candidateIndex?: number;
  /** serial only: how many candidates have resolved; parallel: how many are responding. */
  candidatesDone?: number;
  startedAt: number;              // epoch ms — entered the registry
}
```

- **Lifecycle**:
  - `enter(activityId, mode, candidateCount)` — called at the top of `runFusion`, after the config gate, before fan-out.
  - `update(activityId, patch)` — called per-candidate in serial mode (the loop knows the index); in parallel mode, a single update at fan-out start suffices.
  - `leave(activityId)` — called in a `finally` around the whole `runFusion` body, so **every** terminal path (success / partial / error / unexpected throw) clears the entry. **Critical invariant INV-3**: a fusion that entered must leave, or the surface sticks at "in-progress" forever.
- **"Queued" derivation (R-005)**: `state === "queued"` iff `fusions.length > 1`. There is no queue data structure — concurrent fusions coexist on the event loop today; the surface observes them, it does not serialize them.
- **Loss on restart**: acceptable. Status describes the present moment; on restart there is no in-flight fusion to describe (any that crashed is dead). The activity log is the durable record.
- **Never exposes content**: no prompts, no candidate text, no keys — only counts, indices, and ids (R-004). The activity id is already non-sensitive (it's a UUID shown elsewhere in the dashboard).

---

## Config migration (v4 → v5)

Additive, non-breaking. Mirrors how 006 added `personaPolicy` (3→4).

**Schema change** (`src/config/schema.ts`):

```ts
export const CONFIG_VERSION = 5 as const;   // was 4

export const ExecutionModeSchema = z.enum(["parallel", "sequential"]).default("parallel");

export const SettingsSchema = z.object({
  workerTimeoutMs: ...,   // unchanged
  uiPort: ...,            // unchanged
  bind: ...,              // unchanged
  benchmarkMode: ...,     // unchanged
  activePersona: ...,     // unchanged
  personaPolicy: ...,     // unchanged (006)
  executionMode: ExecutionModeSchema,   // NEW
}).default({ /* ...existing defaults..., executionMode: "parallel" */ });
```

**Migration** (`src/config/store.ts`):

```ts
// On load, if config.version < 5 (or executionMode absent):
//   settings.executionMode ??= "parallel";
//   config.version = 5;
//   persist (so subsequent loads skip the migration).
```

The Zod `.default("parallel")` means an absent field parses correctly even without the migration; the migration exists for the explicit version trail + to write the field so the file is self-describing (consistent with 006's approach to `personaPolicy`).

---

## Invariants (cross-cutting, enforced at the implementation site)

- **INV-1 (single fan-out site)**: both entry paths reach the same dispatch in `runFusion`. The blocking tool and the detached task path must not implement serial separately. → enforced by extracting `runParallelFanout` / `runSequentialFanout` into `fanout.ts` and calling one or the other from `runFusion`.
- **INV-2 (survivor gate is mode-agnostic)**: the `workerResults.filter(ok && content)` + `survivorCount < 2` check (`fusion.ts:217`) is untouched. Serial mode produces a `WorkerResult[]` of the same shape; the gate doesn't know or care about mode.
- **INV-3 (registry enter ⇒ leave)**: `leave` runs in a `finally` wrapping the entire `runFusion` body. A stuck "in-progress" is the one bug that would make the surface worse than useless; the `finally` is non-negotiable.
- **INV-4 (parallel is unchanged)**: when `executionMode === "parallel"`, the dispatch calls the extracted `runParallelFanout` which is the *exact* current `Promise.all` — no behavioral drift, verified by a test that asserts identical output for the same faux-provider inputs in both modes.
- **INV-5 (per-worker timeout/retry unchanged)**: `runWorker` + `withRetryTimeout` are not modified. Serial mode calls them identically; only the *scheduling* around them changes.
