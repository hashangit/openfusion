# Data Model: Fusion MCP Server

**Phase 1 output.** Entities, file/DB schemas, validation rules, and state transitions. Implementation patterns are grounded in [`research.md`](./research.md).

OpenFusion has two persistence layers and one in-memory runtime entity:

1. **Config files** (`~/.openfusion/`) — user choices + secrets (filesystem, not DB).
2. **SQLite** (`~/.openfusion/openfusion.db`) — activity/usage telemetry (the dashboard's data).
3. **Runtime** — a Fusion in flight (transient; logged to SQLite on completion).

---

## E1. AppConfig  *(config.json — plaintext, no secrets)*

What the user configures via the dashboard.

| Field | Type | Rule |
|-------|------|------|
| `version` | integer | Schema version. Starts at `1`. |
| `candidates` | array<CandidateSlot> | Length **2–5** (Constitution VI). |
| `judge` | JudgeConfig | Required. |
| `settings` | Settings | Optional; falls back to defaults. |

**CandidateSlot**

| Field | Type | Rule |
|-------|------|------|
| `id` | string | Stable slot id (e.g. `"c1"`); unique within `candidates`. |
| `provider` | string | Must exist in pi-ai `getProviders()`. |
| `model` | string | Must exist in pi-ai `getModels(provider)`. |

**JudgeConfig**

| Field | Type | Rule |
|-------|------|------|
| `provider` | string | Must exist in `getProviders()`. |
| `model` | string | Must exist in `getModels(provider)`. |

**Settings**

| Field | Type | Default | Rule |
|-------|------|---------|------|
| `workerTimeoutMs` | integer | `120000` | 5_000–600_000 (5s–10min). |
| `uiPort` | integer | `9077` | Used by the standalone `openfusion-ui` bin. |
| `bind` | string | `"127.0.0.1"` | Must be loopback (Constitution IV). |

**Validation** (zod schema in `src/config/schema.ts`): `candidates.length >= 2 && <= 5`; provider/model validated against pi-ai registry at save + test time (reject unknown at config time, not at fusion time — FR-012). Atomic write (temp file → rename) with a backup.

**Referenced providers** = unique set of `provider` across `candidates[]` + `judge`. `isConfigured()` requires a stored key for **each** referenced provider (Constitution VI). One key per provider, shared across all slots that use it.

---

## E2. Secrets  *(secrets.enc — AES-256-GCM encrypted JSON)*

The decrypted in-memory shape:

| Field | Type | Rule |
|-------|------|------|
| `providers` | map<string, { apiKey: string }> | Keyed by provider id. One entry per provider the user has configured a key for. |

**At-rest format** (`secrets.enc`, binary): `iv(12 bytes) | authTag(16 bytes) | ciphertext` (AES-256-GCM — see [`research.md` D4](./research.md)). Encrypted with `~/.openfusion/master.key` (32 random bytes, `chmod 600`, generated on first run).

**Validation**: never logged; never returned unmasked by any API. The `GET /api/secrets` endpoint returns masked **presence** only: `{ providers: { openai: { present: true, hint: "sk-…aB1c" } } }` (see `mask()` in research.md D4).

---

## E3. activities  *(SQLite table — one row per fusion)*

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUID (e.g. `crypto.randomUUID()`). |
| `created_at` | TEXT | ISO-8601 timestamp; indexed. |
| `prompt_excerpt` | TEXT | First ~500 chars of `prompt` (capped for storage/display; full prompt not persisted to avoid ballooning storage and leaking sensitive content). |
| `has_context` | INTEGER | 0/1 — whether optional `context` was provided. |
| `candidate_count` | INTEGER | Configured candidate count (e.g. 3). |
| `survivor_count` | INTEGER | Candidates that succeeded. |
| `judge_provider` | TEXT | Denormalized for filtering without a join. |
| `judge_model` | TEXT | Denormalized. |
| `total_input_tokens` | INTEGER | Sum across sub_calls. |
| `total_output_tokens` | INTEGER | Sum across sub_calls. |
| `total_cost` | REAL | Sum across sub_calls (USD). |
| `total_latency_ms` | INTEGER | Wall-clock of the whole fusion. |
| `status` | TEXT | `success` \| `error` \| `partial`. |
| `error` | TEXT NULL | Short error description if `status != success`. |

**Index**: `idx_activities_created_at ON activities(created_at DESC)`.

---

## E4. sub_calls  *(SQLite table — N+2 rows per fusion)*

The "activity as a dimension" — each fusion decomposes into its constituent LLM calls.

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PRIMARY KEY | UUID. |
| `activity_id` | TEXT | FK → `activities.id`, `ON DELETE CASCADE`. |
| `created_at` | TEXT | ISO-8601. |
| `role` | TEXT | `worker` \| `judge_analysis` \| `judge_synthesis`. |
| `slot_id` | TEXT NULL | For `role=worker`: the candidate slot id. NULL for judge steps. |
| `provider` | TEXT | e.g. `openai`. |
| `model` | TEXT | e.g. `gpt-4o-mini`. |
| `input_tokens` | INTEGER | From pi-ai `usage.input` (best-effort). |
| `output_tokens` | INTEGER | From pi-ai `usage.output`. |
| `cost` | REAL | From pi-ai `usage.cost.total`. |
| `latency_ms` | INTEGER | Per-call wall-clock. |
| `status` | TEXT | `ok` \| `timeout` \| `error`. |
| `error` | TEXT NULL | Error detail on failure. |

**Indexes**: `idx_subcalls_activity ON sub_calls(activity_id)`; `idx_subcalls_model ON sub_calls(model)`.

---

## E5. Fusion  *(runtime, transient)*

The object flowing through `fusion.ts`; not persisted directly (it is decomposed into the E3/E4 rows on completion).

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Becomes `activities.id`. |
| `prompt` | string | From the tool call. |
| `context?` | string | Optional. |
| `startedAt` | number | `Date.now()`. |
| `workerResults` | array<WorkerResult> | One per candidate, in slot order. |
| `analysis` | Analysis | From judge step 1. |
| `finalAnswer` | string | From judge step 2. |
| `status` | string | Computed from workerResults + judge outcomes. |

**WorkerResult**: `{ slotId, provider, model, content?, usage?, latencyMs, status, error? }`.

**Analysis**: `{ consensus[], contradictions[], partialCoverage[], uniqueInsights[], blindSpots[] }` (the `record_analysis` tool arguments — research.md D3).

### State transition (Fusion)

```
[created]
   │
   ├── isConfigured()? NO ──► RETURN config error (never enters flow)
   │
   ▼ YES
[fan-out: Promise.allSettled(workers)]
   │
   ├── survivors < 2 ──► [failed: not-enough-survivors] ──► log (status=error) ──► RETURN error
   │
   ▼ survivors ≥ 2
[judge step 1: analysis]
   │
   ├── error ──► [failed: judge-analysis-error] ──► log (status=error) ──► RETURN error
   │
   ▼
[judge step 2: synthesis]
   │
   ├── error ──► [failed: judge-synthesis-error] ──► log (status=error) ──► RETURN error
   │
   ▼
[log: activities + N+2 sub_calls] (status = survivors<candidate_count ? "partial" : "success")
   │
   ▼
[done] ──► RETURN finalAnswer
```

**Status rules**:
- `success` — all candidates succeeded, both judge steps succeeded.
- `partial` — ≥2 but <candidate_count candidates succeeded; fusion still produced a consolidated answer. (Surfaces to the user via the dashboard.)
- `error` — <2 survivors, or either judge step failed.

---

## Dashboard aggregation queries  *(derived from E3/E4)*

Defined in `src/store/stats.ts`; all parameterizable by date range / model / status:

- **KPIs** (single row): `COUNT(*)`, `SUM(total_cost)`, `SUM(total_input_tokens + total_output_tokens)`, `AVG(total_latency_ms)`, `1.0 * SUM(status='success') / COUNT(*)`.
- **Cost by model**: `SELECT model, SUM(cost) FROM sub_calls WHERE activity_id IN (filtered) GROUP BY model`.
- **Fusions by day**: `SELECT date(created_at) AS day, COUNT(*) FROM activities WHERE ... GROUP BY day`.
- **Activity list**: `SELECT * FROM activities ORDER BY created_at DESC LIMIT ? OFFSET ?`, with `SELECT * FROM sub_calls WHERE activity_id = ?` for the expandable detail.
