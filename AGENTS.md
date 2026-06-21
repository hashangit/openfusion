# Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

# Architecture

Full architectural reference: `ARCHITECTURE.md` in the project root.

## Layers

```
Adapters (stdio MCP tool + Express UI on :9077)
  → Core (fusion engine: fan-out + two-step judge)
    → Provider layer (@earendil-works/pi-ai)
      → Persistence (SQLite + AES-256-GCM encrypted secrets)
```

One Node process. The MCP server speaks JSON-RPC over stdio; the Express server serves the React dashboard + REST API on `127.0.0.1:9077`. Both share the same in-memory config/activity state, backed by on-disk SQLite + encrypted secrets.

## Key Files

| Concern | File | Notes |
|---------|------|-------|
| MCP entry | `src/index.ts` | Shebang; boots McpServer (stdio) + UI server |
| MCP server | `src/server/mcp-server.ts` | Registers `fusion` + `open_dashboard` tools, progress notifications |
| UI server | `src/server/ui-server.ts` | Express on :9077, static UI + REST API |
| Fusion engine | `src/fusion/fusion.ts` | Orchestrate fan-out → judge step 1 → judge step 2 |
| Worker | `src/fusion/worker.ts` | Single-shot candidate call via pi-ai |
| Judge | `src/fusion/judge.ts` | 2-step: analysis tool-call, then synthesis |
| Provider bridge | `src/providers/pi-ai-bridge.ts` | `getModel` + `complete`, injects `apiKey` per call |
| Config store | `src/config/store.ts` | Read/write `config.json` + `secrets.enc` |
| Crypto | `src/config/crypto.ts` | AES-256-GCM, machine-bound `master.key` |
| DB | `src/store/db.ts` | better-sqlite3, WAL mode, migrations |
| Activity log | `src/store/activity.ts` | One `activities` row + N+2 `sub_calls` rows per fusion |
| Stats | `src/store/stats.ts` | Aggregation queries (activity as a dimension) |

## The `fusion` Tool

Single-shot fan-out → two-step judge. NOT an agent: workers get no tools; the caller supplies `prompt` + optional `context`. Flow:

1. **Config gate** — refuse until ≥2 candidates + judge + all referenced provider keys configured.
2. **Fan out** — `Promise.allSettled`, per-worker timeout (default 120s).
3. **Survive** — proceed if ≥2 candidates succeed; otherwise error.
4. **Judge step 1** — structured analysis (consensus / contradictions / partial coverage / unique insights / blind spots) via a pi-ai tool call.
5. **Judge step 2** — synthesis from candidates + analysis only (no new external info).
6. **Log** — `activities` + `sub_calls` rows.
7. **Return** — final answer text.

Both judge steps use the **same** provider/model combo.

**Task-capable (MCP Tasks / SEP-1686).** Registered via `server.experimental.tasks.registerToolTask` with `taskSupport: 'optional'`. On a Tasks-aware client the `tools/call` returns a `CreateTaskResult` immediately and the fusion runs detached in the same process (`src/fusion/task-runner.ts`); the client fetches the result via `tasks/get` + `tasks/result`. On a non-Tasks client the SDK auto-polls and returns the final `CallToolResult` (blocking, unchanged from pre-task behavior). Fusion semantics are identical on both paths — only *when* `tools/call` returns differs. Design and wiring details in `specs/005-mcp-tasks-sep/`.

**Persona discovery + policy (feature 006).** Two additional MCP tools + a config-gated override path:
- `list_personas` — read-only discovery; returns `[{id, name, description, builtin, active}]` (no prompt text). Never gated by policy.
- `fusion`'s optional `persona` arg — agents discover via `list_personas`, then pass `persona:<id>`. Resolution is audited on `activities.persona_source` (`active` | `override` | `strict-enforced` | `invalid-fallback`).
- `config.settings.personaPolicy` (`strict` | `allow-override`, default `allow-override`) — gates MCP-client overrides only (UI fusions exempt via `FusionInput.source:"ui"`). Strict = warn + continue (never block): the active persona runs, a `notifications/message` warning fires, and if the client advertises `elicitation.form` the user is asked once per session to relax (`SessionOverrideState` dedupes concurrent callers). Invalid ids never error — they fall back to active with `persona_source="invalid-fallback"`. Enforcement lives in `runFusion` (single site, both entry paths). Details in `specs/006-persona-discovery/`.

