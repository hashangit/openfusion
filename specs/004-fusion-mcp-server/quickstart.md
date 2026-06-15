# Quickstart: Fusion MCP Server

**Phase 1 output.** A runnable validation guide — proves the feature works end-to-end. Implementation code lives in `tasks.md` / the implementation phase, not here. References contracts and the data model rather than duplicating them.

---

## Prerequisites

- **Node.js 20 LTS+** and **pnpm** (per `AGENTS.md` conventions — not npm).
- **Valid API keys** for at least two providers you want to fuse (e.g. an OpenAI key and an Anthropic key). OpenFusion never obtains keys for you.
- An **MCP-capable client** to call the `fusion` tool: Claude Desktop, Cursor, Cline, Zed, or Claude Code.
- Ports: nothing else listening on `127.0.0.1:9077`.

---

## Setup (build + configure)

1. **Install & build**
   ```bash
   pnpm install
   pnpm build          # tsc -> dist/ ; cd ui && pnpm build -> ui-dist/
   ```
   Verify: `dist/index.js` and `ui-dist/index.html` exist.

2. **Run the server standalone** (for first-time config before wiring an MCP client):
   ```bash
   node dist/index.js
   # stderr: "OpenFusion UI on http://localhost:9077"
   ```
   This boots both the stdio MCP server and the Express dashboard on `:9077`.

3. **Configure via the dashboard** (satisfies FR-010…014, Constitution VI):
   - Open `http://localhost:9077`.
   - Add **2–5 candidates** (provider + model each, chosen from the dropdowns populated by `/api/providers` + `/api/providers/:p/models`).
   - Set the **judge** provider + model.
   - Enter the **API key** for each referenced provider; click **Test** to validate each (FR-013; `POST /api/test`).
   - Save. Verify `GET /api/config` returns `"configured": true` and `isConfigured()` passes ([`config-schema.md`](./contracts/config-schema.md)).

4. **Wire into an MCP client** — add to the client's config (shape per [`mcp-fusion-tool.md`](./contracts/mcp-fusion-tool.md)):
   ```json
   { "mcpServers": { "openfusion": { "command": "node", "args": ["/abs/path/to/OpenFusion/dist/index.js"] } } }
   ```
   (For distribution: `"command": "npx", "args": ["-y", "openfusion-mcp"]`.)

---

## Validation scenarios

Each maps to a User Story + Success Criterion from [`spec.md`](./spec.md). Run in order.

### V1 — First-run gate (US2 / SC-001, FR-011)
1. Delete (or temporarily rename) `~/.openfusion/config.json`.
2. From the MCP client, call the `fusion` tool with any prompt.
3. **Expected**: tool returns `isError: true` with a message pointing to `http://localhost:9077` (and the browser opens if a display is present). No activity is logged.
4. **Pass when**: the message appears; `GET /api/activity` is still empty.

### V2 — Successful fusion (US1 / SC-002, FR-001…007)
1. With configuration complete (V1 restored), call `fusion` with a multi-perspective prompt:
   ```
   { "prompt": "Compare the trade-offs of server-side vs client-side session storage for a web app." }
   ```
2. **Expected** (best-effort progress notifications if the client forwards them): "Fanning out to N models…" → "K of N candidates responded; analyzing…" → "Analysis complete; synthesizing…" → "Done"; then a single consolidated text answer.
3. **Pass when** (SC-002): the returned answer reflects synthesis across candidates, not a verbatim copy of any one candidate (compare against the per-candidate outputs recorded in the dashboard).

### V3 — Partial survival (US1 / SC-003, FR-006/007, edge case "a candidate hangs")
1. Set `settings.workerTimeoutMs` low (e.g. `5000`) and include one slow/flaky provider as a candidate.
2. Call `fusion`.
3. **Expected**: the fusion still returns a consolidated answer as long as ≥2 candidates succeeded; the slow candidate appears as `status=timeout` in its sub_call.
4. **Pass when**: `/api/activity/:id` shows `survivorCount < candidateCount` and `status="partial"`, yet a valid answer was returned.

### V4 — Too-few-survivors error (edge case "<2 survivors")
1. Configure candidates such that ≥N−1 of them fail (e.g. bogus models won't save — instead, use a very low `workerTimeoutMs` against deliberately slow models, or revoke a key for 2 of 3 providers).
2. Call `fusion`.
3. **Expected**: `isError: true`, message names how many succeeded and which failed; the activity is logged with `status="error"` and the failed sub_calls recorded.
4. **Pass when**: no consolidated answer is returned, and the dashboard shows the failed activity with its failed sub_calls.

### V5 — Observability (US3 / SC-004, FR-030…033)
1. After running V2–V4 a few times, open the dashboard.
2. **Expected**: KPIs match the runs (fusion count, total cost/tokens, avg latency, success rate); charts show cost-by-model and fusions-by-day; the activity list expands each row to its per-candidate + per-judge sub_calls.
3. **Pass when**: every KPI matches a manual recount from `GET /api/activity` responses, and each activity's `subCalls` array has exactly `candidateCount + 2` entries.

### V6 — Secrets hygiene (SC-006, FR-020/021/022, Constitution IV)
1. `grep` the on-disk files and any logs for a known key prefix (e.g. `sk-`).
2. `curl http://localhost:9077/api/secrets`.
3. **Expected**: `secrets.enc` is binary (not plaintext JSON); no key appears in logs or in the config file; `/api/secrets` returns masked hints only (e.g. `sk-…aB1c`), never the raw key.
4. **Pass when**: the raw key appears **nowhere** except inside `secrets.enc` (encrypted) and the provider's own request (transient).

### V7 — Skill guidance (US4 / SC-007, FR-040)
1. Load `skill/SKILL.md` into an MCP client agent that supports skills.
2. **Expected**: the agent has explicit when-to-use / when-not-to-use criteria and knows to supply prompt+context itself.
3. **Pass when**: presented with a routine task, the agent does **not** call `fusion`; presented with a complex multi-perspective task, it does — and supplies relevant context.

---

## Automated tests (deterministic, no real API calls)

Run the full suite:
```bash
pnpm test            # vitest
```
Key suites (all use pi-ai `registerFauxProvider()` — see [`research.md` D11](./research.md)):
- `tests/fusion.test.ts` — end-to-end fusion flow with scripted candidates + judge (covers V2, V3, V4 logic).
- `tests/judge.test.ts` — two-step analysis + synthesis; analysis must come from the `record_analysis` tool call.
- `tests/completeness.test.ts` — `isConfigured()` across config/key combinations.
- `tests/crypto.test.ts` — AES-256-GCM round-trip + mask().
- `tests/activity.test.ts` — SQLite logging + the aggregation queries from [`data-model.md`](./data-model.md).
- `tests/mcp-server.test.ts` — tool handler, progress notification emission, config gate (mocked `extra`).

**Pass when**: all suites green; the fusion tests prove the survival threshold, two-step judging, and correct `sub_calls` row counts without touching a real provider.

---

## Sanity ceiling check (performance / SC-005)

- Run V2 with 3 fast candidates + a fast judge. Measure wall-clock.
- **Expected**: well under common client tool-call ceilings (the ~4-min Claude Desktop ceiling noted in `research.md` D5); typical single-digit seconds to low tens of seconds.
- **Pass when**: no client-side spurious timeout on a routine fusion.
