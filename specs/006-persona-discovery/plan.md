# Implementation Plan: Persona Discovery & Policy (MCP)

**Branch**: `006-persona-discovery` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-persona-discovery/spec.md`

## Summary

Make OpenFusion's persona system discoverable and controllable by MCP clients. Three changes:

1. **Discovery** — a new read-only `list_personas` MCP tool returns lightweight persona descriptors (`{id, name, description, builtin, active}` — never the raw prompts). Agents use a 2-call pattern: `list_personas` → `fusion(persona=<id>)`. Removes the persona name list from the `fusion` tool description, replacing it with a one-sentence discovery nudge (smaller system prompt, always accurate).

2. **Policy** — a `personaPolicy` config enum (`strict | allow-override`, default `allow-override`) gates whether MCP clients may override the active persona. Strict mode is **warn-and-continue, never block**: the active persona runs, `persona_source="strict-enforced"`, a warning notification fires, and if the client supports `elicitation.form`, the user is asked once per session to relax (concurrency-guarded shared promise). Invalid ids always fall back to active with `persona_source="invalid-fallback"`.

3. **Audit** — a new nullable `activities.persona_source` column makes the resolution provenance verifiable in the dashboard's Generations tab (`◈ qa (client override)` etc.).

Policy enforcement lives inside `runFusion` so both the plain `fusion` tool and the task-augmented path from feature 005 share one enforcement site. UI-triggered fusions are exempt (the user is the picker). Full rationale in [`research.md`](./research.md); entities and schema in [`data-model.md`](./data-model.md); tool/notification/elicitation shapes in [`contracts/mcp-persona-tools.md`](./contracts/mcp-persona-tools.md).

## Technical Context

**Language/Version**: TypeScript (ES2022, NodeNext, ESM), Node ≥ 22.19.

**Primary Dependencies**:
- `@modelcontextprotocol/sdk@1.29.0` (exact pin — `getClientCapabilities()` at `server/index.js:285`; `elicitation/create` via `form` params at `server/index.js:366`; feature 005's `experimental.tasks.registerToolTask` already in use).
- `@earendil-works/pi-ai@0.79.4` (exact pin — unchanged).
- `better-sqlite3@12.10.1` (WAL mode — one additive `ALTER TABLE` migration).

**Storage**: SQLite — **one additive migration** (`004_add_persona_source.sql`: `ALTER TABLE activities ADD COLUMN persona_source TEXT`, nullable, no backfill). Plus a `config.json` v3→v4 migration injecting `settings.personaPolicy = "allow-override"` if absent. No schema-breaking changes.

**Testing**: Vitest; pi-ai `registerFauxProvider()` for deterministic fusion tests. New tests T1–T11 in [`quickstart.md`](./quickstart.md). Existing suite (57 tests as of v0.2.1) must stay green.

**Target Platform**: Local Node process (stdio MCP + Express UI on `127.0.0.1:9077`). Same single-process architecture (constitution VII).

**Project Type**: Local MCP server + REST dashboard.

**Performance Goals**:
- `list_personas` responds in sub-millisecond (in-memory config read + JSON serialization).
- The `fusion` tool description shrinks (fewer tokens on every invocation — SC-006).
- At most ONE elicitation per session regardless of concurrency (SC-004).

**Constraints**:
- `personaPolicy` stored in plaintext `config.json` (not `secrets.enc` — not sensitive; constitution IV unaffected).
- Session relax-strict opt-in is in-memory only; never persisted (would silently flip the user's global setting).
- Invalid persona ids never error (preserve the existing `resolvePersona` never-throws contract; this feature makes the fallback visible).

**Scale/Scope**: Single process; one client per stdio session; one `SessionOverrideState` singleton. No new concurrency primitives beyond a shared promise (R-007).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|---|---|---|
| I | Fusion Engine, Not Agent (NON-NEGOTIABLE) | ✅ PASS | `list_personas` is a read-only descriptor lookup — no agentic behavior. The policy check is a gate, not a tool loop. Workers still generate once from the prompt; no tools, no autonomy added. |
| II | Two-Step Judging | ✅ PASS | The persona only selects the *prompts* fed to the existing worker/analysis/synthesis steps. The two-step structure is untouched. |
| III | Resilient by Default | ✅ PASS | Invalid-id fallback preserves the never-throw contract (now visibly audited). Strict mode never blocks — it warns and continues. No new failure modes introduced. |
| IV | Secrets Encrypted at Rest | ✅ PASS | `personaPolicy` is non-sensitive → plaintext `config.json` (alongside `activePersona`, `benchmarkMode`). No secrets touched; `list_personas` output excludes prompt text (which could be considered user-authored IP, not secrets, but excluded by design for token efficiency anyway). Dashboard still `127.0.0.1`. |
| V | Observable | ✅ PASS | The new `persona_source` column *strengthens* observability — every fusion now records not just which persona ran but why. One row + N+2 sub_calls invariant unchanged. |
| VI | Configuration Gated | ✅ PASS | The config gate still runs first. `list_personas` works pre-gate (it's a read of config, not a fusion); `fusion` still refuses when unconfigured. |
| VII | Simple & Local | ✅ PASS | One Node process; one additive migration; one in-memory singleton for session state; one new tool. No worker threads, queues, or infra. The skill uses progressive disclosure (standard pattern), not new server capabilities. |

**Gate result**: PASS — no NON-NEGOTIABLE violations, no Complexity Tracking entries. The design is the minimal addition to make an existing server-side feature (personas) discoverable and controllable from the MCP surface, with the audit dimension that makes the control verifiable.

**Post-design re-check**: After data-model + contracts, still PASS. The `PersonaLite` projection (excluding prompts), the single enforcement site in `runFusion` (INV-2 consistency), and the in-memory-only session state (INV-5 — policy never mutated by opt-in) jointly guarantee no observability regression and no silent global-setting drift. No constitution amendment required.

## Project Structure

### Documentation (this feature)

```text
specs/006-persona-discovery/
├── plan.md                          # This file
├── research.md                      # Phase 0 — R-001..R-011 (capability negotiation, concurrency, storage)
├── data-model.md                    # Phase 1 — PersonaPolicy, PersonaSource, PersonaLite, SessionOverrideState
├── quickstart.md                    # Phase 1 — T1–T11 + E1–E2 validation guide
├── contracts/
│   └── mcp-persona-tools.md         # list_personas contract + fusion description change + notification/elicitation shapes
└── tasks.md                         # Phase 2 (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── fusion/
│   ├── fusion.ts                    # MODIFIED: add source + onPersonaEvent to FusionInput; policy check + persona_source resolution
│   ├── personas.ts                  # MODIFIED: add toLite() projection (Persona → PersonaLite, no prompts)
│   └── persona-policy.ts            # NEW: resolvePersonaWithPolicy() + SessionOverrideState + PersonaEvent types
├── server/
│   ├── mcp-server.ts                # MODIFIED: register list_personas tool; trim fusion description + nudge; wire onPersonaEvent (notification + elicitation)
│   └── ui-server.ts                 # MODIFIED (minimal): UI-triggered fusion path passes source:"ui"
├── config/
│   ├── store.ts                     # MODIFIED: v3→v4 migration inject personaPolicy:"allow-override"
│   └── types.ts (or inline)         # MODIFIED: PersonaPolicy type on settings
└── store/
    ├── activity.ts                  # MODIFIED: ActivityRow + recordActivity/allocateActivity accept persona_source
    └── db.ts                        # MODIFIED: migration 004_add_persona_source.sql registered

