# Data Model: Async Fusion Results via Deferred Retrieval

**Feature**: 008-async-fusion-results | **Phase**: 1 | **Date**: 2026-06-19

This document defines the durable record, the status state machine, the identity invariants, and the one SQLite migration the feature adds. It is the source of truth for `resume-store.ts` and the storage layer; the wire shapes the agent sees live in [`contracts/resume-from.md`](./contracts/resume-from.md).

---

## Identity invariants (load-bearing)

- **INV-1 (single retrieval site)**: all `_resume_from` calls route through one read path in `resume-store.ts`. No alternative lookup, no per-mode branch in storage.
- **INV-2 (`reference_id = activity_id`)**: the id the agent receives in a kickoff result is the SQLite `activities.id` (a UUID). There is no separate task-id ↔ reference-id mapping for the `_resume_from` path. (R-003.) The 005 Tasks path retains its own `taskActivity` map (the SDK mints taskIds there) — two identity stories for two egress paths. **Terminology note (F9)**: "reference id" is the concept; `reference_id` is the token in instruction text; `activity_id` is the SQL column. All three are the same value — see the table above.
- **INV-3 (durable from kickoff)**: a `fusion_jobs` row exists from the moment the detached runner is dispatched, not just on completion. A retrieval between kickoff and terminal finds a `processing` row.
- **INV-4 (005 untouched)**: the Tasks egress (`createTask`/`getTask`/`getTaskResult`) is a sibling branch; `_resume_from` does not modify it.

---

## Durable record: `fusion_jobs` (new SQLite table)

One row per deferred fusion. Keyed by the activity id (FK → `activities.id`).

```sql
CREATE TABLE fusion_jobs (
  activity_id   TEXT    PRIMARY KEY,           -- = activities.id = the reference id (INV-2)
  status        TEXT    NOT NULL,              -- 'processing' | 'completed' | 'interrupted' | 'expired' | 'error'
  execution_mode TEXT   NOT NULL,              -- 'parallel' | 'sequential' (read from config snapshot at kickoff)
  result        TEXT,                          -- synthesized answer text; NULL until 'completed' (FR-007)
  result_is_error INTEGER NOT NULL DEFAULT 0,  -- 1 if 'result' is an error message (status='error'); distinguishes error-vs-answer (FR-014)
  error_kind    TEXT,                          -- 'judge-failed' | 'no-survivors' | 'stalled' | 'internal'; NULL unless status='error' (FR-014)
  created_at    TEXT    NOT NULL,              -- ISO timestamp; set at kickoff
  completed_at  TEXT,                          -- ISO timestamp; set on transition to terminal
  expires_at    TEXT    NOT NULL,              -- ISO timestamp; created_at + TTL (R-006). Extended while 'processing' (write-late guard, FR-011)
  last_progress_at TEXT,                        -- ISO timestamp; updated by the runner's progress callback. Drives the stalled circuit (FR-012)
  eta_ms        INTEGER,                       -- computed ETA in ms; NULL for parallel mode (F7 — the parallel kickoff message omits ETA by design; see contracts/resume-from.md). Sequential mode uses spec 007's computeSerialBudgetMs
  retrieved_at  TEXT,                          -- ISO timestamp of the first _resume_from that returned a terminal result; NULL until then (F3). Drives the never-retrieved counter
  FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
);
CREATE INDEX idx_fusion_jobs_status ON fusion_jobs(status);
CREATE INDEX idx_fusion_jobs_expires ON fusion_jobs(expires_at);
CREATE INDEX idx_fusion_jobs_completed ON fusion_jobs(completed_at);
```

**Terminology (F9 — standardized across artifacts)**:
- **Concept (docs/agent-facing)**: "reference id"
- **Wire field (in instruction text)**: `reference_id` (the JSON-ish token agents extract)
- **TS variable / SQL column**: `activityId` / `activity_id` (because it IS the activities.id)

All three refer to the same value. State this once here; artifacts use the form natural to their layer.

**Migration**: additive (`CREATE TABLE IF NOT EXISTS`), non-breaking. No change to `activities` or `sub_calls`. Applied at DB open in `src/store/db.ts` alongside the existing migrations. Old databases gain the table lazily; no data backfill (no prior deferred jobs exist).

**Why a dedicated table (not a column on `activities`)**: the activity row is the observability record (Constitution V) — prompt excerpts, token/cost aggregates, per-call rows. Retrieval is a distinct concern (returning the full synthesized answer to an agent, with retrieval-specific status/timing). Coupling them would force `activities` to carry retrieval state it doesn't conceptually own (R-002 bonus). The FK keeps them joinable for forensic queries.

**What is NOT stored here** (deliberately, FR-010):
- Live candidate progress (current index, remaining count). That lives in-memory in the progress map shared with spec 007's status surface. On restart it is gone; `fusion_jobs.last_progress_at` is the only progress-derived durable field (for the stalled circuit).

