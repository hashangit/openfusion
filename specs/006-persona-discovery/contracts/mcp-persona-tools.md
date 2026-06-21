# Contract: MCP `list_personas` Tool

**Feature**: 006-persona-discovery | **Extends**: 004 `fusion` tool contract

The new read-only discovery tool. Lives alongside `fusion` and `open_dashboard` in `src/server/mcp-server.ts`.

---

## Tool: `list_personas`

**Purpose**: Let an MCP client enumerate available personas so it can pick a suitable one for a subsequent `fusion` call.

**Registration**: `server.tool("list_personas", <schema>, <handler>)` — a plain tool (not task-augmented; it's a sub-millisecond read, no async value).

### Input schema (Zod)

```ts
z.object({}).strict()
```

**No parameters.** The tool reads from in-memory config; it takes no input.

### Output (`CallToolResult`)

`content[0]` is a single `text` block containing a JSON-serialized array of `PersonaLite`:

```json
[
  {
    "id": "generalist",
    "name": "Generalist",
    "description": "Balanced all-rounder. Good default for most multi-perspective questions.",
    "builtin": true,
    "active": true
  },
  {
    "id": "qa",
    "name": "QA / Code Reviewer",
    "description": "Candidates critique like senior reviewers; judge consolidates a verdict with severities.",
    "builtin": true,
    "active": false
  }
]
```

- **`isError`**: always `false` (this tool does not fail under normal operation; if config is unparseable, that's a 500-class server error, not a tool error).
- **Structure**: each entry has EXACTLY these 5 keys — no `workerPrompt`, `analysisPrompt`, or `synthesisPrompt` (SC-001, test-asserted).

### `active` computation

Uses `resolvePersona({ personas: config.personas, activeId: config.settings.activePersona })`. Exactly one entry in the output has `active=true` (FR-002). If `activePersona` is unset or invalid, resolution falls back through the precedence chain (`activeId → generalist → first → builtin generalist`), still yielding exactly one `active=true`.

### Policy interaction

`list_personas` is **never gated** by `personaPolicy` (FR-016). Discovery is always allowed; enforcement happens at `fusion` time. The output always lists all personas with the active one flagged, regardless of strict/allow-override mode.

### Errors

This tool does not produce tool-level errors for "no personas" (the 4 builtins are always present). A genuinely broken config would surface as a server-level error, out of scope for this contract.

---

## `fusion` Tool: modified description (trimming + nudge)

The `fusion` tool's input schema is unchanged (`prompt`, `context?`, `persona?`). Only the **description** changes:

### Before (trimmed)

> …Optional 'persona' (e.g. 'qa', 'researcher', 'pm') tailors the worker + judge prompts to the task; defaults to the active persona in the dashboard.

### After

> …To see available personas, call `list_personas`; pass `persona=<id>` to override the active one (subject to the user's persona policy in the dashboard). Defaults to the active persona.

**Net token change**: removes the inline enumeration (3 ids + framing); adds a discovery nudge. Strictly smaller, and always accurate (no stale ids as users add customs).

### `persona` arg semantics (unchanged but now enforced)

| Caller passes | Policy | Result | `persona_source` |
|---|---|---|---|
| nothing | any | active persona runs | `active` |
| valid id/name | `allow-override` | requested runs | `override` |
| valid id/name | `strict` | active runs (+ warn, + elicit if caps) | `strict-enforced` (or `override` if user relaxes) |
| invalid id/name | any | active runs (+ warn) | `invalid-fallback` |

Resolution + enforcement happens inside `runFusion` (FR-009), shared by both the plain `server.tool('fusion')` and the task-augmented `registerToolTask('fusion')` paths from feature 005.

---

## Notification: `notifications/message` (warning)

When `persona_source` is `strict-enforced` or `invalid-fallback`, the MCP layer emits a warning notification BEFORE the fusion result returns (or before the task completes, on the task path).

### Payload

```json
{
  "method": "notifications/message",
  "params": {
    "level": "warning",
    "data": {
      "requested": "qa",
      "used": "researcher",
      "reason": "strict-enforced"
    }
  }
}
```

- `reason` ∈ `{"strict-enforced", "invalid-fallback"}`.
- `requested` is the id the client passed (`undefined`-omitted for the rare invalid-without-id case, though that path doesn't trigger a warning).
- `used` is the active persona id that actually ran.

This is best-effort signaling — the client may ignore it. The authoritative record is the `persona_source` column on the activity row.

---

## Elicitation: relax-strict prompt (when supported)

When strict-enforcement triggers AND `getClientCapabilities()?.elicitation?.form` is truthy, the MCP layer sends a `form` elicitation:

### Form

```json
{
  "method": "elicitation/create",
  "params": {
    "form": {
      "title": "OpenFusion: relax persona policy for this session?",
      "description": "An agent requested the 'qa' persona, but your persona policy is set to strict (active: 'researcher'). Allow the agent to override for the rest of this session?",
      "fields": {
        "choice": {
          "type": "string",
          "enum": ["relax", "keep-strict"],
          "default": "keep-strict"
        }
      }
    }
  }
}
```

- **Result handling**: `"relax"` → `SessionOverrideState.decision = "relax"`, the current fusion runs with the requested persona (`source="override"`). `"keep-strict"` → `decision="keep-strict"`, current + future calls this session use the active persona (`source="strict-enforced"`).
- **Concurrency**: the first caller creates `SessionOverrideState.inflight`; concurrent callers await the same promise (SC-004).
- **Failure/reject/timeout**: treated as `"keep-strict"`; `decision="keep-strict"` (no re-prompt).
- **Capability absent**: no elicitation; notification-only path (FR-005 still satisfied).

---

## Backward compatibility

- Clients that never call `list_personas`: zero behavior change. They can still pass `persona=<id>` to `fusion` as today.
- Clients that don't support `elicitation`: strict mode degrades to notification-only. `allow-override` is unaffected.
- Legacy `activities` rows (`persona_source IS NULL`): API continues to return them; UI renders the persona chip with no suffix.
