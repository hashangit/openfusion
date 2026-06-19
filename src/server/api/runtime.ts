// GET /api/runtime — live fusion-engine status (feature 007, research R-004).
//
// DISTINCT from GET /api/status (which returns version/configured-state/health and is
// consumed by the dashboard, the agent skill, and CLI health checks). That route must
// not be touched. /api/runtime exposes the ephemeral in-memory registry the dashboard's
// Server Status widget polls (idle / in-progress / queued).
import { Router } from "express";
import { fusionStatusRegistry } from "../../fusion/status.js";

export function runtimeRouter(): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    // Always 200 — this is a read of in-memory state; an empty registry is a valid idle.
    res.json(fusionStatusRegistry.getSnapshot());
  });
  return r;
}
