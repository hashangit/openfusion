# OpenFusion Architecture

A local MCP server that implements OpenRouter's "Fusion" panel architecture: fan a prompt out to N candidate models (single-shot, no tools), run a two-step judge (analysis → synthesis) using the same provider/model, and return the consolidated answer. Ships with a glass-morphic React dashboard on `localhost:9077` for configuration and usage statistics.

## Locked Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Worker behavior | **Single-shot**, no tools | OpenFusion is a fusion engine, not an agent. The caller supplies `prompt` + optional `context`. Captures most of the multi-perspective lift for a fraction of the cost/latency. |
| Judge design | **Two-step, same provider/model** | Step 1 extracts structured analysis; step 2 synthesizes from candidates + analysis only. OpenRouter's data: ~3/4 of the performance lift comes from synthesis, not model diversity. |
| Key storage | **Encrypted local file** | AES-256-GCM, machine-bound `master.key`, `chmod 600`. No native keychain deps; sufficient for a local single-user tool. |
| Persistence | **SQLite** via `better-sqlite3` | Enables rich aggregations (cost/tokens by model over time; activity as a dimension). Ships prebuilt binaries for common platforms. |
| Provider layer | **`@earendil-works/pi-ai`** | Unified multi-provider API, auto-generated typed model registry, per-request token/cost usage. Note: `@mariozechner/pi-ai` is **deprecated** — do not use it. |

## High-Level Architecture

```
┌───────────────────── npx openfusion-mcp (one process) ─────────────────────┐
│                                                                             │
│   McpServer (stdio)               Express on 127.0.0.1:9077                 │
│   ├ tool: fusion  ───── reads ───►│◄── writes ──►  /api/config              │
│   ├ tool: open_dashboard          │               /api/secrets (masked)     │
│   └ emits notifications/progress  │               /api/providers, /models   │
│              │                     │               /api/test (ping)         │
│              │      shared in-mem  │               /api/stats               │
│              ▼      ◄────────────►│               /api/activity            │
│   Fusion engine                   └── serves built React UI (ui-dist)       │
│   (fan-out → 2-step judge)                                                  │
│              │                                                              │
│   @earendil-works/pi-ai  (getModel + complete, apiKey injected per call)    │
│              │                                                              │
│   SQLite (~/.openfusion/openfusion.db)    secrets.enc + master.key on disk  │
└─────────────────────────────────────────────────────────────────────────────┘
        stdin/stdout JSON-RPC                       http://localhost:9077
              │                                            │
   Claude Desktop / Cursor /                       User's browser
   Cline / Zed / Claude Code                       (config + dashboard)
```

- **stdio for the MCP leg** + a **separate Express server on `:9077`** in the same process. stdio only claims stdin/stdout; the HTTP port is free. No streamable-http needed.
- **Caveat:** under stdio the *client* owns the process lifecycle, so the UI lives only while a client is connected. A standalone **`openfusion-ui`** bin starts the dashboard independently; both processes share the same on-disk SQLite + config + secrets.

## Source Layout

```
openfusion/
├── package.json            # bin: openfusion-mcp, openfusion-ui; type: module
├── tsconfig.json
├── src/
│   ├── index.ts            # shebang; MCP entry (stdio) + boots UI server
│   ├── server/
│   │   ├── mcp-server.ts   # McpServer; registers fusion + open_dashboard tools
│   │   ├── ui-server.ts    # Express on :9077; static UI + REST API
│   │   └── api/            # route handlers (config, secrets, providers, test, stats, activity)
│   ├── fusion/
│   │   ├── fusion.ts       # orchestrate: fan-out → judge step 1 → judge step 2
│   │   ├── worker.ts       # single-shot candidate call via pi-ai
│   │   ├── judge.ts        # 2-step judge (analysis tool-call, then synthesis)
│   │   └── prompts.ts      # worker + analysis + synthesis system prompts
│   ├── config/
│   │   ├── schema.ts       # zod schemas: candidates, judge, settings
│   │   ├── store.ts        # read/write config.json + secrets.enc
│   │   ├── crypto.ts       # AES-256-GCM, machine-bound master.key
│   │   └── completeness.ts # isConfigured(): ≥2 candidates, judge set, all keys present
│   ├── providers/
│   │   └── pi-ai-bridge.ts # getModel() + complete() wrapper; injects apiKey per call
│   ├── store/
│   │   ├── db.ts           # better-sqlite3 init + migrations (WAL mode)
│   │   ├── activity.ts     # one activity row per fusion + N+2 sub-call rows
│   │   └── stats.ts        # aggregation queries for the dashboard
│   └── util/
│       ├── paths.ts        # env-paths wrapper (~/.openfusion)
│       └── timeout.ts      # per-worker timeout race (Promise.allSettled)
├── ui/                     # React (Vite) — its own package.json
│   ├── index.html
│   └── src/{main,App}.tsx, pages/{Setup,Candidates,Judge,ApiKeys,Dashboard}.tsx, components/
├── ui-dist/                # built UI, gitignored, served by Express
├── skill/SKILL.md          # the OpenFusion usage skill (frontmatter + body)
└── tests/                  # vitest; uses pi-ai registerFauxProvider()
```

