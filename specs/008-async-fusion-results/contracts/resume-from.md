# Contract: `fusion` tool `_resume_from` wire protocol

**Feature**: 008-async-fusion-results | **Phase**: 1 | **Date**: 2026-06-19

This document defines the **wire shapes** the `fusion` tool returns for the deferred-result path: the kickoff result, the retrieval result, and the mode-dependent wording. It is the source of truth for `resume-shapes.ts` and for the agent-facing contract. The durable record and status machine are in [`../data-model.md`](../data-model.md); the bounded-long-poll mechanics in [`../research.md`](../research.md) R-005.

This path is taken **only for non-Tasks clients** (codex/ZCode — clients that send no `params.task`). Tasks-aware clients continue on feature 005's `CreateTaskResult` + `tasks/result` path, unchanged (FR-013).

---

## Tool input schema delta

The `fusion` tool gains one optional argument. All existing args remain optional when `_resume_from` is present (FR-002 — the agent must not resend the full prompt on every poll).

```ts
fusionInputSchema = {
  prompt:  z.string().optional(),         // was required; now optional when _resume_from is present
  context: z.string().optional(),         // unchanged
  persona: z.string().optional(),         // unchanged
  _resume_from: z.string().optional().describe(
    "Retrieve the result of a previously-started fusion. Pass the reference_id from a prior 'processing' result. When present, prompt/context/persona are ignored."
  ),
}
```

**Dispatch rule** (single site, `mcp-server.ts`):
- `_resume_from` present → **retrieval branch** (read `fusion_jobs`, bounded-long-poll or return terminal). `prompt`/`context`/`persona` ignored. No new fusion started.
- `_resume_from` absent, `params.task` present (Tasks client) → **005 Tasks branch** (unchanged).
- `_resume_from` absent, `params.task` absent (non-Tasks client) → **kickoff branch** (start detached runner, return `processing` result immediately). This replaces 005's blocking `handleAutomaticTaskPolling` fallback for the fusion tool.