---

## Status state machine

```
                          ┌──────────────────────────────────────────────┐
                          │                                              ▼
  kickoff ──► processing ──► completed   (runFusion ok; result + completed_at set)
              │     │
              │     ├──► error           (runFusion returned !ok)
              │     │      ├─ error_kind='judge-failed'   (≥2 survivors, judge threw) — FR-014
              │     │      ├─ error_kind='no-survivors'   (<2 survivors; standard fusion error)
              │     │      ├─ error_kind='stalled'        (no progress > STALL_MS; surfaced by retrieval) — FR-012
              │     │      └─ error_kind='internal'        (unexpected throw in the runner)
              │     │
              │     └──► interrupted      (startup sweep: was 'processing' at restart) — FR-009, R-007
              │
              └──► expired                (TTL passed after terminal; lazy/sweep reclassify) — FR-008
```

**Transitions**:
- `processing → completed | error`: set by the detached runner's terminal handler (`markTerminal`).
- `processing → interrupted`: set by the **startup sweep** at boot (`UPDATE … WHERE status='processing' AND created_at < <boot_time>`). R-007.
- `processing → expired`: **cannot happen while processing** — the write-late guard (R-006 option b) extends `expires_at` while status is `processing`. A running job never expires.
- `completed | error | interrupted → expired`: set when `now > expires_at` (lazy on retrieval, or a background sweep). Terminal-but-aged rows are reclaimable.

**Retrieval outcomes by status** (the wire shape is in `contracts/resume-from.md`):
| Status at retrieval | Outcome |
|---------------------|---------|
| `processing` (parallel) | bounded long-poll (~40 s); return `completed` if it lands, else `processing` |
| `processing` (sequential) | immediate `processing` with refined `eta_ms` (no long-poll — ETA-guided) |
| `completed` | immediate `completed` with `result` |
| `error` (judge-failed) | `error` with message + candidate outputs available via activity join (FR-014) |
| `error` (other) | `error` with message |
| `interrupted` | `interrupted` with re-run instruction |
| `expired` | `expired` with re-run instruction |
| *(no row)* | `not_found` with re-run instruction |

---

## Ephemeral state (in-memory only, both modes)

Two maps, both die with the process (FR-010):

- **Waiters** (`Map<activityId, Array<{resolve, timer}>>`): bounded-long-poll waiters for parallel-mode retrieval. Resolved on `markTerminal` or the per-waiter timeout (R-005). Cleared on process exit.
- **Live progress** (`Map<activityId, {currentIndex, totalCount, lastUpdate}>`): the candidate-by-candidate affordance spec 007's dashboard status surface reads. Updated by the runner's `onProgress` callback. **Not** consulted by retrieval (retrieval reads `fusion_jobs` + the waiters only). On restart this map is empty; the dashboard shows idle/unknown until a new fusion starts.

The stalled circuit (FR-012) reads `fusion_jobs.last_progress_at` (durable) — not the live map — so it survives the in-memory maps being unrelated to it.

---

## Config snapshot (read, not migrated)

The kickoff captures the execution mode and the enabled-candidate count from the config snapshot the detached runner already loads (`loadConfig()` at dispatch). No new setting is added (R-002). The snapshot feeds:
- `execution_mode` → stored on the `fusion_jobs` row → drives the retrieval shape (R-004).
- candidate count → `eta_ms` (sequential uses spec 007's `computeSerialBudgetMs`; parallel uses a flat assumption, finalized in tasks).

No `config.json` migration. No `config.schema.ts` change. No `secrets.enc` change.

---

## Constants (defaults, finalized in tasks.md)

| Constant | Default | Source |
|----------|---------|--------|
| `RESUME_LONG_POLL_MS` | 40_000 | R-001 + R-005; sized under the ~60 s client ceiling with margin |
| `RESUME_TTL_MS` | 1_800_000 (30 min) | R-006; **bounds post-completion retention only** — the write-late guard (FR-011) extends `expires_at` while status is `processing`, so job *length* is uncapped (F10). 30 min is generous for sequential/benchmark jobs whose compute already finished; it bounds how long a completed answer stays retrievable after the fact. |
| `RESUME_STALL_MS` | 300_000 (5 min) | R-006 stalled circuit; no-progress threshold |

These are module-level constants (not user-configurable — Constitution VII, YAGNI). If R-001 verification surfaces a tighter or looser client ceiling, only `RESUME_LONG_POLL_MS` moves.

**Note on `eta_ms` for parallel mode (F7)**: there is no parallel ETA constant. Parallel kickoffs store `eta_ms = NULL` (the parallel kickoff message omits ETA by design — contracts/resume-from.md — because the wait is short enough that tight-polling is the right cadence and an ETA would invite the agent to sleep instead of retrieving). Only sequential mode computes an ETA, via spec 007's `computeSerialBudgetMs`.