## The `fusion` Tool

**Input schema (zod):** `{ prompt: string, context?: string }` — `context` is optional gathered tool results/background the client wants included. OpenFusion is a pure fusion engine, not an agent; workers never call tools.

1. **Config gate:** `isConfigured()` check. If incomplete → return `{ isError: true, content: [...] }` telling the user to configure at `http://localhost:9077`, and call `open("http://localhost:9077")` when a display is present (guard headless: just return the URL).
2. Load config (candidates 2–5 + judge) and provider keys.
3. Resolve pi-ai models via `getModel(provider, modelId)` for each candidate and the judge.
4. **Fan out:** `Promise.allSettled` of single-shot `complete(model, { systemPrompt: WORKER_PROMPT, messages:[{role:'user', content: prompt + context}] }, { apiKey })`. Each wrapped in a per-worker timeout (default 120s, configurable). Emit progress: "Fanning out to N models…".
5. Collect survivors. If `< 2` survive → return error (need ≥2 valid candidates). Progress: "K of N candidates responded; analyzing…".
6. **Judge step 1 — analysis** (same judge provider/model): system prompt instructs the judge to *not* answer the prompt, only extract structured analysis. Implemented as a pi-ai **tool call** (`record_analysis` with a TypeBox schema: `{ consensus[], contradictions[], partialCoverage[], uniqueInsights[], blindSpots[] }`). Progress: "Analysis complete; synthesizing…".
7. **Judge step 2 — synthesis** (same judge provider/model): system prompt instructs the synthesizer to write the final answer using *only* the candidates + analysis, introducing no new external info. Output = final answer text. Progress: "Done".
8. **Log activity** to SQLite (see Persistence).
9. Return `{ content: [{ type: "text", text: finalAnswer }] }`.

Progress emitted via `extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, total, message } })`. No-op if the client didn't send a token (best-effort).

## Configuration System

**Two files in `~/.openfusion/` (via `env-paths`):**

- **`config.json`** (plaintext, no secrets): `{ version, candidates: [{id, provider, model}], judge: {provider, model}, settings: { workerTimeoutMs, uiPort, bind } }`.
- **`secrets.enc`** (AES-256-GCM encrypted): `{ providers: { openai: {apiKey}, anthropic: {apiKey}, ... } }` — **one key per provider**, shared across all candidate slots + judge that use it (e.g. one OPENAI key, not one per slot).
- **`master.key`** — random 256-bit key generated on first run, `chmod 600`. Machine-bound; used to encrypt/decrypt `secrets.enc`. (Simpler + sufficient for a local single-user tool; avoids native keychain deps.)

`isConfigured()` = `candidates.length ≥ 2 && judge set && every referenced provider has a key`. Minimum **2**, maximum **5** candidates (enforced in schema + UI).

## Provider Layer (`@earendil-works/pi-ai`)

- **`getProviders()`** / **`getModels(provider)`** — power the model dropdowns in the config UI for free (auto-generated typed registry).
- **`getModel(provider, modelId)`** + **`complete(model, context, options)`** — the worker + judge call path.
- **`options.apiKey`** — pi-ai reads keys from env or a per-call `apiKey`; we inject the decrypted key per call. pi-ai stores nothing.
- **`AssistantMessage.usage`** — per-request `{ input, output, cost }`; this feeds the `sub_calls` rows. (Best-effort per pi-ai docs; aborted requests may lose accurate counts.)
- **`registerFauxProvider()`** — in-memory scripted provider for deterministic tests.
- **No streaming of final answer over MCP** — MCP has no partial-result streaming primitive; return the full result at the end. Progress notifications cover live status.

