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
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/004-fusion-mcp-server/plan.md
<!-- SPECKIT END -->
