# Contracts: Dashboard Runtime-Status Surface + Config Schema Delta

**Feature**: 007-sequential-processing | **Date**: 2026-06-19

Defines the two integration surfaces this feature exposes: (1) the new **`GET /api/runtime`** REST endpoint (the live fusion-engine status the dashboard polls), and (2) the **config schema delta** (`settings.executionMode`) that the Candidates page reads/writes. Entities backing these are in [data-model.md](../data-model.md); rationale in [research.md](../research.md).

> **Critical constraint**: this feature must NOT touch the existing `GET /api/status` route (`src/server/api/status.ts`), which returns version/configured-state/health and is consumed by the dashboard, the agent skill, and CLI health checks. The live-fusion surface is a distinct, additive route: `/api/runtime`.

---

## 1. `GET /api/runtime` — live fusion-engine status

A lightweight, read-only endpoint returning the current snapshot of the in-memory `FusionStatusRegistry`. Polled by the Dashboard's status widget (≥2s interval, focused-tab only — R-006).

### Request

```
GET /api/runtime
```

No query params, no body. Same-origin (`http://localhost:9077`); no auth (loopback-only per Constitution IV).

### Response — `200 OK`

```jsonc
// idle (no fusion in-flight)
{
  "state": "idle",
  "fusions": []
}

// in-progress, one fusion, PARALLEL mode
{
  "state": "in-progress",
  "fusions": [
    {
      "activityId": "a1b2c3d4-...",
      "mode": "parallel",
      "candidateCount": 5,
      "candidatesDone": 3,        // how many have responded so far
      "startedAt": 1718800000000
    }
  ]
}

// in-progress, one fusion, SEQUENTIAL mode
{
  "state": "in-progress",
  "fusions": [
    {
      "activityId": "e5f6g7h8-...",
      "mode": "sequential",
      "candidateCount": 5,
      "candidateIndex": 3,        // currently running candidate (1-indexed)
      "candidatesDone": 2,        // how many have resolved
      "startedAt": 1718800000000
    }
  ]
}

// queued (more than one fusion entered, not yet left — R-005)
{
  "state": "queued",
  "fusions": [
    { "activityId": "...", "mode": "sequential", "candidateCount": 4, "candidateIndex": 2, "candidatesDone": 1, "startedAt": ... },
    { "activityId": "...", "mode": "parallel",   "candidateCount": 3, "candidatesDone": 0, "startedAt": ... }
  ]
}
```

### Field contract

| Field | Type | Always present? | Meaning |
|---|---|---|---|
| `state` | `"idle" \| "in-progress" \| "queued"` | yes | Derived: `idle` if `fusions` empty; `queued` if `fusions.length > 1`; else `in-progress`. |
| `fusions` | `ActiveFusion[]` | yes (possibly `[]`) | One entry per fusion currently in the registry (entered, not yet left). |
| `fusions[].activityId` | string (UUID) | yes | The activity row id. Shown in the widget as a link to the activity (once it completes). |
| `fusions[].mode` | `"parallel" \| "sequential"` | yes | Drives the affordance shape (parallel: "X of Y responding"; sequential: "candidate X of Y running"). |
| `fusions[].candidateCount` | integer | yes | Total enabled candidates in this fusion. |
| `fusions[].candidateIndex` | integer (1-indexed) | **serial only** | Which candidate is currently running. Omitted in parallel mode. |
| `fusions[].candidatesDone` | integer | yes | Serial: how many candidates have resolved. Parallel: how many have responded so far. |
| `fusions[].startedAt` | integer (epoch ms) | yes | When the fusion entered the registry. Used for elapsed-time display. |

### Error / edge behavior

- **Always 200** — this is a read of in-memory state; it cannot fail in a way that warrants a non-200. If the registry is empty → `{ state: "idle", fusions: [] }`.
- **No caching headers needed** — the data is ephemeral and the client polls; a stale cache would defeat the purpose.
- **No content exposure** — the response never includes prompts, candidate text, provider keys, or model outputs. Only counts, indices, ids, and timestamps (R-004).

### Server-side wiring (`src/server/api/runtime.ts` — NEW)

```ts
// Mirrors the existing statusRouter() pattern (src/server/api/status.ts).
import { Router } from "express";
import { fusionStatusRegistry } from "../../fusion/status.js";

export function runtimeRouter(): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    res.json(fusionStatusRegistry.getSnapshot());
  });
  return r;
}
```

Mounted in `ui-server.ts`: `app.use("/api/runtime", runtimeRouter());` (alongside the existing `app.use("/api/status", statusRouter());` — both coexist).

---

## 2. Config schema delta — `settings.executionMode`

### Written by the Candidates page (toggle)

The Candidates page adds a **Sequential Mode** toggle mirroring the existing Benchmark Mode toggle. On save, it PUTs the config with `settings.executionMode` set:

```
PUT /api/config
{
  "candidates": [...],
  "judges": [...],
  "settings": {
    ...existing settings,
    "benchmarkMode": <bool>,          // existing
    "executionMode": "parallel" | "sequential"   // NEW
  }
}
```

The toggle maps to the enum: off → `"parallel"`, on → `"sequential"`. (UI presents it as a binary switch; the enum is the storage form — R-001.)

### Read for helper text

The Candidates page reads `config.settings.executionMode` (to set the toggle) **and** computes the serial budget for helper text from the enabled-candidate count, using the same formula the engine uses (R-003):

```ts
// ui side — mirrors src/fusion/fanout.ts computeSerialBudgetMs (constants duplicated for display;
// the engine's copy is authoritative; a test asserts they agree — T5/T6).
const PER_CANDIDATE_MIN = 3;
const JUDGE_STEPS_MIN = 6;
function serialBudgetMinutes(enabledCount: number): number {
  return PER_CANDIDATE_MIN * enabledCount + JUDGE_STEPS_MIN;
}
```

Helper text (shown only when the toggle is ON, or as a preview when OFF):

> **Sequential Mode** — runs candidates one at a time. Use this if you run models fully locally (Ollama/llama.cpp) and have limited VRAM; cloud-only setups should stay on Parallel.
> *With N enabled candidates, a serial fusion takes up to ~Xm (N × 3m + 6m judging).*

### Config GET — unchanged shape, one field added

`GET /api/config` now returns `settings.executionMode` alongside the existing fields. Clients that don't know the field ignore it (additive). The Zod default (`"parallel"`) means old config files without the field still parse.

---

## 3. UI affordance shapes (Dashboard widget)

The Dashboard gains a persistent **Server Status** widget (top of the page). It polls `/api/runtime` and renders according to `state`:

| `state` | Render |
|---|---|
| `idle` | "● Idle — no fusion running." (muted) |
| `in-progress` (1 fusion, parallel) | "● Running — `candidatesDone` of `candidateCount` candidates responding." (live progress) |
| `in-progress` (1 fusion, sequential) | "● Running — candidate `candidateIndex` of `candidateCount` (`candidatesDone` done)." + elapsed from `startedAt` |
| `queued` | "● Queued — `fusions.length` fusions active." + a compact list (one line per fusion, mode-aware as above) |

**Polling lifecycle (R-006)**: interval (≥2s) runs only while `document.visibilityState === "visible"`; on `visibilitychange → visible`, an immediate refetch fires so the widget never shows stale progress. Reuses the pattern from commit `1ee73d6` (feature 005's dashboard refresh-on-visibility).

**No per-candidate content** anywhere in the widget — only counts/indices/elapsed. Candidate results appear in the activity table once the fusion completes.