## Persistence (SQLite)

**`~/.openfusion/openfusion.db`** via `better-sqlite3`, WAL mode.

- **`activities`** — one row per fusion: `id, timestamp, prompt_excerpt, candidate_count, judge_provider, judge_model, total_input_tokens, total_output_tokens, total_cost, total_latency_ms, status`.
- **`sub_calls`** — N+2 rows per fusion (one per candidate + 2 judge steps): `id, activity_id (FK), role (worker|judge_analysis|judge_synthesis), provider, model, input_tokens, output_tokens, cost, latency_ms, status, error`.

This is the "activity as a dimension" for the dashboard: `stats.ts` aggregates by `model`, `provider`, `day`, `status` over both tables. SQLite enables these queries server-side rather than loading raw logs into the browser.

## UI Server + REST API (Express, same process)

All on `127.0.0.1` only (holds keys — never expose externally). No CORS (same-origin).

| Method | Path | Purpose |
|--------|------|---------|
| GET / PUT | `/api/config` | Read/write `config.json` (model choices + settings) |
| GET | `/api/secrets` | Masked key **presence** per provider (never the raw key) |
| PUT | `/api/secrets` | Set a provider's key (encrypted before write) |
| GET | `/api/providers` | pi-ai `getProviders()` |
| GET | `/api/providers/:p/models` | pi-ai `getModels(p)` |
| POST | `/api/test` | Tiny pi-ai ping to validate a provider+model+key before save |
| GET | `/api/stats` | Aggregated dashboard data (KPIs + by-model/by-day) |
| GET | `/api/activity` | Paginated activity log, expandable to sub-calls |

Static: serves the built React UI from `ui-dist/`.

## React Dashboard (glass-morphic)

React + Vite + Tailwind + recharts. OpenFusion branding, translucent cards, `backdrop-blur`, subtle gradient background.

- **Pages:** Setup wizard (first run) · Candidates (provider+model per slot, add/remove 2–5) · Judge (provider+model) · API Keys (provider keys, masked, with "test" pings) · Dashboard.
- **Dashboard:** KPI cards (total fusions, total cost, total tokens, avg latency, success rate); activity table (expandable row → per-sub-call breakdown = activity-as-dimension); charts — cost/tokens over time, cost by model (bar), fusions by model; filters by date range / model / status.

## `skill/SKILL.md`

A skill the user can drop into any MCP-client agent that supports skills. Covers:

- **What it is:** a fusion-panel MCP server.
- **WHEN to use:** complex reasoning needing multiple perspectives, deep research, cross-model verification, high-stakes answers where consensus adds value.
- **WHEN NOT to use:** routine coding, simple lookups, single-turn Q&A, trivial tasks a base model handles directly. Fusion is 2–3× slower and costlier — not a drop-in for everyday calls.
- **Constraints:** min 2 / max 5 candidates; OpenFusion does *not* do agentic work or tool calls — provide `prompt` + any `context`/tool results yourself.
- **Setup reminder:** configure candidates + judge + keys at `http://localhost:9077` first.

## Build & Distribution

- `package.json` `bin`: `openfusion-mcp` (stdio server, also serves UI) and `openfusion-ui` (standalone always-on dashboard).
- Shebang `#!/usr/bin/env node` on entries. `npx openfusion-mcp` runnable.
- Build: `pnpm build` → `tsc` to `dist/` + `cd ui && pnpm build` to `ui-dist/`. Ship both via npm `files`.
- Install snippet users add to their client config (Claude Desktop / Cursor / Cline / Zed / Claude Code):

```json
{ "mcpServers": { "openfusion": { "command": "npx", "args": ["-y", "openfusion-mcp"] } } }
```

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Client tool-call timeout (~4 min on Claude Desktop) | Parallel fan-out (wall-clock ≈ slowest worker + 2 judge calls); per-worker timeout; proceed with survivors. |
| pi-ai is pre-1.0 | Pin exact version (`save-exact`); surface a clear error if `getModel` rejects an unknown provider/model. |
| Secrets exposure | Keys only in `secrets.enc` (AES-256-GCM); never logged; secrets API returns masked presence; dashboard binds `127.0.0.1`. |
| better-sqlite3 native dep | Ships prebuilt binaries for common platforms; document build-from-source fallback. |
| Progress notifications not forwarded | Best-effort only; correctness never depends on them. |
