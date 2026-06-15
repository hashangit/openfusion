# Contract: MCP `fusion` Tool

**Interface type**: Model Context Protocol tool, exposed over stdio by the OpenFusion MCP server.

This is the primary surface an MCP client (Claude Desktop, Cursor, Cline, Zed, Claude Code) calls. The server registers exactly **two** tools: `fusion` (the core) and `open_dashboard` (convenience).

---

## Tool: `fusion`

**Purpose**: Fan a prompt out to 2–5 configured candidate models in parallel, run a two-step judge (analysis → synthesis) on the same provider/model, and return one consolidated answer.

**Behavior classification**: read-only w.r.t. the host system (no side effects outside of local usage logging). Long-running (2–3× a normal call).

### Input schema (Zod → JSON Schema on the wire)

```jsonc
{
  "type": "object",
  "required": ["prompt"],
  "additionalProperties": false,
  "properties": {
    "prompt": {
      "type": "string",
      "description": "The prompt to fuse across candidate models."
    },
    "context": {
      "type": "string",
      "description": "Optional background context, prior reasoning, or tool results the client has already gathered. Included with the prompt for each candidate. OpenFusion does not gather information itself."
    }
  }
}
```

### Output (MCP content blocks)

On success — a single text block:

```jsonc
{
  "content": [
    { "type": "text", "text": "<consolidated answer from judge step 2>" }
  ]
}
```

On a recoverable problem where the client should act (unconfigured, too few survivors, judge failure):

```jsonc
{
  "isError": true,
  "content": [
    { "type": "text", "text": "<human-readable explanation and next step>" }
  ]
}
```

### Progress notifications (best-effort)

Emitted via `notifications/progress` when the client supplied `_meta.progressToken`. Sequence (`progress`/`total`):

1. `{ progress: 0, total: 3, message: "Fanning out to N models…" }`
2. `{ progress: 1, total: 3, message: "K of N candidates responded; analyzing…" }`
3. `{ progress: 2, total: 3, message: "Analysis complete; synthesizing…" }`
4. `{ progress: 3, total: 3, message: "Done" }`

If the client did not supply a `progressToken`, no notifications are sent (no-op). Correctness never depends on progress being forwarded.

### Error contract (when `isError: true` is returned)

| Condition | Message shape | Side effect |
|-----------|---------------|-------------|
| Not configured (Constitution VI) | "OpenFusion isn't configured. Open http://localhost:9077 (or run `openfusion configure`) to set up ≥2 candidates, a judge, and API keys." | Browser opened if display present; else URL only. No activity logged. |
| `<2` survivors (Constitution III) | "Only K of N candidates succeeded (minimum 2 required). Failed: c2 (timeout), c3 (error: …). Configure more/faster candidates or raise the timeout." | Activity logged with `status=error`; failed sub_calls recorded. |
| Judge step 1 or 2 error | "Judge failed during {analysis\|synthesis}: <short reason>. K candidate responses were collected; see the dashboard." | Activity logged with `status=error`; worker sub_calls recorded. |

Unexpected internal errors throw — the MCP SDK converts a thrown handler into an MCP error response.

### Non-reentrancy / concurrency

Multiple concurrent `fusion` calls are allowed; each is independent and logs its own activity. There is no global queue or lock.

---

## Tool: `open_dashboard`

**Purpose**: Convenience tool so an agent can pop the dashboard open for the user (e.g. "set up OpenFusion").

### Input schema

```jsonc
{ "type": "object", "additionalProperties": false, "properties": {} }
```

### Output

```jsonc
{ "content": [ { "type": "text", "text": "Opened http://localhost:9077 in your browser." } ] }
```

(If headless / no display, returns: "OpenFusion dashboard: http://localhost:9077".)

---

## Out-of-band contracts (not MCP tools)

The server exposes no MCP `resources` or `prompts` in v1 — everything is a tool. Configuration + stats are exposed via the separate REST API (see [`rest-api.md`](./rest-api.md)), not via MCP.