migrations/
└── 004_add_persona_source.sql       # NEW: ALTER TABLE activities ADD COLUMN persona_source TEXT

ui/
└── src/
    ├── api.ts                       # MODIFIED: Activity.persona_source field
    ├── pages/Generations.tsx        # MODIFIED: persona chip renders source suffix
    └── pages/Config.tsx             # MODIFIED: personaPolicy toggle + helper text

tests/
├── persona-discovery.test.ts        # NEW: T1, T6 (list_personas shape, invalid fallback)
├── persona-policy.test.ts           # NEW: T2, T3, T4, T5 (override, strict, elicitation, concurrency)
└── fusion-persona-source.test.ts    # NEW: T7, T8 (UI exemption, persona_source recording)

.zcode/skills/openfusion/
├── SKILL.md                         # MODIFIED (doc): 2-call pattern, link to resources
└── resources/                       # NEW (doc): persona-generalist.md, persona-qa.md, persona-researcher.md, persona-pm.md
```

**Structure Decision**: Single-project layout (existing). The only new source file is `persona-policy.ts` (policy resolution + session state + event types), keeping `fusion.ts` focused on the fan-out/judge pipeline and `mcp-server.ts` on transport. `personas.ts` gains a small `toLite()` projection. Everything else is surgical modification of existing files. The skill changes are documentation only. No new runtime dependencies, no new directories beyond the skill's `resources/`.

## Complexity Tracking

> None. Constitution Check passes with no violations to justify. The feature is the standard, minimal answer to discovery + policy + audit, implemented as one new tool, one config enum, one nullable column, one in-memory singleton, and one callback — each directly traceable to a user decision from the dialogue.
