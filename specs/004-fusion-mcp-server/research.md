# Research: Fusion MCP Server

**Phase 0 output.** No NEEDS CLARIFICATION markers existed in Technical Context (all four product-shaping decisions were locked with the user before planning). This document records the locked decisions, the rationale, the alternatives rejected, and the concrete implementation patterns each decision rests on — so Phase 1 design and downstream `tasks.md` have a single authoritative reference.

Sources are cited inline; the bulk derives from three explorations performed during planning (pi-ai, MCP TypeScript SDK, project inventory).

---

## D1. Provider layer: `@earendil-works/pi-ai` (not `@mariozechner/pi-ai`)

**Decision**: Use `@earendil-works/pi-ai` as the unified provider abstraction. Pin exact (`save-exact`) since it's pre-1.0.

**Rationale**: pi-ai already solves the hard parts of multi-provider LLM access — a single `complete()`/`stream()` API across OpenAI, Anthropic, Google, xAI, Mistral, Bedrock, OpenRouter, and any OpenAI-compatible endpoint; an auto-generated, typed model registry (sourced from OpenRouter + models.dev); TypeBox-schema tool-calling; per-request token/cost `usage`; and `registerFauxProvider()` for deterministic tests. Building this ourselves would dwarf the rest of the project. Reusing it keeps OpenFusion focused on fusion orchestration + UX.

**Alternatives rejected**:
- *`@mariozechner/pi-ai`*: **deprecated** on npm — "please use `@earendil-works/pi-ai` instead". Same library, moved scope. Rejected.
- *Vercel AI SDK*: popular but provider-coverage differs and the model registry isn't auto-generated; pi-ai's typed `getModel(provider, modelId)` with auto-complete is a better fit for a config UI with model dropdowns.
- *Direct per-provider SDKs*: would reimplement the abstraction layer for no gain.

