# OpenFusion — Release Notes
## Version 0.3.0 — 2026-06-21

---

## Highlights

### Async Fusion: no more client timeouts on long fusions
A 2–10 minute fusion no longer trips your MCP client's tool-call timeout. OpenFusion now returns immediately and lets the agent retrieve the answer when it's ready — for **both** Tasks-aware clients (Claude Code) and non-Tasks clients (codex, ZCode).

**Who it's for:** anyone running multi-model fusions through an MCP client, especially longer research/reasoning fusions and sequential local-model runs.
**Why it matters:** before 0.3.0, a fusion longer than the client's ~60s tool-call ceiling would be silently killed. Now the call returns in ~1 second and the agent retrieves the synthesized answer on its own schedule.

---

## New Features

### Deferred Retrieval via `_resume_from` (feature 008)
The `fusion` tool gained an optional `_resume_from` argument. A kickoff `fusion({prompt})` returns in ~1s with a `processing` result carrying a `reference_id`; the agent then calls `fusion({_resume_from: "<reference_id>"})` to retrieve the answer.

- **Parallel mode** (cloud models, ~60–140s): retrievals bounded-long-poll (~45s, under the ~60s codex per-call ceiling). A ~90s fusion returns in ≤3 agent round-trips.
- **Sequential mode** (local models, ~12–21min): retrievals are ETA-guided — immediate return with a refined remaining-time estimate and a dashboard link.
- The retrieved answer is byte-identical to what the blocking path would have returned.

### Async Fusion via MCP Tasks (feature 005)
For Tasks-aware clients (Claude Code), the `fusion` tool is registered with MCP Tasks (`taskSupport: 'optional'`). The client receives a `CreateTaskResult` immediately and fetches the result via `tasks/get` + `tasks/result`. Verified end-to-end: a 452-second Claude Code fusion completed successfully where the previous blocking path would have been killed.

### Persona Discovery + Policy (feature 006)
- **`list_personas` MCP tool** — agents can now enumerate available personas (including user-defined customs) and pick a suitable one before calling `fusion`. No more invisible custom personas.
- **Persona policy** — a new `config.settings.personaPolicy` (`strict` | `allow-override`, default `allow-override`) governs whether MCP clients may override the dashboard's active persona per fusion.
- **Strict mode** warns and continues (never blocks): the active persona runs, a notification fires, and (if the client supports elicitation) the user is asked once per session whether to relax.
- **New builtin persona: System Architect / Principal Engineer** (`id: "architect"`) — candidates counsel as principal engineers reading the proposed plan against the whole application. Brings the shipped set to five.

### Sequential Fan-out (feature 007)
`config.settings.executionMode: "sequential"` runs candidates one at a time in slot order — an opt-in for low-VRAM local setups (Ollama, llama.cpp) where simultaneous model loads cause OOM. A serial time budget gates launching the next candidate. Parallel remains the default.

### Durability + Recovery
- **`fusion_jobs` table** (migration `005_fusion_jobs`) — durable job-state for every deferred fusion, keyed by the activity id.
- **Startup sweep** — orphaned in-flight fusions from a previous process are marked `interrupted` at boot, so a post-restart retrieval returns a clear message instead of hanging.
- **Stalled circuit** — a hung fusion is detected and reclassified as `error/stalled` based on a per-row threshold computed from the configured worker timeout.
- **Write-late guard** — a late completion stores its result rather than being evicted by TTL. Job length is uncapped.
- **Never-retrieved counter** — when a completed answer ages out without ever being retrieved, a metric is logged (no silent abandoned compute).

---

## Improvements

- **`fusion` tool description** trimmed of inline persona enumeration and extended to mention `_resume_from`; still strictly shorter than the pre-006 description.
- **`fusion` tool `prompt` is now optional** when `_resume_from` is present, so the agent doesn't resend the full prompt on every poll.
- **`FusionResult.errorKind`** (`no-survivors` | `judge-failed` | `internal`) — structural failure kinds flow to the durable record, distinguishing judge-failure-after-candidates-complete from all-candidates-failed.
- **`persona_source` audit column** — each fusion records how the persona was chosen (`active`, `override`, `strict-enforced`, `invalid-fallback`), surfaced as a chip suffix in the Generations tab.
- **Dashboard charts** now refresh on tab focus (no more frozen snapshots).
- **Live runtime status** — a new Dashboard widget surfaces in-flight fusion progress (`GET /api/runtime`).

---

## Bug Fixes

- Fixed dashboard cost/token charts freezing at the last page-load snapshot (now re-fetch on tab focus).
- Invalid persona ids are now visible (`invalid-fallback` + warning) instead of silently falling back.
- `list_personas` no longer shadows newly shipped builtins (the `architect` persona now appears via MCP).
- Persona policy enforcement consolidated to a single site in `runFusion` (both blocking + Tasks paths enforce identically).

---

## SDK Coupling (upgrade note)

Feature 008's deferred-retrieval protocol replaces the SDK's `CallToolRequest` handler post-registration to intercept non-Tasks fusion calls before the SDK's blocking auto-poll runs. This is a deliberate, documented coupling to `@modelcontextprotocol/sdk` internals. **On SDK upgrade**, verify the handler install timing, key, and blocking-auto-poll behavior — a dispatch canary test catches shape changes at test time. See `src/fusion/resume-dispatch.ts` header.

---

## Known Issues

| Issue | Impact | Workaround | Fix ETA |
|-------|--------|------------|---------|
| Tasks-path non-durability | In-flight Tasks-path fusions lost on restart (the `_resume_from` path IS durable) | Re-run the fusion | v0.3.1 (durable task store) |
| Event-loop blocking under concurrent load | A long fusion can delay a second client's calls (better-sqlite3 is synchronous) | Tolerable for single-user; avoid concurrent heavy fusions | Revisit if multi-user |
| No cancellation wiring | A cancelled fusion runs to completion | — | v0.3.1 (`tasks/cancel`) |
| Sequential mode ≠ local-server VRAM management | OpenFusion removes its own concurrency; doesn't manage Ollama/llama.cpp VRAM | Tune `keep_alive`/offloading on the local server | Not planned |

---

## How to Update

### Self-Hosted
```bash
npm install -g openfusion-mcp@0.3.0
# or
pnpm add -g openfusion-mcp@0.3.0
```

The `fusion_jobs` migration runs automatically on first boot. No manual migration step required.

---

## Feedback

Issues and feedback: [github.com/hashangit/openfusion/issues](https://github.com/hashangit/openfusion/issues)