**Schema note**: making `prompt` optional weakens the static guarantee that a kickoff has a prompt. The kickoff branch validates `prompt` presence at runtime and returns `{ isError: true, … }` if missing (preserving today's "prompt required" contract for new fusions).

---

## Kickoff result (non-Tasks client, `_resume_from` absent)

Returned immediately (≈1s — allocate row + dispatch; no provider work) when a non-Tasks client starts a fusion. The work runs detached. Shape is **mode-aware** (FR-005).

### Parallel mode

```json
{
  "content": [{ "type": "text", "text": "<INSTRUCTION>" }]
}
```

where `<INSTRUCTION>` (transparent pacing + retrieval mandate — **M4**: no "do not inform the user" directive, which risks tripping safety-training refusals in frontier models and kills the retrieval; instead the mandate is "call this to get the result" + an explicit `retry_after_ms`):

```
Fusion started in the background (reference_id: <ACTIVITY_ID>). It takes roughly 60-140 seconds.
Call fusion({ "_resume_from": "<ACTIVITY_ID>" }) to receive the result — retry after approximately <RETRY_AFTER_S> seconds if it is not ready yet.
```

`<RETRY_AFTER_S>` ≈ 30 (sized just under the bounded long-poll window). No `eta_ms` in the parallel message (the wait is short enough that tight-poll is the right cadence; an ETA would invite the agent to sleep instead of retrieving).

### Sequential mode

```json
{
  "content": [{ "type": "text", "text": "<INSTRUCTION>" }]
}
```

where `<INSTRUCTION>` (user-facing wording — this *is* a long job):

```
Fusion started in the background (reference_id: <ACTIVITY_ID>). This is a sequential run and will take approximately <ETA_MIN> minutes.
Live progress: http://127.0.0.1:9077/?activity=<ACTIVITY_ID>
Call fusion({ "_resume_from": "<ACTIVITY_ID>" }) later to retrieve the answer, or tell the user to watch the dashboard. Retry after approximately <RETRY_AFTER_S> seconds if it is not ready yet.
```

`<ETA_MIN>` is derived from `computeSerialBudgetMs(N)` (spec 007) converted to minutes. `<RETRY_AFTER_S>` = `max(eta_remaining/4, 60)`.

**MCP content shape + `_meta` (m10)**: both modes return a single `text` content block (matches the existing fusion tool's return shape — no structural change for clients, only timing + wording). The reference id is embedded in the text **and** carried in a structured `_meta` block on the `CallToolResult` for reliable agent parsing: `_meta: { reference_id: "<ACTIVITY_ID>", retry_after_ms: <N> }`. Belt-and-suspenders — text for humans/loose parsers, `_meta` for structured extraction (prevents silent "not found" from a misparsed id).

---

## Retrieval result (`_resume_from` present)

One of a fixed set of outcomes (FR-003). Each is a single `text` content block.

### `processing` (parallel — bounded long-poll returned without terminal)

```
Fusion <ACTIVITY_ID> is still running. Call fusion({ "_resume_from": "<ACTIVITY_ID>" }) again to receive the result — retry after approximately <RETRY_AFTER_S> seconds if it is not ready yet.
```

### `processing` (sequential — immediate, ETA-guided)

```
Fusion <ACTIVITY_ID> is still running (approximately <REMAINING_MIN> minutes remaining).
Live progress: http://127.0.0.1:9077/?activity=<ACTIVITY_ID>
Call fusion({ "_resume_from": "<ACTIVITY_ID>" }) later, or tell the user to watch the dashboard.
```

### `completed`

```
<SYNTHESIZED_ANSWER>
```

Byte-identical to what the legacy blocking path / the Tasks path would return for the same inputs (FR-015, SC-006). No wrapper, no metadata — the answer text alone, so the agent treats it exactly like any other fusion result.

### `error` (judge-failed — FR-014)

```
Fusion <ACTIVITY_ID> completed its candidates but the judge failed: <MESSAGE>.
Candidate responses are available; re-run fusion with your original query to retry, or check the dashboard.
```

Distinct from a generic fusion error so the user can tell their candidates were good. (Raw candidate access is via the activity's `sub_calls` — not inlined into the MCP result to avoid bloating the agent's context.)

### `error` (other — no-survivors / stalled / internal)

```
Fusion <ACTIVITY_ID> did not complete successfully: <MESSAGE>.
Re-run fusion with your original query, or check the dashboard.
```

### `interrupted` (post-restart — FR-009)

```
Fusion <ACTIVITY_ID> was interrupted by a server restart and did not finish.
Re-run fusion with your original query, or check the dashboard.
```

### `expired` (post-TTL — FR-008)

```
Fusion <ACTIVITY_ID> has expired (its result was not retrieved in time).
Re-run fusion with your original query.
```

### `not_found` (unknown id)

```
No fusion found for reference_id "<ID>". It may be unknown, already expired, or from a previous session.
Re-run fusion with your original query.
```

---

## Timing contract

| Call type | Max time to return |
|-----------|--------------------|
| Kickoff (any mode) | ≈1s (allocate row + dispatch; no provider work) |
| Retrieval, job already terminal | immediate |
| Retrieval, job `processing` (parallel) | `RESUME_LONG_POLL_MS` (~40 s), then `processing` |
| Retrieval, job `processing` (sequential) | immediate (ETA-guided; no long-poll) |
| Retrieval, unknown/expired id | immediate |

**Never**: a retrieval blocks for the fusion's full wall-clock (FR-004, SC-003). The bounded long-poll is the only wait, and only in parallel mode.

---

## Coexistence with feature 005 (invariants)

- A Tasks-aware client (sends `params.task`) never sees the `_resume_from` shapes — it gets `CreateTaskResult` + `tasks/result` exactly as before.
- A non-Tasks client never sees `CreateTaskResult` — it gets the kickoff/retrieval shapes above.
- Both clients' fusions write the same `fusion_jobs` row and the same `activities` + N+2 `sub_calls` rows. The synthesized answer is byte-identical (FR-015).
- The fusion tool's static description is updated to mention `_resume_from` briefly (one line) so agents discover the retrieval param from the schema, not only from the kickoff instruction.
