// GET /api/runtime — live fusion-engine status (feature 007, research R-004).
//
// DISTINCT from GET /api/status (which returns version/configured-state/health and is
// consumed by the dashboard, the agent skill, and CLI health checks). That route must
// not be touched. /api/runtime feeds the dashboard's Server Status widget.
//
// TWO sources, merged (the in-process registry alone is insufficient — see note):
//  1. DB `activities` rows with status='running' — the cross-process floor. The DB is
//     shared across all openfusion processes (same OPENFUSION_HOME), so this route sees
//     fusions running in OTHER processes (e.g. an MCP client's spawned server), not just
//     this one. Without this, a dashboard process shows "idle" while a fusion runs next door.
//  2. In-process `FusionStatusRegistry` — same-process augmentation: carries the live
//     `mode` (parallel|sequential), `candidateIndex`, and `candidatesDone` for the rich
//     affordance. Only present for fusions running in THIS process.
//
// Merge rule: every running DB row appears; if the registry has an entry for that id, its
// richer fields override (mode/index/done). Otherwise the row yields a minimal entry with
// mode defaulted to "parallel" (executionMode isn't persisted on the activity row).
import { Router } from "express";
import { fusionStatusRegistry, type ActiveFusion } from "../../fusion/status.js";
import { getRunningActivities } from "../../store/activity.js";
import type { DB } from "../../store/db.js";

export function runtimeRouter(db: DB): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    // Always 200 — an empty result is a valid idle.
    const registryFusions = fusionStatusRegistry.getSnapshot().fusions;
    const registryById = new Map(registryFusions.map((f) => [f.activityId, f]));
    // DB is the source of truth for WHICH fusions are running (cross-process).
    const fusions: ActiveFusion[] = getRunningActivities(db).map((row) => {
      const reg = registryById.get(row.id);
      if (reg) {
        // Same process — use the registry's live mode/index/done.
        return reg;
      }
      // Other process — minimal entry. executionMode isn't persisted, so we can't know
      // parallel vs sequential here; default to parallel (the common case) and let the
      // widget render the generic "N candidates responding" affordance.
      return {
        activityId: row.id,
        mode: "parallel" as const,
        candidateCount: row.candidate_count,
        startedAt: row.startedAt,
      };
    });
    const state = fusions.length === 0 ? "idle" : fusions.length > 1 ? "queued" : "in-progress";
    res.json({ state, fusions });
  });
  return r;
}