**Key API surface used** ([`@earendil-works/pi-ai` README](https://www.npmjs.com/package/@earendil-works/pi-ai), [earendil-works/pi monorepo](https://github.com/earendil-works/pi)):
- `getModel(provider, modelId)` — typed; returns the model descriptor (throws on unknown).
- `complete(model, context, options)` — non-streaming; returns `AssistantMessage` with `.content[]` blocks (`text` | `toolCall`) and `.usage` (`{ input, output, cost }`).
- `getProviders()`, `getModels(provider)` — power the config-UI dropdowns for free; a `Model` carries `id`, `contextWindow`, `cost`, `reasoning`, etc.
- `options.apiKey` — pi-ai reads keys from env or per-call; we inject the decrypted key per call (pi-ai stores nothing).
- `Type`, `StringEnum`, `Tool` — for the judge's forced `record_analysis` tool call.
- `registerFauxProvider()` — scripted in-memory provider for Vitest.

**Caveats honored in the plan**:
- `usage` is best-effort; aborted calls may lose accurate counts (noted in spec assumptions).
- Google does not stream tool calls; we use non-streaming `complete()` for the analysis step so this is moot.
- Pre-1.0 → pin exact; surface a clear error if `getModel` rejects an unknown provider/model at config/test time.

---

## D2. Workers are single-shot, no tools (NON-NEGOTIABLE — Constitution I)

**Decision**: Each candidate makes exactly one `complete()` generation from `prompt` + optional `context`. Workers are never given tools. OpenFusion is a fusion engine, not an agent.

**Rationale (user-confirmed)**: The client supplies `prompt` + any gathered `context`/tool results itself. Single-shot workers capture most of the multi-perspective lift for a fraction of the cost/latency of OpenRouter's original Fusion (whose workers each ran full agent loops with web search/fetch/bash). This keeps wall-clock bounded (critical given the client ~4-min timeout) and avoids OpenFusion duplicating the host agent's job.

**Alternatives rejected**:
- *Workers-with-tools (OpenRouter-original)*: 2–3× slower again, much higher cost/complexity, and blurs the line with the calling agent. Explicitly out of scope per Constitution I.

**Implementation pattern**: `worker.ts` exports `runWorker({ model, prompt, context, apiKey, timeoutMs })` returning `{ content: string, usage, latencyMs, status }`. Wraps `complete()` in a per-call timeout (D5).

---

## D3. Two-step judge, same provider/model (Constitution II)

**Decision**: The judge runs two steps on the **same** provider+model. Step 1 = structured analysis via a forced pi-ai tool call. Step 2 = synthesis text.

**Rationale (user-confirmed)**: OpenRouter's data shows ~3/4 of the performance lift comes from synthesis, not model diversity. Splitting analysis from synthesis — rather than one judge call that both evaluates and writes — produces a measurably better consolidated answer. Using the same model for both steps keeps config simple (one judge choice).

**Alternatives rejected**:
- *One-step judge*: fewer calls/cheaper, but loses the dedicated synthesis boost. Rejected.
- *Two different models for the two judge steps*: marginal theoretical gain, doubles config burden, no evidence it helps. Rejected.

**Implementation pattern** — analysis as a forced tool call (`judge.ts`):

```ts
import { Type, Tool, complete } from "@earendil-works/pi-ai";

const analysisTool: Tool = {
  name: "record_analysis",
  description: "Record your structured analysis of the candidate answers. Do NOT answer the prompt.",
  parameters: Type.Object({
    consensus: Type.Array(Type.String()),
    contradictions: Type.Array(Type.String()),
    partialCoverage: Type.Array(Type.String()),
    uniqueInsights: Type.Array(Type.String()),
    blindSpots: Type.Array(Type.String()),
  }),
};

// step 1
const analysisResp = await complete(judgeModel, {
  systemPrompt: ANALYSIS_PROMPT,      // instructs: analyze only, never answer
  messages: [{ role: "user", content: judgeInput(candidates, prompt) }],
  tools: [analysisTool],
}, { apiKey });
// read analysisResp.content -> find block.type === "toolCall", block.name === "record_analysis", block.arguments

// step 2
const synthResp = await complete(judgeModel, {
  systemPrompt: SYNTHESIS_PROMPT,     // instructs: use ONLY candidates + analysis, no new info
  messages: [{ role: "user", content: synthesisInput(candidates, analysis) }],
}, { apiKey });
// synthResp.content -> text block = final answer
```

The forced-tool-call pattern guarantees structured analysis output and prevents step 1 from drifting into answering (Constitution II).

---

## D4. Secrets: AES-256-GCM encrypted local file (Constitution IV)

**Decision**: One key per provider, stored in `~/.openfusion/secrets.enc` (AES-256-GCM). Encrypted with a machine-bound `~/.openfusion/master.key` (32 random bytes, `chmod 600`). Never logged; the secrets REST endpoint returns masked presence only.

**Rationale (user-confirmed)**: No native keychain dependencies (avoids rebuild-per-arch install friction); sufficient security for a local single-user tool; plain Node `crypto` only.

**Alternatives rejected**:
- *OS keychain (keytar)*: most secure, but a native module → install friction. Rejected.
- *Plaintext + chmod 600*: simplest, least secure. Rejected.

**Implementation pattern** (`config/crypto.ts`, Node built-in `crypto` only):

```ts
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";

// one-time: write 32 random bytes to master.key, chmod 600
const masterKey = randomBytes(32); // or scrypt-derived from a passphrase

function encrypt(json: string, key: Buffer) {
  const iv = randomBytes(12); // GCM standard 96-bit nonce
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, enc]); // layout: iv(12) | authTag(16) | ciphertext
}
function decrypt(blob: Buffer, key: Buffer) {
  const iv = blob.subarray(0, 12), authTag = blob.subarray(12, 28), enc = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
function mask(key: string) { // masked presence helper
  return key.length >= 8 ? `${key.slice(0,3)}…${key.slice(-4)}` : "******";
}
```

---

## D5. Resilient fan-out (Constitution III)

**Decision**: Fan out via `Promise.allSettled`; each candidate wrapped in a per-candidate timeout (default 120s); proceed to judging if ≥2 succeeded; else error.

**Rationale (user-confirmed)**: One slow/hung candidate must not sink the call; total wall-clock must stay under the client's tool-call ceiling (~4 min on Claude Desktop per [SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391)). Parallel fan-out makes wall-clock ≈ slowest survivor + 2 judge calls.

**Alternatives rejected**:
- *`Promise.all`*: one reject rejects all. Rejected.
- *Fail the whole fusion on any worker error*: brittle. Rejected.
- *Lower the ≥2 threshold*: a single source can't be "fused". Rejected.

**Implementation pattern** (`util/timeout.ts` + `fusion.ts`):

```ts
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const results = await Promise.allSettled(
  candidates.map(c => withTimeout(runWorker({...c, apiKey}), timeoutMs, `worker ${c.id}`))
);
const survivors = results.map((r, i) => r.status === "fulfilled" ? r.value : { ...failedFor(results[i], candidates[i]) })
                          .filter(s => s.status === "ok");
if (survivors.length < 2) return notEnoughSurvivorsError(results, candidates);
```

---

## D6. Transport: stdio MCP + separate Express on :9077 (Constitution VII)

**Decision**: `McpServer` + `StdioServerTransport` for the MCP leg; a separate `express` server on `127.0.0.1:9077` for the dashboard. Both in one Node process. No streamable-http.

**Rationale (research-confirmed)**: stdio only claims stdin/stdout; the HTTP port is free. stdio is the lowest-friction install for local clients (Claude Desktop, Cursor, Cline, Zed, Claude Code all launch MCP servers as stdio child processes). The fixed-port dashboard is satisfied by a vanilla HTTP server; the MCP client connectivity is satisfied by stdio. ([MCP TS SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Transports spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports))

**Alternatives rejected**:
- *streamable-http for the MCP leg*: needed only for remote/multi-tenant servers. Not our case.
- *Serving the UI through the MCP transport*: different concerns. Rejected.

**Implementation pattern** (`index.ts`):

```ts
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "openfusion", version: "1.0.0" });
registerFusionTool(server);      // logs to console.error ONLY
await server.connect(new StdioServerTransport());

const app = express();
app.use(express.json());
app.use("/api", /* ...routers... */);
app.use(express.static("ui-dist"));
app.get("*", (_req, res) => res.sendFile("ui-dist/index.html", { root: "." }));
app.listen(9077, "127.0.0.1", () => console.error("OpenFusion UI on http://localhost:9077"));
```

**Caveat (documented in spec + SKILL)**: under stdio the *client* owns the process lifecycle — the UI lives only while a client is connected. The `openfusion-ui` bin starts the dashboard independently; both share the same on-disk SQLite + config + secrets.

---

## D7. MCP SDK v1.x high-level API + Zod + progress notifications

**Decision**: Pin `@modelcontextprotocol/sdk` v1.x stable. Use the high-level `McpServer` + `server.tool(name, desc, zodSchema, handler)`. Emit `notifications/progress` best-effort.

**Rationale (research-confirmed)**: v2/main is pre-alpha; v1.x is what current clients target. The high-level API keeps tool registration concise; Zod is the schema lib it expects. Progress notifications are the right mechanism for the slow fusion flow, but client support varies (Claude Desktop/Inspector good; some Cursor/ChatGPT versions don't forward) — correctness never depends on them. ([MCP Tools](https://modelcontextprotocol.io/docs/concepts/tools), [Progress spec](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress))

**Implementation pattern** (`server/mcp-server.ts`):

```ts
import { z } from "zod";

server.tool(
  "fusion",
  "Fan a prompt out to 2-5 candidate models, run a two-step judge, return one consolidated answer. Slower/costlier than a single call — use for complex reasoning, deep research, cross-model verification.",
  { prompt: z.string(), context: z.string().optional() },
  async (args, extra) => {
    const progressToken = extra._meta?.progressToken;
    const report = async (progress: number, total: number, message: string) => {
      if (progressToken === undefined) return;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total, message },
      });
    };
    // ... gate, fan-out (report 0/N), judge step1 (report 1/N), judge step2 (report 2/N)...
    return { content: [{ type: "text", text: finalAnswer }] };
  }
);
```

**Timeout mitigation** (from SEP-1391): parallel fan-out (D5) is the primary lever; progress notifications are secondary/best-effort. The "call-now, fetch-later" job pattern is documented as a future fallback only if real-world fusions exceed the ceiling.

---

## D8. Persistence: SQLite via better-sqlite3 (Constitution V)

**Decision**: Two tables — `activities` (one row per fusion) + `sub_calls` (N+2 rows per fusion). WAL mode. Synchronous API (no async per call).

**Rationale (user-confirmed)**: Enables the rich aggregations the dashboard needs (KPIs, cost by model, fusions by day, activity-as-a-dimension) server-side rather than loading raw logs into the browser. better-sqlite3 ships prebuilt binaries for common platforms. JSONL was rejected as weaker for querying.

**Implementation pattern** (`store/db.ts`): enable `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`. DDL + aggregation queries are specified in `data-model.md` and exercised in `tests/activity.test.ts`.

---

## D9. Configuration gating + first-run browser open (Constitution VI)

**Decision**: `isConfigured()` = `candidates.length ≥ 2 && judge set && every referenced provider has a key`. The `fusion` tool refuses (returns `isError`) until configured, with a message pointing to `http://localhost:9077`. First-run opens the browser via the `open` package when a display is present; headless just returns the URL.

**Rationale (user-confirmed)**: Min 2 / max 5 candidates (2 is the minimum for any meaningful "fusion"). The `open` package is the de-facto cross-platform solution ([sindresorhus/open](https://github.com/sindresorhus/open)).

**Implementation pattern**:

```ts
import open from "open";
async function maybeOpenDashboard() {
  if (process.env.DISPLAY || process.platform === "darwin" /* has a GUI session */) {
    try { await open("http://localhost:9077"); } catch { /* ignore */ }
  }
}
```

---

## D10. Distribution: pnpm, npx-runnable, two bin entries

**Decision**: `package.json` `"type": "module"`, `bin: { "openfusion-mcp": "./dist/index.js", "openfusion-ui": "./dist/ui-only.js" }`, shebang `#!/usr/bin/env node`. Build = `tsc` → `dist/` + `cd ui && pnpm build` → `ui-dist/`. `files: ["dist", "ui-dist"]`.

**Rationale**: pnpm per AGENTS.md conventions; npx is the standard MCP install path; two bins let the dashboard run standalone (D6 caveat).

**Client install snippet** (Claude Desktop `claude_desktop_config.json`; same shape for Cursor `.cursor/mcp.json`, Cline, Zed, Claude Code):

```json
{ "mcpServers": { "openfusion": { "command": "npx", "args": ["-y", "openfusion-mcp"] } } }
```

---

## D11. Testing: Vitest + pi-ai faux providers

**Decision**: Vitest. Use pi-ai `registerFauxProvider()` to script deterministic candidate + judge responses for the fusion flow; unit-test crypto, completeness, SQLite aggregations, and the MCP tool handler (mocked `extra`).

**Rationale**: Real LLM calls are slow, costly, non-deterministic. Faux providers make the orchestration logic (fan-out survival, two-step judging, threshold, logging) fully testable. ([pi-ai README](https://www.npmjs.com/package/@earendil-works/pi-ai))

---

## Summary

All design decisions are locked and constitutionally compliant. No NEEDS CLARIFICATION items. Phase 1 (data model, contracts, quickstart) builds directly on the patterns above.
