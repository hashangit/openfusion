# Contract: Dashboard REST API

**Interface type**: Local HTTP (Express), `127.0.0.1` only — never bound to a public interface (Constitution IV). Same-origin; no CORS headers. Same Node process as the MCP server (see [`research.md` D6](../research.md)).

Base URL: `http://localhost:9077`. All request/response bodies are JSON (`Content-Type: application/json`). All `GET`s are idempotent and side-effect-free; `PUT`s are idempotent.

Auth: none (loopback-only). A future hardening pass could add a loopback token; out of scope for v1.

---

## Config

### `GET /api/config`
Returns the current `AppConfig` (see [`config-schema.md`](./config-schema.md)) **without** secrets.

**200** — body:
```jsonc
{
  "version": 1,
  "candidates": [{ "id": "c1", "provider": "openai", "model": "gpt-4o-mini" }],
  "judge": { "provider": "anthropic", "model": "claude-3-5-sonnet-latest" },
  "settings": { "workerTimeoutMs": 120000, "uiPort": 9077, "bind": "127.0.0.1" },
  "configured": true   // isConfigured() result, for the UI's "ready" state
}
```

### `PUT /api/config`
Replace the whole `AppConfig` (secrets untouched). Validates against the zod schema and the live pi-ai provider/model registry.

**Request body**: an `AppConfig` object (minus `version`, which the server manages).

**Responses**:
- **200** — saved; body is the normalized config (as `GET`).
- **400** — `{ "error": "VALIDATION", "detail": "...", "issues": [...] }` (e.g. <2 candidates, unknown provider).
- **409** — `{ "error": "UNKNOWN_PROVIDER_OR_MODEL", "detail": "..." }` (a chosen provider/model isn't in the pi-ai registry).

Idempotent; safe to re-PUT the same body. Atomic write (temp + rename) with a backup.

---

## Secrets

### `GET /api/secrets`
Returns **masked presence only** — never the raw keys (Constitution IV).

**200** — body:
```jsonc
{
  "providers": {
    "openai": { "present": true,  "hint": "sk-…aB1c" },
    "anthropic": { "present": false, "hint": null }
  },
  "referenced": ["openai", "anthropic"]   // providers used by current config (for the UI's completeness badge)
}
```

### `PUT /api/secrets`
Set one provider's key (encrypted before write — see [`research.md` D4](../research.md)).

**Request body**: `{ "provider": "openai", "apiKey": "sk-..." }`

**Responses**:
- **204** — stored (encrypted).
- **400** — `{ "error": "VALIDATION", "detail": "..." }` (empty key, unknown provider).

Idempotent. Deletes the provider entry if `apiKey` is `null`.

---

## Providers & models  *(passthrough to pi-ai)*

### `GET /api/providers`
**200** — `{ "providers": ["openai", "anthropic", "google", "xai", "mistral", "openrouter", ...] }` (pi-ai `getProviders()`).

### `GET /api/providers/:provider/models`
**200** — `{ "models": [{ "id": "gpt-4o-mini", "contextWindow": 128000, "reasoning": false, "cost": {...} }, ...] }` (pi-ai `getModels(provider)`).

**404** — `{ "error": "UNKNOWN_PROVIDER" }`.

---

## Test (validate before save)

### `POST /api/test`
Tiny pi-ai ping to validate a provider+model+key combination **before** the user commits it (FR-013).

**Request body**: `{ "provider": "openai", "model": "gpt-4o-mini", "apiKey": "sk-..." }`

**Responses**:
- **200** — `{ "ok": true, "latencyMs": 412, "usage": { "input": 5, "output": 3 } }` (sent a trivial prompt).
- **200** — `{ "ok": false, "error": "auth_failed", "detail": "..." }` (reachable but rejected).
- **400** — `{ "ok": false, "error": "UNKNOWN_PROVIDER_OR_MODEL", "detail": "..." }`.
- **502** — `{ "ok": false, "error": "unreachable", "detail": "..." }`.

Does not persist the key. Bounded by a short timeout (e.g. 10s).

---

## Stats  *(aggregations over E3/E4 — see [`data-model.md`](../data-model.md))*

### `GET /api/stats`
Query params (all optional): `from` (ISO date), `to` (ISO date), `model`, `status` (`success|partial|error`).

**200** — body:
```jsonc
{
  "kpis": {
    "fusionCount": 42,
    "totalCost": 1.234,
    "totalTokens": 523110,
    "avgLatencyMs": 9180,
    "successRate": 0.95
  },
  "costByModel": [{ "model": "gpt-4o-mini", "cost": 0.401 }, ...],
  "fusionsByDay": [{ "day": "2026-06-15", "count": 12 }, ...]
}
```

### `GET /api/activity`
Query params: `limit` (default 25, max 100), `offset` (default 0), plus the same filters as `/api/stats`.

**200** — body:
```jsonc
{
  "total": 42,
  "limit": 25,
  "offset": 0,
  "items": [
    {
      "id": "uuid",
      "createdAt": "2026-06-15T18:20:00.000Z",
      "promptExcerpt": "...",
      "hasContext": true,
      "candidateCount": 3,
      "survivorCount": 3,
      "judgeProvider": "anthropic",
      "judgeModel": "claude-3-5-sonnet-latest",
      "totalInputTokens": 4100,
      "totalOutputTokens": 980,
      "totalCost": 0.034,
      "totalLatencyMs": 9180,
      "status": "success",
      "error": null
    }
  ]
}
```

### `GET /api/activity/:id`
Returns one activity **plus** its sub_calls (the expandable detail — activity-as-a-dimension).

**200** — body: the activity object above with an added `subCalls` array:
```jsonc
{
  /* ...activity fields... */
  "subCalls": [
    { "role": "worker", "slotId": "c1", "provider": "openai", "model": "gpt-4o-mini", "inputTokens": 1200, "outputTokens": 310, "cost": 0.012, "latencyMs": 2100, "status": "ok" },
    /* ...one per candidate + judge_analysis + judge_synthesis... */
  ]
}
```

**404** — `{ "error": "NOT_FOUND" }`.

---

## Static UI

Any non-`/api/*` path serves the built React app from `ui-dist/`, with a SPA catch-all (`GET * → ui-dist/index.html`) so client-side routing works.

---

## Error envelope (uniform)

All non-2xx responses use: `{ "error": "<CODE>", "detail": "<human message>", "issues"?: [...] }`.