**Sequential fan-out (feature 007).** `config.settings.executionMode` (`parallel` default | `sequential`) governs candidate scheduling. Parallel is the unchanged `Promise.all` fan-out (optimal for cloud). Sequential runs candidates **one at a time** in slot order — an opt-in for low-VRAM local setups (Ollama/llama.cpp) where simultaneous model loads OOM. A serial time budget (`computeSerialBudgetMs = 3min × N + 6min`, `src/fusion/fanout.ts`) gates *launching* the next candidate (never aborts the in-flight one — no `AbortController`); on exhaustion the run proceeds with survivors so far (same ≥2 gate). The per-worker timeout + 3-retry machinery is identical in both modes. Dispatch lives in `runFusion` (single site, both entry paths). A live status surface (`GET /api/runtime` — distinct from `/api/status`; `src/fusion/status.ts` registry, `enter`/`update`/`finally leave` in `runFusion`) feeds a Dashboard widget. Details in `specs/007-sequential-processing/`.
**Known limitations (v1, documented):**
- **Tasks are non-durable.** `InMemoryTaskStore` + a module-level `Map<taskId, activityId>` live in-process; a restart loses in-flight tasks. The SQLite `activities` row is the durable record (may be left at `status='running'` on crash). Task IDs are ephemeral — clients must not persist them across sessions.
- **Event-loop blocking under concurrent load.** `better-sqlite3` is synchronous; a long fusion can delay a second client's calls and the Express dashboard. Tolerable for a single-user local tool (Constitution VII); revisit if multi-user.
- **No cancellation wiring.** SEP-1686 `tasks/cancel` is not implemented; `runFusion` has no `AbortController`, so a cancelled fusion runs to completion. Scoped as a possible v1.1 addition.
- **Sequential mode ≠ local-server VRAM management.** `executionMode:"sequential"` removes OpenFusion's *own* candidate concurrency; it does not manage the local model server's VRAM (Ollama `keep_alive`, llama.cpp offloading). A user can still OOM if their local server keeps models resident. Documented, not engineered.

## Conventions

- **pnpm, not npm** — use pnpm for all dependency installs.
- **TypeScript → ES2022, NodeNext modules** — plain `tsc` to `dist/`, no bundler. Dev via `tsx`.
- **stderr for logs** — `stdout` is the MCP JSON-RPC channel under stdio transport; any stray `console.log` corrupts the protocol. Use `console.error`.
- **One Node process** — stdio MCP transport + Express UI server coexist; stdio only owns stdin/stdout, the HTTP port is free.
- **Keys never leave `secrets.enc` unmasked** — never log secrets, never return them unmasked from any API.
- **Dashboard binds `127.0.0.1` only** — never `0.0.0.0`.
- **Vitest** for tests; use pi-ai `registerFauxProvider()` for deterministic fusion tests.
- **Errors carry `code` + `retryable`** — machine-readable throughout.
- **Pin `@earendil-works/pi-ai` exactly** — it's pre-1.0; `save-exact`. Do NOT use the deprecated `@mariozechner/pi-ai`.

<!-- SPECKIT START -->
Active feature: **008-async-fusion-results** (Async Fusion Results via Deferred Retrieval).
Stage: planned (Phase 0 + 1 complete); ready for `/speckit-tasks`.

Working documents (read in order before implementing):
- Current plan: specs/008-async-fusion-results/plan.md (tech context, constitution gate ✅ no violations, project structure)
- Spec: specs/008-async-fusion-results/spec.md (3 user stories US1–US3, FR-001..015, SC-001..007)
- Design depth: specs/008-async-fusion-results/research.md (R-001..R-009; R-001 is an EMPIRICAL GATE — verify before locking long-poll timing),
  data-model.md (fusion_jobs table + status state machine; reference_id = activity_id; live progress ephemeral),
  contracts/resume-from.md (fusion tool _resume_from wire protocol + mode-aware kickoff/retrieval shapes),
  quickstart.md (T1–T14 + E1 — E1 re-scopes spec 005's never-run test to the _resume_from path)
- Checklist: specs/008-async-fusion-results/checklists/requirements.md (all pass)

Key decisions: deferred-result protocol for non-Tasks clients (codex/ZCode) — feature 005's Tasks path
provably cannot help them (codex hardcodes task:None). `_resume_from` on the fusion tool; kickoff returns
immediately, retrieval bounded-long-polls (~40s parallel) / ETA-guided (sequential). Durable (SQLite) for
BOTH modes, live progress ephemeral for both (revises 005's non-durability for retrieval). reference_id =
activity_id (collapse the three-way map). 005's Tasks path preserved as a sibling branch. R-001 gate
(verify codex timeout is per-call, not session-level) MUST complete before FR-004's wait is locked.
<!-- SPECKIT END -->
